import { gitLines, gitOut, unpushedCount } from "./git.ts";
import { ALLOWED_PATTERN } from "./naming.ts";

export type NumStat = { readonly added: string; readonly deleted: string; readonly path: string };

export type Pending = {
	readonly uncommitted: number;
	readonly unpushed: number;
	readonly untracked: string[];
	readonly numstats: NumStat[];
	readonly addedModified: string[];
	readonly deleted: string[];
};

export function uncommittedCount(repo: string): number {
	return gitLines(repo, ["status", "--porcelain", "--", "memories/"]).length;
}

export function collect(repo: string, uncommitted: number, unpushed: number): Pending {
	if (uncommitted === 0) {
		return { uncommitted, unpushed, untracked: [], numstats: [], addedModified: [], deleted: [] };
	}
	const untracked = gitLines(repo, ["ls-files", "--others", "--exclude-standard", "--full-name", "--", "memories/"]);
	const numstats = gitLines(repo, ["diff", "--numstat", "--diff-filter=AM", "HEAD", "--", "memories/"])
		.map((l) => l.split("\t"))
		.filter((p): p is [string, string, string] => p.length >= 3 && p[2] !== undefined)
		.map(([added, deleted, path]) => ({ added, deleted, path }));
	return {
		uncommitted,
		unpushed,
		untracked,
		numstats,
		addedModified: numstats.map((n) => n.path),
		deleted: gitLines(repo, ["diff", "--name-only", "--diff-filter=D", "HEAD", "--", "memories/"]),
	};
}

/** `{ diff --name-only HEAD ; untracked } | sort -u`, then the guardrail. */
export function badNames(repo: string, untracked: readonly string[]): string[] {
	const tracked = gitLines(repo, ["diff", "--name-only", "HEAD", "--", "memories/"]);
	const dirty = [...new Set([...tracked, ...untracked])].filter((f) => f !== "").sort();
	return dirty.filter((f) => !ALLOWED_PATTERN.test(f));
}

export function recountUnpushed(repo: string): number {
	return unpushedCount(repo);
}

export function headSha(repo: string): string {
	return gitOut(repo, ["rev-parse", "HEAD"]);
}
