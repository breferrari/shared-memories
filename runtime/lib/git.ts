import { spawnSync } from "node:child_process";

export type GitRun = { readonly ok: boolean; readonly stdout: string; readonly stderr: string; readonly code: number };

export type GitOpts = {
	readonly env?: Readonly<Record<string, string>>;
	/** For calls the bash leaves unredirected, so git's own progress still reaches the user. */
	readonly inheritStderr?: boolean;
};

export function git(cwd: string, args: readonly string[], opts: GitOpts = {}): GitRun {
	const r = spawnSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", opts.inheritStderr === true ? "inherit" : "pipe"],
		env: opts.env ? { ...process.env, ...opts.env } : process.env,
	});
	return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? -1 };
}

/** stdout trimmed, or "" on any failure — the `$(... || true)` shape. */
export function gitOut(cwd: string, args: readonly string[]): string {
	return git(cwd, args).stdout.trim();
}

export function gitLines(cwd: string, args: readonly string[]): string[] {
	return git(cwd, args)
		.stdout.split("\n")
		.filter((l) => l !== "");
}

export function isWorkTree(dir: string): boolean {
	return git(dir, ["rev-parse", "--is-inside-work-tree"]).ok;
}

export function hasUpstream(dir: string): boolean {
	return git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).ok;
}

export function unpushedCount(dir: string): number {
	if (!hasUpstream(dir)) return 0;
	const out = gitOut(dir, ["rev-list", "@{u}..HEAD", "--count"]);
	const n = Number.parseInt(out, 10);
	return Number.isNaN(n) ? 0 : n;
}

export function gitPresent(): boolean {
	return spawnSync("git", ["--version"], { stdio: "ignore" }).error === undefined;
}
