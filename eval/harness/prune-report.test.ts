// Tests: live pruning accuracy report built from context_edit verdicts
// (eval/fixtures/mini-edited.jsonl is the governed session).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPruneReport,
  buildPruneSession,
  distinctiveTokens,
  pruneReportJson,
  pruneReportMarkdown,
} from "./prune-report.ts";
import { parseSession } from "./session.ts";

const MINI = new URL("../fixtures/mini.jsonl", import.meta.url).pathname;
const MINI_EDITED = new URL("../fixtures/mini-edited.jsonl", import.meta.url)
  .pathname;

test("distinctiveTokens: longest-first, deduped, deterministic tie-break", () => {
  const tokens = distinctiveTokens(
    "results about results hopper jobs details-hopper x9",
  );
  assert.deepEqual(tokens, ["details-hopper", "results", "hopper"]);
  // pure function: same input, same output, stable across calls
  assert.deepEqual(distinctiveTokens("results about results hopper"), [
    "results",
    "hopper",
  ]);
});

test("an ungoverned session produces no prune report (null)", () => {
  assert.equal(buildPruneSession("mini", parseSession(MINI)), null);
});

test("pruned pairs are the omitted tool results; the tavily pair is a proxy false prune", () => {
  const r = buildPruneSession("mini-edited", parseSession(MINI_EDITED));
  assert.notEqual(r, null);
  // latest edit per target: e6 omitted (tavily tc2), e7 omitted (bash tc3);
  // e3 and e5 are content replacements, not prunes
  assert.equal(r?.prunedPairs, 2);
  assert.equal(r?.replacedEntries, 2);
  assert.equal(r?.editEntries, 5);
  const e6 = r?.pruned.find((p) => p.targetId === "e6");
  // later user message "summarize the hopper results" references the pruned output
  assert.equal(e6?.laterReferenced, true);
  assert.deepEqual(e6?.referencedBy, ["e8"]);
  assert.equal(e6?.toolName, "tavily_search");
  assert.equal(e6?.reCalledLater, false); // tavily never called again
});

test("a pruned result whose tool is called again later is flagged re-called, not false-pruned", () => {
  const r = buildPruneSession("mini-edited", parseSession(MINI_EDITED));
  const e7 = r?.pruned.find((p) => p.targetId === "e7");
  assert.equal(e7?.reCalledLater, true); // bash tc4 comes later
  assert.equal(e7?.laterReferenced, false); // "ok" carries no distinctive tokens
});

test("kept closed-epoch pairs: never-referenced counted as proxy missed savings", () => {
  const r = buildPruneSession("mini-edited", parseSession(MINI_EDITED));
  // kept = tc5 (grep, untouched by any edit) in closed epoch 1. tc1 is NOT kept:
  // its result entry was replaced (already governed), so it is excluded rather than
  // counted as a missed saving. tc4's epoch is the last epoch, never a candidate.
  // Nothing references tc5's output later -> one proxy missed saving.
  assert.equal(r?.keptClosedPairs, 1);
  assert.equal(r?.keptNeverReferenced, 1);
});

test("aggregate rolls up per-session metrics; ungoverned sessions land in skipped", () => {
  const doc = buildPruneReport("test", [
    { proj: "mini-edited", session: parseSession(MINI_EDITED) },
    { proj: "mini", session: parseSession(MINI) },
  ]);
  assert.equal(doc.aggregate.governedSessions, 1);
  assert.equal(doc.aggregate.skippedSessions, 1);
  assert.equal(doc.aggregate.prunedPairs, 2);
  assert.equal(doc.aggregate.laterReferencedPruned, 1);
  assert.equal(doc.aggregate.reCalledPruned, 1);
  assert.deepEqual(
    doc.skipped.map((s) => s.proj),
    ["mini"],
  );
});

test("two prune-report builds are byte-identical (fixture-mode determinism)", () => {
  const build = () =>
    buildPruneReport("test", [
      { proj: "mini-edited", session: parseSession(MINI_EDITED) },
      { proj: "mini", session: parseSession(MINI) },
    ]);
  const a = build();
  const b = build();
  assert.equal(pruneReportJson(a), pruneReportJson(b));
  assert.equal(pruneReportMarkdown(a), pruneReportMarkdown(b));
  // the proxy is named in the report, not just in code
  assert.ok(pruneReportMarkdown(a).includes("BOUNDS, it does not measure"));
});
