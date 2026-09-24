// Tests: counterfactual replay arms over the synthetic mini-session, plus determinism of
// the full pipeline (two runs -> byte-identical reports).

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCatalog } from "./catalog.ts";
import type { ThresholdPolicy } from "./policy.ts";
import { buildReport, reportJson, reportMarkdown } from "./report.ts";
import { parseSession } from "./session.ts";
import { simulate } from "./simulate.ts";

const MINI = new URL("../fixtures/mini.jsonl", import.meta.url).pathname;
const MINI_EDITED = new URL("../fixtures/mini-edited.jsonl", import.meta.url)
  .pathname;
const policy: ThresholdPolicy = { load: 0.6, top_k: 3, decay: 0.25 };
const catalog = loadCatalog();

const MINI_SCORES: Record<string, number> = {
  spec: 0.9,
  "heavy-think": 0.7,
  "browser-use": 0.65,
  "landing-page": 0.55,
};
const scoreOf = (name: string): number => MINI_SCORES[name] ?? 0.1;

async function runMini(overrides?: {
  skillsAvailable?: boolean;
  scores?: Record<string, number>;
}) {
  const scores = {
    ...Object.fromEntries(
      Object.keys(catalog.skills).map((k) => [k, scoreOf(k)]),
    ),
    ...overrides?.scores,
  };
  return simulate(parseSession(MINI), {
    proj: "mini",
    catalog,
    policy,
    scores: async () => scores,
    skillsAvailable: overrides?.skillsAvailable ?? true,
  });
}

test("routed arm injects only the top-3 skills above threshold", async () => {
  const r = await runMini();
  assert.deepEqual(r.loadedSkills, ["browser-use", "heavy-think", "spec"]);
  const allBytes = Object.values(catalog.skills).reduce((a, b) => a + b, 0);
  const threeBytes = ["spec", "heavy-think", "browser-use"].reduce(
    (a, n) => a + catalog.skills[n],
    0,
  );
  assert.equal(r.baseline.skillsBytes, allBytes * 3 /* epochs x 1 call */);
  assert.equal(r.routed.skillsBytes, threeBytes * 3);
});

test("top-K cap holds: a fourth skill above threshold loses its slot to higher scores", async () => {
  const r = await runMini({ scores: { "landing-page": 0.8 } });
  assert.equal(r.loadedSkills.length, 3);
  // ranked: spec 0.9, landing-page 0.8, heavy-think 0.7 — browser-use (0.65) is crowded out
  assert.deepEqual(r.loadedSkills, ["heavy-think", "landing-page", "spec"]);
});

test("baseline tool schemas include every namespace; routed includes only active ones", async () => {
  const r = await runMini();
  assert.ok(r.baseline.toolsBytes > r.routed.toolsBytes);
  // epoch 1: tavily not yet active (miss); epoch 2: tavily sticky-active though unused
  assert.equal(r.namespaceMisses, 1);
  assert.ok(r.activeNamespacesEver.includes("tavily"));
});

test("prune arm removes exactly the non-recurring tool pair at the boundary", async () => {
  const r = await runMini();
  assert.equal(r.prunedPairs, 1); // tc2 tavily_search, never called again
  assert.equal(r.routed.historyBytes > r.pruned.historyBytes, true);
  // the pruned bytes are exactly the tc2 result message bytes, applied from epoch 2 on (1 call)
  assert.ok(r.prunedTokens > 0);
  assert.equal(r.falsePrune, 0); // recurrence proxy cannot false-prune
});

test("regression: fixture-mode falseKeep is 0 — kept pairs recurred by definition", async () => {
  const r = await runMini();
  // tc1/tc3 are kept because bash recurs; a keep verdict on a recurring tool is not a
  // missed saving. The old implementation counted every keep verdict (printed 1349 on
  // the committed golden report); the guarded count must be identically zero here.
  assert.equal(r.falseKeep, 0);
});

test("a live verdict that keeps a never-recurring pair counts as falseKeep", async () => {
  const r = await simulate(parseSession(MINI), {
    proj: "mini",
    catalog,
    policy,
    scores: async () => ({ spec: 0.9 }),
    skillsAvailable: true,
    // live stand-in: keep everything (judgment says "helpful" regardless of recurrence)
    pruneVerdicts: () => false,
  });
  assert.equal(r.prunedPairs, 0);
  assert.equal(r.falsePrune, 0);
  // tc2 (tavily, never recurs) was kept by the override -> exactly one missed saving
  assert.equal(r.falseKeep, 1);
});

test("last-epoch outputs are never judged (no subsequent turn exists)", async () => {
  const r = await runMini();
  // tc4 (image result, last epoch) must not be pruned
  assert.equal(r.prunedPairs, 1);
});

test("degraded sessions run skills fail-static: all catalog skills, flagged loud", async () => {
  const r = await runMini({ skillsAvailable: false });
  assert.equal(r.degradedSkills, true);
  assert.equal(r.baseline.skillsBytes, r.routed.skillsBytes);
  assert.equal(r.loadedSkills.length, Object.keys(catalog.skills).length);
});

test("jev spend lines cover skill-load, namespace and prune batches per epoch", async () => {
  const r = await runMini();
  const kinds = new Set(r.spend.map((s) => s.kind));
  assert.ok(kinds.has("skill-load"));
  assert.ok(kinds.has("namespace-batch"));
  assert.ok(kinds.has("prune-batch"));
  // skill-load requests: not-active skills per epoch (18 skills, 3 loaded from epoch 0)
  const loads = r.spend.filter((s) => s.kind === "skill-load").length;
  assert.equal(loads, (Object.keys(catalog.skills).length - 3) * 3 + 3); // epoch 0 scores all 18
});

test("reduction is strictly positive on the mini-session", async () => {
  const r = await runMini();
  assert.ok(r.routed.textBytes < r.baseline.textBytes);
  assert.ok(r.pruned.textBytes <= r.routed.textBytes);
});

test("raw arm: context_edit prunes show as already-pruned-by-governor, not nozzle savings", async () => {
  const scores = Object.fromEntries(
    Object.keys(catalog.skills).map((k) => [k, scoreOf(k)]),
  );
  const governed = await simulate(parseSession(MINI_EDITED), {
    proj: "mini-edited",
    catalog,
    policy,
    scores: async () => scores,
    skillsAvailable: true,
  });
  // the governor's own context_edit entries shrink the projected baseline vs raw
  assert.ok(governed.raw.historyBytes > governed.baseline.historyBytes);
  assert.ok(governed.raw.textBytes > governed.baseline.textBytes);
  // the tc2 pair (result omitted by edit, call part removed from e5) no longer
  // exists in the projected epochs, so the proxy never re-judges it: prunedPairs 0
  assert.equal(governed.prunedPairs, 0);
});

test("raw arm equals baseline on an ungoverned session (no edits, no double counting)", async () => {
  const r = await runMini();
  assert.equal(r.raw.textBytes, r.baseline.textBytes);
  assert.equal(r.raw.historyBytes, r.baseline.historyBytes);
});

test("two full pipeline runs produce byte-identical reports", async () => {
  const run = async () => {
    const r = await runMini();
    const doc = buildReport("mini", policy, [r], {
      judgments: 0,
      relevantJudgments: 0,
      irrelevantJudgments: 0,
      minRelevantScore: 0,
      fpAtThreshold: 0,
      fpRateAtThreshold: 0,
      loadedNotLabeled: [],
    });
    return { json: reportJson(doc), md: reportMarkdown(doc) };
  };
  const a = await run();
  const b = await run();
  assert.equal(a.json, b.json);
  assert.equal(a.md, b.md);
});
