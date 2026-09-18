// Tests: the eval ratchet gate (VERIFYING.md section 4) over committed-data shapes.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BaselineEntry,
  type ExpectedFile,
  labelMetrics,
  runGate,
} from "./check.ts";

const expected: ExpectedFile = {
  threshold_policy: { load: 0.6, top_k: 3, decay: 0.25 },
  labels: { alpha: ["browser-use"], beta: [] },
  ratchet: {
    floors: { "alpha/browser-use": 0.92 },
    fp_ceiling: 0.06,
    threshold_at_record: 0.6,
  },
};

const baseline: BaselineEntry[] = [
  {
    proj: "alpha",
    relevant: ["browser-use"],
    scores: { "browser-use": 0.92, spec: 0.3 },
    errors: {},
  },
  {
    proj: "beta",
    relevant: [],
    scores: { "browser-use": 0.45, spec: 0.2 },
    errors: {},
  },
];

test("gate holds when floors and FP ceiling are met", () => {
  assert.deepEqual(runGate(expected, baseline), []);
});

test("gate fails when a labeled-relevant skill falls below its recorded floor", () => {
  const regressed = [
    { ...baseline[0], scores: { ...baseline[0].scores, "browser-use": 0.61 } },
    baseline[1],
  ];
  const failures = runGate(expected, regressed);
  assert.equal(failures.length, 1);
  assert.match(failures[0].detail, /alpha\/browser-use/);
});

test("gate fails when the irrelevant false-positive rate exceeds the ceiling", () => {
  const noisy: BaselineEntry[] = [
    ...baseline,
    {
      proj: "gamma",
      relevant: [],
      scores: { "browser-use": 0.9, spec: 0.9 },
      errors: {},
    },
  ];
  const failures = runGate(expected, noisy);
  assert.ok(failures.some((f) => f.check === "fp-ceiling"));
});

test("gate fails loud when a floor references a missing session or skill", () => {
  const broken: ExpectedFile = {
    ...expected,
    ratchet: {
      floors: { "ghost/skill": 0.5 },
      fp_ceiling: 1,
      threshold_at_record: 0.6,
    },
  };
  const failures = runGate(broken, baseline);
  assert.ok(
    failures.some((f) => f.check === "floor" && f.detail.includes("ghost")),
  );
});

test("gate pins the threshold at record time: policy drift fails without a re-run", () => {
  const drifted: ExpectedFile = {
    ...expected,
    threshold_policy: { load: 0.5, top_k: 3, decay: 0.25 },
  };
  const failures = runGate(drifted, baseline);
  assert.ok(failures.some((f) => f.check === "threshold-pinned"));
});

test("gate demands a ratchet section before anything else", () => {
  const failures = runGate(
    { threshold_policy: expected.threshold_policy, labels: expected.labels },
    baseline,
  );
  assert.equal(failures[0].check, "ratchet-present");
});

test("label metrics count judgments, FP at threshold, and loaded-but-not-labeled", () => {
  const hot: BaselineEntry[] = [
    baseline[0],
    {
      proj: "beta",
      relevant: [],
      scores: { "browser-use": 0.7, spec: 0.2 },
      errors: {},
    },
  ];
  const m = labelMetrics(expected, hot);
  assert.equal(m.judgments, 4);
  assert.equal(m.relevantJudgments, 1);
  assert.equal(m.minRelevantScore, 0.92);
  assert.equal(m.fpAtThreshold, 1); // beta/browser-use at 0.7
  assert.equal(m.irrelevantJudgments, 3);
  assert.ok(Math.abs(m.fpRateAtThreshold - 1 / 3) < 1e-9); // FP over irrelevant judgments
  // top-3 cap: beta loads browser-use (0.7) which is not labeled -> listed
  assert.deepEqual(m.loadedNotLabeled, [
    { proj: "beta", skill: "browser-use" },
  ]);
});
