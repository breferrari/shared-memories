export type Mode = "auto" | "full" | "review";

export type ModeResult = { readonly mode: Mode; readonly unknown: string | null };

export function resolveMode(raw: string | undefined): ModeResult {
	switch (raw) {
		case undefined:
		case "":
		case "auto":
			return { mode: "auto", unknown: null };
		case "full":
			return { mode: "full", unknown: null };
		case "review":
			return { mode: "review", unknown: null };
		default:
			return { mode: "auto", unknown: raw };
	}
}
