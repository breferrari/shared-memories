import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_PATTERN } from "../runtime/lib/naming.mts";

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

	test("the library ships beside the hooks it is imported from", () => {
		assert.match(manifest, /fileType: generic/);
		assert.match(manifest, /source: runtime\/lib\n\s*destination: hooks\/shared-memories\/lib/);
	});

	test("the library destination tracks the pack identifier", () => {
		// Hooks are namespaced into <pack-id>/, and the generic copy has to land in
		// the same directory. Renaming the pack without this line breaks the imports.
		const id = /^identifier:\s*(\S+)/m.exec(manifest)?.[1];
		assert.ok(id, "the manifest declares no identifier");
		assert.match(manifest, new RegExp(`destination: hooks/${id}/lib`));
	});
});

describe("hook install contract", () => {
	const dests = [...manifest.matchAll(/destination:\s*(\S+\.mts)/g)].map((m) => m[1] as string);

	test("three hooks are registered, all TypeScript", () => {
		assert.equal(dests.length, 3, "expected three registered hook entry points");
		for (const d of dests) assert.ok(existsSync(join(REPO, "runtime", d)), `${d} is registered but not shipped`);
	});

	test("no shell survives anywhere in the pack", () => {
		const stray = readdirSync(REPO, { recursive: true, encoding: "utf8" }).filter(
			(f) => f.endsWith(".sh") && !f.startsWith("node_modules"),
		);
		assert.deepEqual(stray, [], `shell scripts are not permitted: ${stray.join(", ")}`);
	});

	test("every entry point carries the shebang mcs executes it by", () => {
		for (const d of dests) {
			const first = readFileSync(join(REPO, "runtime", d), "utf8").split("\n")[0];
			assert.equal(
				first,
				"#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning",
				`${d} has no usable shebang`,
			);
		}
	});

	test("every entry point is executable", () => {
		for (const d of dests) {
			// mcs chmods on install, but a non-executable file in the repo is a smell.
			assert.ok(statSync(join(REPO, "runtime", d)).mode & 0o111, `${d} is not executable`);
		}
	});

	test("every entry point imports its library as a sibling", () => {
		// `./lib/...` has to resolve both in the pack checkout and once installed.
		for (const d of dests) {
			const body = readFileSync(join(REPO, "runtime", d), "utf8");
			assert.doesNotMatch(body, /from "\.\.\//, `${d} reaches outside its own directory`);
			assert.match(body, /from "\.\/lib\//, `${d} does not import the shared library`);
		}
	});

	test("every entry point parses under type stripping", () => {
		for (const d of dests) {
			execFileSync(process.execPath, ["--experimental-strip-types", "--check", join(REPO, "runtime", d)]);
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
		for (const dir of ["runtime", "runtime/lib", "scripts"]) {
			for (const f of readdirSync(join(REPO, dir)).filter((n) => n.endsWith(".ts") || n.endsWith(".mts"))) {
				const body = readFileSync(join(REPO, dir, f), "utf8");
				assert.doesNotMatch(body, /keep in sync/i, `${dir}/${f} still points at a second copy`);
			}
		}
	});
});
