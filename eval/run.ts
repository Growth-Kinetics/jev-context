// RUN: CLI entry for the benchmark harness.
//   node eval/run.ts --check                  ratchet gate over committed data (no sessions needed)
//   node eval/run.ts [--corpus golden|all] [--session <path>...] [--live] [--out <dir>]
// Fixture mode (default) is deterministic and touches no network. --live reads the key from
// PI_TYPESAFE_JEV or --key-file, hits the Jev endpoint through the injectable client, and
// writes results into the recorded cache (scores only; the key is never logged or stored).

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog, type Catalog } from "./harness/catalog.ts";
import { parseSession } from "./harness/session.ts";
import { simulate, type ScoresProvider, type SessionResult } from "./harness/simulate.ts";
import { buildReport, reportJson, reportMarkdown, type LabelMetrics } from "./harness/report.ts";
import { runGate, labelMetrics, type BaselineEntry, type ExpectedFile } from "./harness/check.ts";
import { createLiveClient, loadCache, saveCache, requestKey, type ScoreCache } from "./harness/client.ts";
import type { JevRequest, JevResponse } from "./harness/types.ts";

const EVAL_DIR = new URL(".", import.meta.url).pathname;
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const SKILL_ROOTS = [
  "/tmp/jev-skills",
  `${process.env.HOME ?? "/home/alex"}/.pi/agent/skills`,
  `${process.env.HOME ?? "/home/alex"}/.pi/agent/git/github.com/Growth-Kinetics/gk-pi/skills`,
  `${process.env.HOME ?? "/home/alex"}/.pi/agent/git/github.com/Growth-Kinetics/gk-pi/node_modules/pi-heavy-think/skills`,
];

interface GoldenEntry {
  path: string;
  proj: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function usage(): never {
  console.error(
    "usage: node eval/run.ts --check | [--corpus golden|all] [--session <path>...] [--live] [--out <dir>] [--key-file <path>]",
  );
  process.exit(2);
}

function scanSkillBodies(roots: string[]): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const skillPath = join(root, dir.name, "SKILL.md");
      if (existsSync(skillPath) && statSync(skillPath).isFile() && !bodies.has(dir.name)) {
        bodies.set(dir.name, readFileSync(skillPath, "utf8"));
      }
    }
  }
  return bodies;
}

interface LedgerEntry {
  key: string;
  inputTokens: number;
  latencyMs: number;
  cached: boolean;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const flags = new Map<string, string>();
  const sessionPaths: string[] = [];
  const valueFlags = new Set(["--corpus", "--out", "--key-file"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      flags.set(a.slice(2, eq), a.slice(eq + 1));
    } else if (valueFlags.has(a)) {
      flags.set(a.slice(2), args[++i] ?? "");
    } else if (a.startsWith("--")) {
      flags.set(a.slice(2), "");
    } else {
      sessionPaths.push(a);
    }
  }
  const wantCheck = flags.has("check");
  const live = flags.has("live");
  const corpusArg = flags.get("corpus") ?? "golden";
  const outDir = flags.get("out") ?? EVAL_DIR;
  const keyFile = flags.get("key-file");
  if (args.length === 0) usage();

  const expected = readJson<ExpectedFile>(join(EVAL_DIR, "expected.json"));
  const baseline = readJson<BaselineEntry[]>(join(EVAL_DIR, "baseline-results.json"));

  if (wantCheck) {
    const failures = runGate(expected, baseline);
    if (failures.length > 0) {
      console.error("EVAL_GATE_FAILED:");
      for (const f of failures) console.error(`  ${f.check}: ${f.detail}`);
      return 1;
    }
    console.log("EVAL_GATE_OK: floors and FP ceiling hold");
    return 0;
  }

  // ---- corpus selection
  const golden = readJson<GoldenEntry[]>(join(EVAL_DIR, "golden-sessions.json"));
  const corpus =
    sessionPaths.length > 0
      ? sessionPaths.map((p) => ({ path: p, proj: p }))
      : corpusArg === "all"
        ? golden
        : golden.filter((g) => baseline.some((b) => b.proj === g.proj));
  const corpusName =
    sessionPaths.length > 0 ? `paths:${sessionPaths.length}` : corpusArg === "all" ? "all" : "golden";
  // ---- scores: recorded table (fixture) or live client
  const recorded = new Map(baseline.map((b) => [b.proj, b.scores]));
  const cachePath = join(EVAL_DIR, "fixtures", "recorded-cache.json");
  const cache: ScoreCache = live ? loadCache(cachePath) : {};
  const ledger: LedgerEntry[] = [];

