// Tests: threshold policy — load 0.6, top-K 3, decay 0.25 (SESSION_SPEC_2026-09-18-001).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decayDue,
  selectSkills,
  shouldEvict,
  type ThresholdPolicy,
} from "./policy.ts";

const policy: ThresholdPolicy = { load: 0.6, top_k: 3, decay: 0.25 };

test("only skills >= 0.6 enter the active set, capped at top-3 by score", () => {
  const loaded = selectSkills(
    { a: 0.86, b: 0.91, c: 0.16, d: 0.7, e: 0.61, f: 0.59 },
    policy,
  );
  assert.deepEqual(loaded, ["b", "a", "d"]);
});

test("ties break deterministically by name", () => {
  const loaded = selectSkills(
    { zzz: 0.9, aaa: 0.9, mmm: 0.9, bbb: 0.95 },
    policy,
  );
  assert.deepEqual(loaded, ["bbb", "aaa", "mmm"]);
});

test("nothing below threshold loads even with free slots", () => {
  assert.deepEqual(selectSkills({ a: 0.59, b: 0.1 }, policy), []);
});

test("decay re-check fires on the 5th user turn since load", () => {
  assert.equal(decayDue(0, 4), false);
  assert.equal(decayDue(0, 5), true);
  assert.equal(decayDue(3, 8), true);
});

test("an active skill leaves the set when its re-check scores below 0.25", () => {
  assert.equal(shouldEvict(0.24, policy), true);
  assert.equal(shouldEvict(0.25, policy), false);
});
