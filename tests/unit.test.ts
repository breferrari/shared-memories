import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isJsonStream } from "../runtime/lib/hook-io.mts";
import { resolveMode } from "../runtime/lib/mode.mts";
import { ALLOWED_PATTERN, MEMORY_WRITE_PATTERN } from "../runtime/lib/naming.mts";
import { jitterMs, pushAttempts } from "../runtime/lib/push.mts";
import { canonicalState, describe as describePending, hashState, urlEncodePath } from "../runtime/lib/report.mts";
import type { Pending } from "../runtime/lib/pending.mts";

describe("mode resolution", () => {
	for (const [raw, mode] of [[undefined, "auto"], ["", "auto"], ["auto", "auto"], ["full", "full"], ["review", "review"]] as const) {
		test(`${JSON.stringify(raw)} resolves to ${mode}`, () => {
			const r = resolveMode(raw);
			assert.equal(r.mode, mode);
			assert.equal(r.unrecognised, null);
		});
	}
	test("an unrecognised value falls back to auto and is reported", () => {
		assert.deepEqual(resolveMode("banana"), { mode: "auto", unrecognised: "banana" });
	});
});

describe("the naming guardrail", () => {
	const ok = ["memories/learning_a_b.md", "memories/decision_x-y_z.md", "memories/learning_A1_b2.md"];
	const bad = [
		"memories/scratch.md",
		"memories/learning_a b.md",
		"memories/learning_a.txt",
		"memories/sub/learning_a_b.md",
		"learning_a_b.md",
		"memories/learning_.md",
	];
	for (const f of ok) test(`accepts ${f}`, () => assert.ok(ALLOWED_PATTERN.test(f)));
	for (const f of bad) test(`rejects ${f}`, () => assert.ok(!ALLOWED_PATTERN.test(f)));

	test("the write pattern anchors on .claude/memories at any depth", () => {
		assert.ok(MEMORY_WRITE_PATTERN.test("/a/b/.claude/memories/learning_a_b.md"));
		assert.ok(MEMORY_WRITE_PATTERN.test(".claude/memories/decision_a_b.md"));
		assert.ok(!MEMORY_WRITE_PATTERN.test("/a/notes/learning_a_b.md"));
	});
});

describe("the retry budget", () => {
	for (const [raw, n] of [[undefined, 12], ["", 12], ["banana", 12], ["-1", 12], ["3.5", 12], ["0", 1], ["1", 1], ["7", 7]] as const) {
		test(`${JSON.stringify(raw)} yields ${n}`, () => assert.equal(pushAttempts(raw), n));
	}
	test("jitter is bounded by the doubling schedule and the 1.5s cap", () => {
		for (let a = 1; a <= 12; a++) {
			assert.equal(jitterMs(a, () => 1), Math.round(Math.min(0.05 * 2 ** a, 1.5) * 1000));
			assert.equal(jitterMs(a, () => 0), 0);
		}
		assert.equal(jitterMs(12, () => 1), 1500, "the cap holds at the top of the schedule");
	});
});

describe("file:// encoding", () => {
	test("encodes only what breaks terminal autolinking", () => {
		assert.equal(urlEncodePath("/a b/c#d?e"), "/a%20b/c%23d%3Fe");
	});
	test("leaves other reserved characters alone", () => {
		assert.equal(urlEncodePath("/a(b)/c&d'e"), "/a(b)/c&d'e");
	});
});

const pending = (over: Partial<Pending> = {}): Pending => ({
	uncommitted: 0,
	unpushed: 0,
	untracked: [],
	numstats: [],
	deleted: [],
	...over,
});

describe("review state", () => {
	test("is stable regardless of the order files are discovered in", () => {
		const a = canonicalState(pending({ untracked: ["memories/b.md", "memories/a.md"] }), "");
		const b = canonicalState(pending({ untracked: ["memories/a.md", "memories/b.md"] }), "");
		assert.equal(hashState(a), hashState(b));
	});
	test("distinguishes a new file from a modified one", () => {
		const a = canonicalState(pending({ untracked: ["memories/a.md"] }), "");
		const b = canonicalState(pending({ numstats: [{ added: "1", deleted: "0", path: "memories/a.md" }] }), "");
		assert.notEqual(hashState(a), hashState(b));
	});
	test("ignores content, so re-editing the same file does not reprint", () => {
		assert.equal(
			canonicalState(pending({ untracked: ["memories/a.md"] }), ""),
			canonicalState(pending({ untracked: ["memories/a.md"] }), ""),
		);
	});
	test("an unpushed commit contributes only when HEAD resolves", () => {
		assert.equal(canonicalState(pending({ unpushed: 2 }), ""), "");
		assert.match(canonicalState(pending({ unpushed: 2 }), "abc123"), /^UNPUSHED\tabc123\t2$/);
	});
	test("the digest is sha256, matching `shasum -a 256`", () => {
		assert.equal(hashState(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});
});

describe("the pending description", () => {
	test("names files and commits separately", () => {
		assert.equal(describePending(2, 3), "2 pending file(s) in memories/ and 3 unpushed commit(s)");
		assert.equal(describePending(2, 0), "2 pending file(s) in memories/");
		assert.equal(describePending(0, 3), "3 unpushed commit(s)");
	});
});

describe("the jq stdin gate", () => {
	for (const s of ["", "   ", "\n", "null", "42", '"s"', "{}", "{}{}", '{"a":1} {"b":2}', "[1,2]", '{"a":"}"}']) {
		test(`accepts ${JSON.stringify(s)}`, () => assert.ok(isJsonStream(s)));
	}
	for (const s of ["not json", "{", "}", "[1,", '{"a":1} x', '"unterminated']) {
		test(`rejects ${JSON.stringify(s)}`, () => assert.ok(!isJsonStream(s)));
	}
});