  let provider: ScoresProvider;
  if (live) {
    const apiKey = keyFile !== undefined
      ? readFileSync(keyFile, "utf8").trim().split("\n").find((l) => l.includes("="))?.split("=").slice(1).join("=").trim() ?? ""
      : process.env.PI_TYPESAFE_JEV ?? "";
    if (apiKey === "") {
      console.error("LIVE_KEY_MISSING: set PI_TYPESAFE_JEV or pass --key-file");
      return 2;
    }
    const bodies = scanSkillBodies(SKILL_ROOTS);
    const base = createLiveClient({
      endpoint: ENDPOINT,
      apiKey,
      cache,
      onRecord: (c) => saveCache(cachePath, c),
    });
    const client = async (req: JevRequest): Promise<JevResponse> => {
      const key = requestKey(req);
      const cached = cache[key] !== undefined;
      const res = await base(req);
      ledger.push({ key, inputTokens: res.usage?.input_tokens ?? 0, latencyMs: res.latencyMs ?? 0, cached });
      return res;
    };
    provider = async (ctx) => {
      const scores: Record<string, number> = {};
      const jobs = [...bodies.entries()].map(async ([name, body]) => {
        const req: JevRequest = {
          state: ctx.digest,
          model: MODEL,
          questions: {
            should_load: {
              type: "noul",
              instructions: `Below is the full documentation of a candidate agent skill named '${name}'. Should this skill be loaded into the agent's context to help with the user's work in the conversation state?\n\n--- SKILL DOCUMENTATION ---\n${body}`,
              criteria: {
                true: "The conversation's task directly involves this skill's domain or the user explicitly referenced it",
                false: "Unrelated or only tangentially related",
              },
            },
          },
        };
        const res = await client(req);
        scores[name] = res.answers.should_load ?? 0;
      });
      await Promise.all(jobs);
      return scores;
    };
  } else {
    provider = async (ctx) => {
      const scores = recorded.get(ctx.proj);
      if (scores === undefined) throw new Error(`NO_RECORDED_SCORES: ${ctx.proj}`);
      return scores;
    };
  }

  const catalog: Catalog = loadCatalog();
  const results: SessionResult[] = [];
  for (const entry of corpus) {
    const session = parseSession(entry.path);
    const skillsAvailable = live || recorded.has(entry.proj);
    const result = await simulate(session, {
      proj: entry.proj,
      catalog,
      policy: expected.threshold_policy,
      scores: provider,
      skillsAvailable,
    });
    results.push(result);
    console.error(`REPLAYED: proj=${entry.proj} epochs=${result.epochs} calls=${result.calls} degraded=${result.degradedSkills}`);
  }

  const metrics = labelMetrics(expected, baseline);
  const labels: LabelMetrics = metrics;
  const doc = buildReport(corpusName, expected.threshold_policy, results, labels);

  const base = sessionPaths.length > 0 ? "REPORT-PATHS" : corpusName === "all" ? "REPORT-ALL" : "REPORT";
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${base}.md`), reportMarkdown(doc));
  writeFileSync(join(outDir, `${base}.json`), reportJson(doc));

  if (live && ledger.length > 0) {
    const cold = ledger.filter((l) => !l.cached);
    const inputTokens = cold.reduce((acc, l) => acc + l.inputTokens, 0);
    console.log(
      `LIVE_RUN: requests=${ledger.length} cold=${cold.length} cold_input_tokens=${inputTokens} usd=${((inputTokens * 0.042) / 1e6).toFixed(4)} wall_ms_max=${Math.max(...ledger.map((l) => l.latencyMs))}`,
    );
  }
  console.log(`REPORT_WRITTEN: ${join(outDir, `${base}.md`)}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`HARNESS_FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
