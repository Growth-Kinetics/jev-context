// CHECK: the eval ratchet gate (VERIFYING.md section 4). Operates on committed data only
// (eval/expected.json + eval/baseline-results.json) so `npm run check` passes on any machine.
// Ratchets are monotonic: floors and ceilings may tighten, never loosen. Changing the
// threshold policy requires re-running the live eval and committing updated expectations
// in the same commit — the gate enforces this by pinning the threshold at record time.

export interface ExpectedFile {
  note?: string;
  threshold_policy: { load: number; top_k: number; decay: number };
  labels: Record<string, string[]>;
  ratchet?: {
    floors: Record<string, number>;
    fp_ceiling: number;
    threshold_at_record: number;
  };
}

export interface BaselineEntry {
  proj: string;
  relevant: string[];
  scores: Record<string, number>;
  errors: Record<string, string>;
}

export interface GateFailure {
  check: string;
  detail: string;
}

export function labelMetrics(
  expected: ExpectedFile,
  baseline: BaselineEntry[],
): {
  judgments: number;
  relevantJudgments: number;
  irrelevantJudgments: number;
  minRelevantScore: number;
  fpAtThreshold: number;
  fpRateAtThreshold: number;
  loadedNotLabeled: Array<{ proj: string; skill: string }>;
} {
  const threshold = expected.threshold_policy.load;
  let judgments = 0;
  let relevantJudgments = 0;
  let irrelevantJudgments = 0;
  let minRelevantScore = Number.POSITIVE_INFINITY;
  let fp = 0;
  const loadedNotLabeled: Array<{ proj: string; skill: string }> = [];
  for (const entry of baseline) {
    const labeled = expected.labels[entry.proj] ?? [];
    const ranked = Object.entries(entry.scores)
      .filter(([, score]) => score >= threshold)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const loaded = ranked
      .slice(0, expected.threshold_policy.top_k)
      .map(([name]) => name);
    for (const skill of loaded) {
      if (!labeled.includes(skill))
        loadedNotLabeled.push({ proj: entry.proj, skill });
    }
    for (const [skill, score] of Object.entries(entry.scores)) {
      judgments += 1;
      if (labeled.includes(skill)) {
        relevantJudgments += 1;
        minRelevantScore = Math.min(minRelevantScore, score);
      } else {
        irrelevantJudgments += 1;
        if (score >= threshold) fp += 1;
      }
    }
  }
  return {
    judgments,
    relevantJudgments,
    irrelevantJudgments,
    minRelevantScore: Number.isFinite(minRelevantScore) ? minRelevantScore : 0,
    fpAtThreshold: fp,
    fpRateAtThreshold: irrelevantJudgments > 0 ? fp / irrelevantJudgments : 0,
    loadedNotLabeled,
  };
}

export function runGate(
  expected: ExpectedFile,
  baseline: BaselineEntry[],
): GateFailure[] {
  const failures: GateFailure[] = [];
  const ratchet = expected.ratchet;
  if (ratchet === undefined) {
    return [
      {
        check: "ratchet-present",
        detail:
          "expected.json has no ratchet section; record floors and fp_ceiling",
      },
    ];
  }
  if (ratchet.threshold_at_record !== expected.threshold_policy.load) {
    failures.push({
      check: "threshold-pinned",
      detail: `threshold_policy.load=${expected.threshold_policy.load} differs from recorded ${ratchet.threshold_at_record}; re-run the live eval and commit updated expectations in the same commit`,
    });
  }
  const byProj = new Map(baseline.map((entry) => [entry.proj, entry]));
  for (const [key, floor] of Object.entries(ratchet.floors)) {
    const slash = key.indexOf("/");
    const proj = key.slice(0, slash);
    const skill = key.slice(slash + 1);
    const entry = byProj.get(proj);
    if (entry === undefined) {
      failures.push({
        check: "floor",
        detail: `${key}: proj missing from baseline-results.json`,
      });
      continue;
    }
    const score = entry.scores[skill];
    if (score === undefined) {
      failures.push({
        check: "floor",
        detail: `${key}: skill missing from recorded scores`,
      });
      continue;
    }
    if (score < floor) {
      failures.push({
        check: "floor",
        detail: `${key}: recorded ${score} < floor ${floor}`,
      });
    }
  }
  const metrics = labelMetrics(expected, baseline);
  if (metrics.fpRateAtThreshold > ratchet.fp_ceiling) {
    failures.push({
      check: "fp-ceiling",
      detail: `irrelevant FP rate ${(metrics.fpRateAtThreshold * 100).toFixed(3)}% exceeds ceiling ${(ratchet.fp_ceiling * 100).toFixed(3)}%`,
    });
  }
  return failures;
}
