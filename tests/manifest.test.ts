import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_PATTERN } from "../runtime/lib/naming.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = readFileSync(join(REPO, "techpack.yaml"), "utf8");

/** Every `source:` the manifest names, without pulling in a YAML dependency. */
const sources = [...manifest.matchAll(/^\s*(?:source|contentFile|settingsFile|script|command|fixScript):\s*(\S+)/gm)]
	.map((m) => m[1] as string)
	.filter((v) => v.includes("/") || v.endsWith(".yaml"));

describe("techpack manifest", () => {
	test("every referenced path exists in the pack", () => {
		const missing = sources.filter((s) => !existsSync(join(REPO, s)));
		assert.deepEqual(missing, [], `manifest references files that do not exist: ${missing.join(", ")}`);
		assert.ok(sources.length >= 8, `expected the manifest to reference several files, found ${sources.length}`);
	});

	test("jq is gone and node is declared", () => {
		assert.doesNotMatch(manifest, /brew: jq/, "the pack no longer shells out to jq");
		assert.match(manifest, /brew: node/, "the pack now depends on Node");
	});

	test("the runtime ships as one generic directory copy", () => {
		assert.match(manifest, /fileType: generic/);
		assert.match(manifest, /source: runtime\n\s*destination: shared-memories/);
	});
});

describe("hook install contract", () => {
	const shims = readdirSync(join(REPO, "hooks"));

	test("every hook destination is a .sh file", () => {
		const dests = [...manifest.matchAll(/destination:\s*(\S+\.sh)/g)].map((m) => m[1]);
		assert.equal(dests.length, 3, "expected three registered hooks");
		// mcs runs hooks as `bash <path>`, so a non-bash hook file would never execute.
		for (const d of dests) assert.ok(shims.includes(d as string), `${d} is registered but not shipped`);
	});

	test("every shim parses as bash", () => {
		for (const f of shims) {
			const r = spawnSync("bash", ["-n", join(REPO, "hooks", f)], { encoding: "utf8" });
			assert.equal(r.status, 0, `${f} is not valid bash: ${r.stderr}`);
		}
	});

	test("every shim execs a runtime entry that exists", () => {
		for (const f of shims) {
			const body = readFileSync(join(REPO, "hooks", f), "utf8");
			const m = /shared-memories\/(hooks\/\w+\.ts)/.exec(body);
			assert.ok(m, `${f} does not exec a runtime entry`);
			assert.ok(existsSync(join(REPO, "runtime", m[1] as string)), `${f} points at a missing ${m[1]}`);
		}
	});

	test("every shim keeps the missing-interpreter path fail-open", () => {
		for (const f of shims) {
			const body = readFileSync(join(REPO, "hooks", f), "utf8");
			assert.match(body, /command -v node .*\|\| \{.*exit 0; \}/s, `${f} would exit non-zero without node`);
		}
	});

	test("every runtime entry parses under type stripping", () => {
		for (const f of readdirSync(join(REPO, "runtime", "hooks"))) {
			execFileSync(process.execPath, ["--experimental-strip-types", "--check", join(REPO, "runtime", "hooks", f)]);
		}
	});
});

describe("the naming rule has one definition", () => {
	test("the slash command documents the pattern the code enforces", () => {
		const cmd = readFileSync(join(REPO, "commands", "approve-memories.md"), "utf8");
		const m = /\^memories\/\(learning\|decision\)_\[a-zA-Z0-9_-\]\+\\\.md\$/.exec(cmd);
		assert.ok(m, "approve-memories.md no longer documents the guardrail pattern");
		assert.equal(ALLOWED_PATTERN.source, "^memories\\/(learning|decision)_[a-zA-Z0-9_-]+\\.md$");
	});

	test("no stale keep-in-sync comments survive in the TypeScript", () => {
		for (const dir of ["runtime/lib", "runtime/hooks", "scripts"]) {
			for (const f of readdirSync(join(REPO, dir))) {
				const body = readFileSync(join(REPO, dir, f), "utf8");
				assert.doesNotMatch(body, /keep in sync/i, `${dir}/${f} still points at a second copy`);
			}
		}
	});
});
