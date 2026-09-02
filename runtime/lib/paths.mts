import { resolve } from "node:path";

/** Entries live at <project>/.claude/shared-memories/hooks/, three levels down. */
export function projectRoot(hookDir: string): string {
	return resolve(hookDir, "..", "..", "..");
}

export function memoriesRepo(project: string): string {
	return resolve(project, ".claude", ".memories-repo");
}
