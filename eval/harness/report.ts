// REPORT: deterministic JSON + markdown writers. No timestamps, no Date.now, fixed
// key order, fixed decimal precision — two runs over the same corpus are byte-identical.

import { sha256 } from "./catalog.ts";
import type { ThresholdPolicy } from "./policy.ts";
import type { SessionResult, SpendLine } from "./simulate.ts";
import { estimateTokens, usdFromTokens } from "./tokens.ts";

export interface Aggregate {
  sessions: number;
  degradedSkillsSessions: number;
  calls: number;
  epochs: number;
  tokensBaseline: number;
  tokensRouted: number;
  tokensPruned: number;
  skillsSavedTokens: number;
  toolsSavedTokens: number;
  historySavedTokens: number;
  reductionRoutedPct: number;
  reductionPrunedPct: number;
  prunedPairs: number;
  prunedTokens: number;
  falsePrune: number;
  falseKeep: number;
  namespaceMisses: number;
  jevColdTokens: number;
  jevColdUsd: number;
  jevRequests: number;
  imageBytesBaseline: number;
}

export interface LabelMetrics {
  judgments: number;
  relevantJudgments: number;
  irrelevantJudgments: number;
  minRelevantScore: number;
  fpAtThreshold: number;
  fpRateAtThreshold: number;
  loadedNotLabeled: Array<{ proj: string; skill: string }>;
}

function sumSpend(spend: SpendLine[]): { tokens: number; requests: number } {
  return spend.reduce(
    (acc, line) => ({
      tokens: acc.tokens + line.tokensEstimated,
      requests: acc.requests + 1,
    }),
    { tokens: 0, requests: 0 },
  );
}

export function aggregate(results: SessionResult[]): Aggregate {
  const tokens = (r: SessionResult, arm: "baseline" | "routed" | "pruned") =>
    estimateTokens(r[arm].textBytes);
  const tokensBaseline = results.reduce(
    (acc, r) => acc + tokens(r, "baseline"),
    0,
  );
  const tokensRouted = results.reduce((acc, r) => acc + tokens(r, "routed"), 0);
  const tokensPruned = results.reduce((acc, r) => acc + tokens(r, "pruned"), 0);
  const skillsSaved = results.reduce(
    (acc, r) =>
      acc + estimateTokens(r.baseline.skillsBytes - r.routed.skillsBytes),
    0,
  );
  const toolsSaved = results.reduce(
    (acc, r) =>
      acc + estimateTokens(r.baseline.toolsBytes - r.routed.toolsBytes),
    0,
  );
  const historySaved = results.reduce(
    (acc, r) =>
      acc + estimateTokens(r.routed.historyBytes - r.pruned.historyBytes),
    0,
  );
  const cold = sumSpend(results.flatMap((r) => r.spend));
  return {
    sessions: results.length,
    degradedSkillsSessions: results.filter((r) => r.degradedSkills).length,
    calls: results.reduce((acc, r) => acc + r.calls, 0),
    epochs: results.reduce((acc, r) => acc + r.epochs, 0),
    tokensBaseline,
    tokensRouted,
    tokensPruned,
    skillsSavedTokens: skillsSaved,
    toolsSavedTokens: toolsSaved,
    historySavedTokens: historySaved,
    reductionRoutedPct:
      tokensBaseline > 0
        ? ((tokensBaseline - tokensRouted) / tokensBaseline) * 100
        : 0,
    reductionPrunedPct:
      tokensBaseline > 0
        ? ((tokensBaseline - tokensPruned) / tokensBaseline) * 100
        : 0,
    prunedPairs: results.reduce((acc, r) => acc + r.prunedPairs, 0),
    prunedTokens: results.reduce((acc, r) => acc + r.prunedTokens, 0),
    falsePrune: results.reduce((acc, r) => acc + r.falsePrune, 0),
    falseKeep: results.reduce((acc, r) => acc + r.falseKeep, 0),
    namespaceMisses: results.reduce((acc, r) => acc + r.namespaceMisses, 0),
    jevColdTokens: cold.tokens,
    jevColdUsd: usdFromTokens(cold.tokens),
    jevRequests: cold.requests,
    imageBytesBaseline: results.reduce(
      (acc, r) => acc + r.baseline.imageBytes,
      0,
    ),
  };
}

export interface ReportDoc {
  corpus: string;
  fingerprint: string;
  policy: ThresholdPolicy;
  aggregate: Aggregate;
  sessions: SessionResult[];
  labels?: LabelMetrics;
}

export function buildReport(
  corpus: string,
  policy: ThresholdPolicy,
  results: SessionResult[],
  labels?: LabelMetrics,
): ReportDoc {
  const sorted = [...results].sort(
    (a, b) => a.proj.localeCompare(b.proj) || a.path.localeCompare(b.path),
  );
  return {
    corpus,
    fingerprint: sha256(
      JSON.stringify(
        sorted.map((r) => [
          r.proj,
          r.path,
          r.baseline.textBytes,
          r.pruned.textBytes,
        ]),
      ),
    ),
    policy,
    aggregate: aggregate(sorted),
    sessions: sorted,
    labels,
  };
}

