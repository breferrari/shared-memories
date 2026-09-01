import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

export type HookName = "pull" | "autopush" | "announce";

const HOOK_FILE: Record<HookName, string> = {
	pull: "memories_pull.sh",
	autopush: "memories_autopush.sh",
	announce: "memories_announce.sh",
};

const EVENT: Record<HookName, string> = {
	pull: "SessionStart",
	autopush: "Stop",
	announce: "PostToolUse",
};

const GOLDEN_DIR = join(REPO, "tests", "golden");
const slug = (name: string): string => name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();

/**
 * Goldens outlive the run that recorded them, so anything that varies by
 * machine, day or temp path is replaced by a placeholder. Everything else
 * stays byte-exact.
 */
export function normalizeRun(r: RunResult, root: string): RunResult {
	const host = hostname().split(".")[0] ?? "";
	const scrub = (t: string): string =>
		t
			.split(root)
			.join("<TMP>")
			.replace(/\.memories-migration-\d{8}-\d{6}/g, ".memories-migration-<TS>")
			.replace(/\(last modified [^)]*\)/g, "(last modified <REL>)")
			.replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>")
			.split(host)
			.join("<HOST>");
	return { stdout: scrub(r.stdout), stderr: scrub(r.stderr), code: r.code, git: scrub(r.git) };
}

export function readGolden(name: string): RunResult | null {
	try {
		return JSON.parse(readFileSync(join(GOLDEN_DIR, `${slug(name)}.json`), "utf8")) as RunResult;
	} catch {
		return null;
	}
}

export function writeGolden(name: string, r: RunResult): void {
	mkdirSync(GOLDEN_DIR, { recursive: true });
	writeFileSync(join(GOLDEN_DIR, `${slug(name)}.json`), `${JSON.stringify(r, null, 2)}\n`);
}

export type RunResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
	readonly git: string;
};

export type Fixture = {
	readonly name: string;
	readonly hook: HookName;
	readonly env?: Readonly<Record<string, string>>;
	readonly stdin?: string;
	/** Mutates the memories checkout to produce the pending state under test. */
	readonly setup?: (repo: string, project: string) => void;
	/** Runs before each implementation, after the tree is restored. */
	readonly beforeEach?: (repo: string, project: string) => void;
	/** Number of back-to-back invocations; the last one is compared. */
	readonly runs?: number;
	/** Mutates state between invocations, so a reprint-on-change can be exercised. */
	readonly betweenRuns?: (repo: string, project: string) => void;
	/** Non-vacuity: the bash side must actually produce this, or the fixture proves nothing. */
	readonly expect?: RegExp;
};

/**
 * Fixture commits are stamped at a fixed past date. `%cr` renders relative to
 * NOW, so commits made "just now" render as "0 seconds ago" for one run and
 * "1 second ago" for the other — an intermittent diff with no defect behind it.
 */
const FIXTURE_DATE = "2026-01-15T12:00:00+00:00";

export const git = (cwd: string, ...args: string[]): string => {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, GIT_AUTHOR_DATE: FIXTURE_DATE, GIT_COMMITTER_DATE: FIXTURE_DATE },
		}).trim();
	} catch {
		return "";
	}
};

/** A remote that rejects every push with exit 1, so the retry budget is actually spent. */
export function rejectAllPushes(remote: string): void {
	const hook = join(remote, "hooks", "pre-receive");
	writeFileSync(hook, "#!/bin/sh\nexit 1\n");
	chmodSync(hook, 0o755);
}

export const memory = (repo: string, name: string, body = "A shared lesson.\n"): string => {
	const path = join(repo, "memories", name);
	writeFileSync(path, body);
	return path;
};