const pct = (v: number) => v.toFixed(2);
const tok = (v: number) => v.toLocaleString("en-US");

export function reportJson(doc: ReportDoc): string {
  return `${JSON.stringify(doc, null, 1)}\n`;
}

export function reportMarkdown(doc: ReportDoc): string {
  const a = doc.aggregate;
  const lines: string[] = [];
  lines.push(`# Jev context governor — benchmark report`);
  lines.push("");
  lines.push(
    `- corpus: \`${doc.corpus}\` (${a.sessions} sessions, ${a.epochs} epochs, ${a.calls} LLM calls)`,
  );
  lines.push(`- fingerprint: \`${doc.fingerprint}\``);
  lines.push(
    `- policy: load \`${doc.policy.load}\`, top_k \`${doc.policy.top_k}\`, decay \`${doc.policy.decay}\``,
  );
  lines.push("");
  lines.push(`## Aggregate counterfactual (context tokens billed per call)`);
  lines.push("");
  lines.push(`| arm | tokens |`);
  lines.push(`|---|---|`);
  lines.push(`| baseline (native) | ${tok(a.tokensBaseline)} |`);
  lines.push(
    `| routed (nozzles 1+2) | ${tok(a.tokensRouted)} (−${pct(a.reductionRoutedPct)}%) |`,
  );
  lines.push(
    `| pruned (all three) | ${tok(a.tokensPruned)} (−${pct(a.reductionPrunedPct)}%) |`,
  );
  lines.push("");
  lines.push(
    `Savings attribution: skills ${tok(a.skillsSavedTokens)}, tool schemas ${tok(a.toolsSavedTokens)}, pruned history ${tok(a.historySavedTokens)} tokens.`,
  );
  lines.push("");
  lines.push(`## Jev spend (cold, what a first live run would cost)`);
  lines.push("");
  lines.push(
    `${tok(a.jevColdTokens)} input tokens over ${a.jevRequests} requests ≈ $${a.jevColdUsd.toFixed(4)} at $0.042/Mtok. Replays over the recorded cache are free.`,
  );
  lines.push("");
  lines.push(`## Nozzle 3 ground truth`);
  lines.push("");
  lines.push(
    `- pruned pairs: ${a.prunedPairs} (${tok(a.prunedTokens)} tokens reclaimed at boundaries)`,
  );
  lines.push(
    `- false prunes: ${a.falsePrune}; missed savings (kept, never recurred): ${a.falseKeep}`,
  );
  lines.push(
    `- namespace misses (surfaced only via escape hatch): ${a.namespaceMisses}`,
  );
  if (a.degradedSkillsSessions > 0) {
    lines.push(
      `- ${a.degradedSkillsSessions}/${a.sessions} sessions ran skills fail-static (no recorded scores; savings from nozzles 1 excluded there)`,
    );
  }
  if (doc.labels !== undefined) {
    lines.push("");
    lines.push(`## Label metrics (golden set, recorded scores)`);
    lines.push("");
    lines.push(
      `- judgments: ${doc.labels.judgments} (relevant: ${doc.labels.relevantJudgments}, irrelevant: ${doc.labels.irrelevantJudgments}, min relevant score ${doc.labels.minRelevantScore})`,
    );
    lines.push(
      `- irrelevant false-positives at threshold ${doc.policy.load}: ${doc.labels.fpAtThreshold} (${pct(doc.labels.fpRateAtThreshold * 100)}%)`,
    );
    if (doc.labels.loadedNotLabeled.length > 0) {
      lines.push(
        `- loaded-but-not-labeled: ${doc.labels.loadedNotLabeled.map((l) => `${l.proj}/${l.skill}`).join(", ")}`,
      );
    } else {
      lines.push(`- loaded-but-not-labeled: none`);
    }
  }
  lines.push("");
  lines.push(`## Per-session`);
  lines.push("");
  lines.push(
    `| proj | epochs | calls | baseline | routed | pruned | red. % | pruned pairs |`,
  );
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of doc.sessions) {
    const red =
      r.baseline.textBytes > 0
        ? ((r.baseline.textBytes - r.pruned.textBytes) / r.baseline.textBytes) *
          100
        : 0;
    lines.push(
      `| ${r.proj} | ${r.epochs} | ${r.calls} | ${tok(estimateTokens(r.baseline.textBytes))} | ${tok(estimateTokens(r.routed.textBytes))} | ${tok(estimateTokens(r.pruned.textBytes))} | ${pct(red)} | ${r.prunedPairs} |`,
    );
  }
  lines.push("");
  lines.push(
    `Token model: bytes/3.5 estimator (documented in eval/README.md). Image bytes ride the same constant and are reported separately (${tok(a.imageBytesBaseline)} bytes across the corpus in the baseline arm).`,
  );
  lines.push("");
  return lines.join("\n");
}