/** A bare remote plus a checkout with one committed memory, tracking origin. */
export function makeProject(): { root: string; work: string; project: string; repo: string; remote: string } {
	const root = mkdtempSync(join(tmpdir(), "sm-"));
	const work = join(root, "work");
	mkdirSync(work, { recursive: true });
	const remote = join(work, "remote.git");
	const project = join(work, "project");
	const repo = join(project, ".claude", ".memories-repo");

	execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
	mkdirSync(join(repo, "memories"), { recursive: true });
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@example.com");
	git(repo, "config", "user.name", "Test");
	git(repo, "remote", "add", "origin", remote);
	memory(repo, "learning_seed_topic.md", "Seed memory.\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "seed");
	git(repo, "push", "-q", "-u", "origin", "main");

	mkdirSync(join(project, ".claude", "hooks", "shared-memories"), { recursive: true });
	execFileSync("ln", ["-sfn", ".memories-repo/memories", join(project, ".claude", "memories")]);
	return { root, work, project, repo, remote };
}

function install(project: string, hook: HookName): void {
	const hooks = join(project, ".claude", "hooks", "shared-memories");
	mkdirSync(hooks, { recursive: true });
	rmSync(join(project, ".claude", "shared-memories"), { recursive: true, force: true });
	cpSync(join(REPO, "hooks", HOOK_FILE[hook]), join(hooks, HOOK_FILE[hook]));
	cpSync(join(REPO, "runtime"), join(project, ".claude", "shared-memories"), { recursive: true });
}

/** Invoked exactly as mcs registers it: `bash <relative path>`, cwd at the project root. */
function invoke(project: string, hook: HookName, fx: Fixture): Omit<RunResult, "git"> {
	const payload = fx.stdin ?? JSON.stringify({ hook_event_name: EVENT[hook], session_id: "s1", cwd: project });
	const r = spawnSync("bash", [`.claude/hooks/shared-memories/${HOOK_FILE[hook]}`], {
		cwd: project,
		input: payload,
		encoding: "utf8",
		timeout: 180_000,
		env: { ...process.env, ...fx.env },
	});
	return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

export function gitState(repo: string, project: string): string {
	const upstream = git(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
	return [
		// Repo-wide, deliberately: a snapshot scoped to memories/ is blind to the
		// root-level damage the `-- memories/` pathspec exists to prevent.
		`status-all: ${git(repo, "status", "--porcelain").split("\n").filter(Boolean).sort().join(" | ")}`,
		`log-all: ${git(repo, "log", "--format=%s").split("\n").filter(Boolean).join(" | ")}`,
		`tracked-all: ${git(repo, "ls-files").split("\n").filter(Boolean).sort().join(" | ")}`,
		`status: ${git(repo, "status", "--porcelain", "--", "memories/").split("\n").filter(Boolean).sort().join(" | ")}`,
		`log: ${git(repo, "log", "--format=%s", "--", "memories/").split("\n").filter(Boolean).join(" | ")}`,
		`upstream: ${upstream || "(none)"}`,
		`unpushed: ${upstream ? git(repo, "rev-list", "@{u}..HEAD", "--count") : "0"}`,
		`tracked: ${git(repo, "ls-files", "--", "memories/").split("\n").filter(Boolean).sort().join(" | ")}`,
		`review-shown: ${existsSync(join(repo, ".review-shown")) ? "present" : "absent"}`,
		`worktree: ${execFileSync("bash", ["-c", `ls -A "${repo}/memories" 2>/dev/null | sort | tr '\\n' ' '`], { encoding: "utf8" }).trim()}`,
	].join("\n");
}

/**
 * Both implementations run in the SAME directory, sequentially, restoring the
 * tree in between. Two parallel clones would differ in absolute path (which
 * reaches stdout through `file://` URLs) and in commit timestamps (which reach
 * it through `%cr`), so a diff between them could not distinguish a real
 * deviation from fixture noise.
 */
export function runHook(fx: Fixture): RunResult {
	const { root, work, project, repo } = makeProject();
	try {
		fx.setup?.(repo, project);
		const pristine = join(root, "pristine");
		cpSync(work, pristine, { recursive: true, verbatimSymlinks: true });
		rmSync(work, { recursive: true, force: true });
		cpSync(pristine, work, { recursive: true, verbatimSymlinks: true });

		install(project, fx.hook);
		fx.beforeEach?.(repo, project);
		let last = invoke(project, fx.hook, fx);
		for (let i = 1; i < (fx.runs ?? 1); i++) {
			fx.betweenRuns?.(repo, project);
			last = invoke(project, fx.hook, fx);
		}
		return normalizeRun({ ...last, git: gitState(repo, project) }, root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

export type ScriptName = "doctor-memories" | "doctor-memories-remote";

export type ScriptFixture = {
	readonly name: string;
	readonly script: ScriptName;
	readonly setup?: (repo: string, project: string) => void;
	readonly expectCode?: number;
};

/**
 * Pack scripts are executed by mcs directly (ScriptRunner passes no arguments and
 * chmods first), so the shebang is what selects the interpreter — unlike hooks,
 * which mcs always runs through bash.
 */
export function runScript(fx: ScriptFixture): RunResult {
	const { root, project, repo } = makeProject();
	try {
		fx.setup?.(repo, project);
		const r = spawnSync(join(REPO, "scripts", `${fx.script}.ts`), [], {
			encoding: "utf8",
			timeout: 180_000,
			env: { ...process.env, MCS_PROJECT_PATH: project },
		});
		return normalizeRun(
			{ stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1, git: gitState(repo, project) },
			root,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

export type ConfigureFixture = {
	readonly name: string;
	/** Seeds the bare remote through a scratch clone before the project is shaped. */
	readonly seed?: (clone: string) => void;
	/** Shapes <project>/.claude before configure runs. */
	readonly pre?: (project: string, claude: string) => void;
	readonly env?: Readonly<Record<string, string>>;
	readonly expectCode?: number;
	readonly expect?: RegExp;
	/** Seed a remote whose branch carries no memories/ tree at all. */
	readonly emptyRemote?: boolean;
	/** Pass MCS_PROJECT_PATH with a trailing slash; bash concatenates, join() would normalise. */
	readonly trailingSlash?: boolean;
	/** Skipped when running as root, where the fixture's premise does not hold. */
	readonly skipAsRoot?: boolean;
};

/** The migration backup embeds a HH:MM:SS stamp, so the two runs cannot share it. */
export function runConfigure(fx: ConfigureFixture): RunResult {
	const root = mkdtempSync(join(tmpdir(), "sm-cfg-"));
	try {
		const work = join(root, "work");
		mkdirSync(work, { recursive: true });
		const remote = join(work, "remote.git");
		const project = join(work, "project");
		const claude = join(project, ".claude");

		execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
		const scratch = join(work, "scratch");
		git(work, "clone", "-q", remote, scratch);
		git(scratch, "config", "user.email", "t@example.com");
		git(scratch, "config", "user.name", "Test");
		if (fx.emptyRemote === true) {
			writeFileSync(join(scratch, "README.md"), "no memories dir\n");
		} else {
			mkdirSync(join(scratch, "memories"), { recursive: true });
			writeFileSync(join(scratch, "memories", "learning_shared_seed.md"), "Shared seed.\n");
		}
		git(scratch, "add", "-A");
		git(scratch, "commit", "-qm", "seed");
		git(scratch, "push", "-q", "-u", "origin", "main");
		fx.seed?.(scratch);
		rmSync(scratch, { recursive: true, force: true });

		mkdirSync(claude, { recursive: true });
		fx.pre?.(project, claude);

		const r = spawnSync(join(REPO, "scripts", "configure-memories.ts"), [], {
			encoding: "utf8",
			timeout: 180_000,
			env: {
				...process.env,
				MCS_PROJECT_PATH: fx.trailingSlash === true ? `${project}/` : project,
				MCS_RESOLVED_MEMORIES_REPO_URL: remote,
				MCS_RESOLVED_MEMORIES_BRANCH: "main",
				...fx.env,
			},
		});
		const listing = execFileSync(
			"bash",
			["-c", `ls -A "${claude}" 2>/dev/null | sort | tr '\\n' ' '; echo; ls -A "${claude}/memories/" 2>/dev/null | sort | tr '\\n' ' '`],
			{ encoding: "utf8" },
		);
		return normalizeRun(
			{ stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1, git: listing.trim() },
			root,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
