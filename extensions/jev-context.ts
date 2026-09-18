/**
 * jev-context — Jev-routed context governor for Pi (GOAL 2026-09-18-001).
 *
 * Nozzle 1 — skill loading: at each user-turn boundary (`before_agent_start`),
 *   scores the skill catalog against a digest of the session via the Jev
 *   (TypeSafe System One) API — one parallel request per not-yet-active skill
 *   with the full skill body embedded in the noul question — then injects the
 *   winning skill bodies into the deep-copied message list of the `context`
 *   event, frozen until `agent_settled`.
 * Nozzle 2 — tool surfacing: on the SAME boundary and the SAME digest, scores
 *   owner-configured tool namespaces in ONE batched Jev request (one noul per
 *   namespace, tool descriptions only) and applies the result via
 *   `setActiveTools`. The hardcoded core (read, write, edit, bash, grep, find,
 *   ls) is never routed; namespace schemas are present only while their
 *   namespace is active; mutations happen at the boundary only, never
 *   mid-epoch (§3.4). Jev failure is fail-static: every configured namespace
 *   becomes visible (Pi default), one notify per error class, ROUTE_DEGRADED
 *   logged (§3.5).
 * Events used: `session_start` (init: config, API key, catalog scan),
 *   `before_agent_start` (digest + both scoring passes + injection rebuild +
 *   tool-set application), `context` (inject into the message copy),
 *   `agent_settled` (close epoch).
 * State owned: skill catalog cache, active-skill set (name -> score, pinned
 *   flag, turns since load), the per-epoch frozen injection message, namespace
 *   active set, once-per-reason degradation marks, once-per-name config logs,
 *   epoch counters, and the append-only telemetry
 *   JSONL. All session state rebuilds on `session_start` (any reason).
 * Commands: `skill:<name>` per catalog skill (manual load, pinned against
 *   decay — mirrors Pi's native skill-command naming), `skill_stats`.
 * Config: `~/.pi/agent/jev-context.json` then `<cwd>/.pi/jev-context.json`;
 *   the API key comes from the config-named env var (default
 *   $PI_TYPESAFE_JEV) or the config-named file. The key is never logged (§3.6).
 *   `toolNamespaces` maps namespace -> { tools, prefix } (owner rules, §3.8 —
 *   the extension ships no bundle opinions); `coreTools` extends the
 *   hardcoded core floor; `toolSurfaceThreshold` gates namespaces.
 * Invariants (VERIFYING.md): the on-disk transcript is never written (§3.3);
 *   injection is byte-stable within an epoch (§3.4); degradation is loud —
 *   notify once per reason, log ROUTE_DEGRADED, keep the current set (§3.5);
 *   boundary events emit structured logs (§3.9).
 */

import type { Dirent } from "node:fs";
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  TextContent,
  ThinkingContent,
  UserMessage,
} from "@earendil-works/pi-ai";
import type {
  BeforeAgentStartEvent,
  ContextEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

// --------------------------------------------------------------------------
// Config: owner rules live here, not in code (§3.8).
// --------------------------------------------------------------------------

export interface ToolNamespaceConfig {
  /** Explicit tool names; intersected with the tools Pi actually has. */
  tools: string[];
  /** Prefix match against available tool names (e.g. "browser_"). */
  prefix: string | undefined;
}

/**
 * Always-on core (frozen design): hardcoded floor, never routed, force-kept
 * in the active tool set. Owner config `coreTools` may extend it, never
 * shrink it.
 */
export const CORE_TOOLS = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
] as const;

export interface JevContextConfig {
  endpoint: string;
  model: string;
  apiKeyEnv: string;
  apiKeyFile: string | undefined;
  loadThreshold: number;
  topK: number;
  decayThreshold: number;
  decayIntervalTurns: number;
  digestCapBytes: number;
  requestTimeoutMs: number;
  telemetryFile: string;
  skillRoots: string[];
  toolNamespaces: Record<string, ToolNamespaceConfig>;
  toolSurfaceThreshold: number;
  coreTools: string[];
}

export function defaultSkillRoots(homeDir: string, cwd: string): string[] {
  return [
    join(homeDir, ".pi", "agent", "skills"),
    join(cwd, ".pi", "skills"),
    join(homeDir, ".agents", "skills"),
    join(cwd, ".agents", "skills"),
  ];
}

export function defaultTelemetryFile(homeDir: string): string {
  return join(homeDir, ".pi", "agent", "jev-context-telemetry.jsonl");
}

/** Fallback before any config load; defaultConfig is the single source. */
export const DEFAULT_DIGEST_CAP_BYTES = 80_000;

export function defaultConfig(homeDir: string, cwd: string): JevContextConfig {
  return {
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    apiKeyEnv: "PI_TYPESAFE_JEV",
    apiKeyFile: undefined,
    loadThreshold: 0.6,
    topK: 3,
    decayThreshold: 0.25,
    decayIntervalTurns: 5,
    digestCapBytes: DEFAULT_DIGEST_CAP_BYTES,
    requestTimeoutMs: 300_000,
    telemetryFile: defaultTelemetryFile(homeDir),
    skillRoots: defaultSkillRoots(homeDir, cwd),
    toolNamespaces: {},
    toolSurfaceThreshold: 0.6,
    coreTools: [...CORE_TOOLS],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function expandHome(path: string, homeDir: string): string {
  return path.startsWith("~/") ? join(homeDir, path.slice(2)) : path;
}

/** Parse one toolNamespaces entry; null when neither key is usable. */
function pickNamespaceConfig(raw: unknown): ToolNamespaceConfig | null {
  const r = asRecord(raw);
  if (r === null) return null;
  const tools =
    Array.isArray(r.tools) && r.tools.every((v) => typeof v === "string")
      ? (r.tools as string[])
      : [];
  const prefix = typeof r.prefix === "string" ? r.prefix : undefined;
  if (tools.length === 0 && prefix === undefined) return null;
  return { tools, prefix };
}

/** Keep only known, correctly-typed fields; expand `~/` in path fields. */
function pickConfigFields(
  raw: unknown,
  homeDir: string,
): { fields: Partial<JevContextConfig>; warnings: string[] } {
  const r = asRecord(raw);
  const warnings: string[] = [];
  if (r === null) return { fields: {}, warnings };
  const out: Partial<JevContextConfig> = {};
  if (typeof r.endpoint === "string") out.endpoint = r.endpoint;
  if (typeof r.model === "string") out.model = r.model;
  if (typeof r.apiKeyEnv === "string") out.apiKeyEnv = r.apiKeyEnv;
  if (typeof r.apiKeyFile === "string") {
    out.apiKeyFile = expandHome(r.apiKeyFile, homeDir);
  }
  if (typeof r.loadThreshold === "number") out.loadThreshold = r.loadThreshold;
  if (typeof r.topK === "number") out.topK = r.topK;
  if (typeof r.decayThreshold === "number") {
    out.decayThreshold = r.decayThreshold;
  }
  if (typeof r.decayIntervalTurns === "number") {
    out.decayIntervalTurns = r.decayIntervalTurns;
  }
  if (typeof r.digestCapBytes === "number") {
    out.digestCapBytes = r.digestCapBytes;
  }
  if (typeof r.requestTimeoutMs === "number") {
    out.requestTimeoutMs = r.requestTimeoutMs;
  }
  if (typeof r.telemetryFile === "string") {
    out.telemetryFile = expandHome(r.telemetryFile, homeDir);
  }
  if (
    Array.isArray(r.skillRoots) &&
    r.skillRoots.every((v) => typeof v === "string")
  ) {
    out.skillRoots = r.skillRoots.map((p) => expandHome(p as string, homeDir));
  }
  const ns = asRecord(r.toolNamespaces);
  if (ns !== null) {
    const parsed: Record<string, ToolNamespaceConfig> = {};
    for (const [name, value] of Object.entries(ns)) {
      const entry = pickNamespaceConfig(value);
      if (entry === null) {
        warnings.push(`toolNamespaces.${name} has no tools or prefix; ignored`);
      } else {
        parsed[name] = entry;
      }
    }
    out.toolNamespaces = parsed;
  }
  if (typeof r.toolSurfaceThreshold === "number") {
    out.toolSurfaceThreshold = r.toolSurfaceThreshold;
  }
  if (
    Array.isArray(r.coreTools) &&
    r.coreTools.every((v) => typeof v === "string")
  ) {
    // Owner config extends the hardcoded floor; it can never shrink it.
    out.coreTools = [...new Set([...CORE_TOOLS, ...(r.coreTools as string[])])];
  }
  return { fields: out, warnings };
}

/**
 * Load config: defaults, then the user file, then the project file
 * (project wins). Missing files are normal; malformed JSON warns and falls
 * back to the previous layer.
 */
export function loadConfig(paths: {
  userConfigPath: string;
  projectConfigPath: string;
  homeDir: string;
  cwd: string;
}): { config: JevContextConfig; warnings: string[] } {
  let config = defaultConfig(paths.homeDir, paths.cwd);
  const warnings: string[] = [];
  for (const path of [paths.userConfigPath, paths.projectConfigPath]) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    try {
      const picked = pickConfigFields(JSON.parse(raw), paths.homeDir);
      config = { ...config, ...picked.fields };
      warnings.push(...picked.warnings);
    } catch {
      warnings.push(`malformed config ignored: ${path}`);
    }
  }
  return { config, warnings };
}

/**
 * Resolve the Jev API key: the config-named env var first, then the
 * config-named file (trimmed). Never logged; null means absent mode.
 */
export function resolveApiKey(
  config: Pick<JevContextConfig, "apiKeyEnv" | "apiKeyFile">,
  env: Record<string, string | undefined>,
): string | null {
  const fromEnv = env[config.apiKeyEnv];
  if (fromEnv) return fromEnv;
  if (config.apiKeyFile !== undefined) {
    try {
      const fromFile = readFileSync(config.apiKeyFile, "utf8").trim();
      if (fromFile) return fromFile;
    } catch {
      // fall through to absent mode
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Catalog: directories containing SKILL.md, first root winning name ties.
// Mirrors Pi's own skill discovery: a directory with SKILL.md is a skill
// root and is not recursed below.
// --------------------------------------------------------------------------

export interface SkillEntry {
  name: string;
  body: string;
  path: string;
}

export function scanSkillCatalog(roots: readonly string[]): SkillEntry[] {
  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // missing or unreadable root: not a degradation, just absent
    }
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
      const name = basename(dir);
      if (seen.has(name)) return;
      try {
        out.push({
          name,
          body: readFileSync(join(dir, "SKILL.md"), "utf8"),
          path: dir,
        });
        seen.add(name);
      } catch {
        // unreadable SKILL.md: skip this skill
      }
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(dir, e.name));
    }
  };
  for (const root of roots) walk(root);
  return out;
}

// --------------------------------------------------------------------------
// Digest: newest-first walk of session entries; user turns plus assistant
// text/thinking only; tool calls and results excluded; byte-capped; emitted
// chronologically. Pure input preparation (frozen design).
// --------------------------------------------------------------------------

/** Structural minimum of SessionEntry needed here (message entries only). */
export interface DigestEntry {
  type: string;
  message?: AgentMessage;
}

function digestChunksOf(
  message: AgentMessage,
): { role: "user" | "assistant"; text: string }[] {
  if (message.role === "user") {
    if (typeof message.content === "string") {
      return message.content ? [{ role: "user", text: message.content }] : [];
    }
    return message.content
      .filter((p): p is TextContent => p.type === "text")
      .map((p) => ({ role: "user" as const, text: p.text }))
      .filter((c) => c.text);
  }
  if (message.role === "assistant") {
    return message.content
      .filter(
        (p): p is TextContent | ThinkingContent =>
          p.type === "text" || p.type === "thinking",
      )
      .map((p) => ({
        role: "assistant" as const,
        text: p.type === "text" ? p.text : p.thinking,
      }))
      .filter((c) => c.text);
  }
  return [];
}

/**
 * Build the Jev state string. The current prompt is the newest turn. Walking
 * newest-first means the byte cap always drops the oldest content; a chunk
 * that would overflow ends the walk (recency prefix). Output is chronological.
 */
export function buildSessionDigest(
  entries: readonly DigestEntry[],
  currentPrompt: string,
  capBytes: number,
): string {
  const chunks: string[] = [];
  let total = 0;
  let full = false;
  const offer = (role: "user" | "assistant", text: string): void => {
    if (full || !text) return;
    const chunk = `[${role}] ${text}\n`;
    const size = Buffer.byteLength(chunk, "utf8");
    if (total + size > capBytes) {
      full = true;
      return;
    }
    chunks.push(chunk);
    total += size;
  };
  offer("user", currentPrompt);
  for (let i = entries.length - 1; i >= 0 && !full; i--) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message === undefined) continue;
    // Parts are offered in reverse so the final chronological flip restores
    // natural order within each message (newest-first at every granularity).
    const parts = digestChunksOf(entry.message);
    for (let j = parts.length - 1; j >= 0; j--)
      offer(parts[j].role, parts[j].text);
  }
  chunks.reverse();
  return chunks.join("");
}

// --------------------------------------------------------------------------
// Jev client: the single injectable seam (§4). Everything network lives here;
// tests substitute this function or point it at a fixture server.
// --------------------------------------------------------------------------

export interface JevScoreRequest {
  state: string;
  skillName: string;
  skillBody: string;
}

export interface JevScoreResult {
  score: number | null;
  inputTokens: number;
  latencyMs: number;
  error?: string;
}

export type JevScoreFn = (request: JevScoreRequest) => Promise<JevScoreResult>;

/** Question shape calibrated in eval/jev_probe.py — do not re-litigate. */
const NOUL_CRITERIA = {
  true: "The conversation's task directly involves this skill's domain or the user explicitly referenced it",
  false: "Unrelated or only tangentially related",
} as const;

export function buildShouldLoadInstructions(
  skillName: string,
  skillBody: string,
): string {
  return `Below is the full documentation of a candidate agent skill named '${skillName}'. Should this skill be loaded into the agent's context to help with the user's current work in the conversation state?\n\n--- SKILL DOCUMENTATION ---\n${skillBody}`;
}

export function parseJevScoreResponse(
  data: unknown,
): { score: number; inputTokens: number } | null {
  const root = asRecord(data);
  const answers = asRecord(root?.answers);
  const shouldLoad = asRecord(answers?.should_load);
  const score = shouldLoad?.noul;
  if (typeof score !== "number" || Number.isNaN(score)) return null;
  const usage = asRecord(root?.usage);
  const inputTokens =
    typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
  return { score, inputTokens };
}

export function createJevScorer(options: {
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}): JevScoreFn {
  return async (request) => {
    const started = Date.now();
    const body = JSON.stringify({
      state: request.state,
      model: options.model,
      questions: {
        should_load: {
          type: "noul",
          instructions: buildShouldLoadInstructions(
            request.skillName,
            request.skillBody,
          ),
          criteria: NOUL_CRITERIA,
        },
      },
    });
    let response: Response;
    try {
      response = await fetch(options.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "unreachable";
      return {
        score: null,
        inputTokens: 0,
        latencyMs: Date.now() - started,
        error: reason,
      };
    }
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return {
        score: null,
        inputTokens: 0,
        latencyMs,
        error: `http_${response.status}`,
      };
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { score: null, inputTokens: 0, latencyMs, error: "bad_response" };
    }
    const parsed = parseJevScoreResponse(data);
    if (parsed === null) {
      return { score: null, inputTokens: 0, latencyMs, error: "bad_response" };
    }
    return { score: parsed.score, inputTokens: parsed.inputTokens, latencyMs };
  };
}

// --------------------------------------------------------------------------
// Batched namespace client (Nozzle 2): ONE Jev request per epoch carrying one
// noul per configured namespace — tool descriptions only, small payloads
// (frozen design). Request/response shape mirrors eval/harness/client.ts:
// { state, model, questions: { surface_<ns>: noul } } -> answers[surface_<ns>].
// Same injectable-seam rule (§4): tests substitute the function or point the
// real scorer at a loopback fixture server.
// --------------------------------------------------------------------------

export interface NamespaceScorePayload {
  name: string;
  /** One `name: description` line per tool in the namespace. */
  descriptions: string;
}

export interface NamespaceScoreRequest {
  state: string;
  namespaces: readonly NamespaceScorePayload[];
}

export interface NamespaceScoreResult {
  /** Per-namespace score; null entry = unparseable answer for that
   *  namespace. Null map = whole-request failure (see `error`). */
  scores: Record<string, number | null> | null;
  inputTokens: number;
  latencyMs: number;
  error?: string;
}

export type JevNamespaceScoreFn = (
  request: NamespaceScoreRequest,
) => Promise<NamespaceScoreResult>;

/** Question key prefix; namespace names come from owner config. */
export function surfaceQuestionKey(namespace: string): string {
  return `surface_${namespace}`;
}

const SURFACE_CRITERIA = {
  true: "The conversation's task likely requires one of these tools or the user explicitly referenced them",
  false: "Unlikely to be needed for the current work",
} as const;

export function buildShouldSurfaceInstructions(
  namespace: string,
  descriptions: string,
): string {
  return `Below are the tool descriptions of the '${namespace}' tool namespace, one line per tool as 'name: description'. Should this namespace's tool schemas be included in the agent's available tools for the user's current work in the conversation state?\n\n--- TOOL DESCRIPTIONS ---\n${descriptions}`;
}

export function createJevNamespaceScorer(options: {
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}): JevNamespaceScoreFn {
  return async (request) => {
    const started = Date.now();
    const questions: Record<string, unknown> = {};
    for (const ns of request.namespaces) {
      questions[surfaceQuestionKey(ns.name)] = {
        type: "noul",
        instructions: buildShouldSurfaceInstructions(ns.name, ns.descriptions),
        criteria: SURFACE_CRITERIA,
      };
    }
    let response: Response;
    try {
      response = await fetch(options.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          state: request.state,
          model: options.model,
          questions,
        }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "unreachable";
      return {
        scores: null,
        inputTokens: 0,
        latencyMs: Date.now() - started,
        error: reason,
      };
    }
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return {
        scores: null,
        inputTokens: 0,
        latencyMs,
        error: `http_${response.status}`,
      };
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { scores: null, inputTokens: 0, latencyMs, error: "bad_response" };
    }
    const root = asRecord(data);
    const answers = asRecord(root?.answers);
    if (answers === null) {
      return { scores: null, inputTokens: 0, latencyMs, error: "bad_response" };
    }
    const usage = asRecord(root?.usage);
    const inputTokens =
      typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
    const scores: Record<string, number | null> = {};
    for (const ns of request.namespaces) {
      const noul = asRecord(answers[surfaceQuestionKey(ns.name)])?.noul;
      scores[ns.name] =
        typeof noul === "number" && !Number.isNaN(noul) ? noul : null;
    }
    return { scores, inputTokens, latencyMs };
  };
}

// --------------------------------------------------------------------------
// Policy: threshold + top-K, deterministic tie-break (score desc, name asc).
// --------------------------------------------------------------------------

export interface SkillScore {
  name: string;
  score: number;
}

function byScoreThenName(a: SkillScore, b: SkillScore): number {
  return b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export function selectSkillsToLoad(
  scores: readonly SkillScore[],
  threshold: number,
  topK: number,
): SkillScore[] {
  return scores
    .filter((s) => s.score >= threshold)
    .sort(byScoreThenName)
    .slice(0, topK);
}

// --------------------------------------------------------------------------
// Namespace resolution (Nozzle 2): owner config -> concrete tool lists,
// resolved against the tools Pi actually has this session. Explicit names
// that match nothing are reported as unknown (logged once per session);
// prefix matches are recomputed every boundary so late-registered tools
// (MCP, extensions) join their namespace without config edits.
// --------------------------------------------------------------------------

/** Structural minimum of Pi's ToolInfo needed here. */
export interface ToolSurfaceInfo {
  name: string;
  description: string;
}

export interface ResolvedNamespace {
  name: string;
  tools: string[];
  descriptions: string;
}

export function resolveNamespaces(
  namespaces: Readonly<Record<string, ToolNamespaceConfig>>,
  allTools: readonly ToolSurfaceInfo[],
): { resolved: ResolvedNamespace[]; unknown: Record<string, string[]> } {
  const byName = new Map(allTools.map((t) => [t.name, t]));
  const resolved: ResolvedNamespace[] = [];
  const unknown: Record<string, string[]> = {};
  for (const [name, ns] of Object.entries(namespaces)) {
    const names = new Set<string>();
    for (const toolName of ns.tools) {
      if (byName.has(toolName)) {
        names.add(toolName);
      } else {
        const list = unknown[name] ?? [];
        list.push(toolName);
        unknown[name] = list;
      }
    }
    if (ns.prefix !== undefined) {
      for (const t of allTools) {
        if (t.name.startsWith(ns.prefix)) names.add(t.name);
      }
    }
    const tools = [...names].sort();
    if (tools.length === 0) continue; // nothing to surface or score
    resolved.push({
      name,
      tools,
      descriptions: tools
        .map((t) => `${t}: ${byName.get(t)?.description ?? ""}`)
        .join("\n"),
    });
  }
  resolved.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { resolved, unknown };
}

// --------------------------------------------------------------------------
// Telemetry: append-only JSONL, one record per route decision or manual pin.
// The JSONL is the telemetry the thresholds tune from (§3.9); /skill_stats
// renders its aggregates. Writes are best-effort and loud on failure.
// --------------------------------------------------------------------------

export interface RouteDecisionRecord {
  event: "ROUTE_DECISION";
  ts: number;
  epoch: number;
  scores: Record<string, number>;
  loaded: string[];
  skipped_active: string[];
  evicted: string[];
  latency_ms: number;
  input_tokens: number;
}

export interface SkillPinnedRecord {
  event: "SKILL_PINNED";
  ts: number;
  epoch: number;
  skill: string;
}

export type TelemetryEvent = RouteDecisionRecord | SkillPinnedRecord;

/** Append one telemetry record as a JSONL line. Loud failure via `log`. */
export function appendTelemetry(
  file: string,
  record: TelemetryEvent,
  log: (line: string) => void,
): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch (error) {
    log(
      `TELEMETRY_WRITE_FAILED: path=${file} error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseTelemetryLine(line: string): TelemetryEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const rec = asRecord(raw);
  if (rec === null) return null;
  if (rec.event === "ROUTE_DECISION") {
    const scores = asRecord(rec.scores);
    if (
      typeof rec.epoch === "number" &&
      scores !== null &&
      Array.isArray(rec.loaded) &&
      Array.isArray(rec.skipped_active) &&
      Array.isArray(rec.evicted) &&
      typeof rec.latency_ms === "number" &&
      typeof rec.input_tokens === "number"
    ) {
      const numericScores: Record<string, number> = {};
      for (const [k, v] of Object.entries(scores)) {
        if (typeof v === "number") numericScores[k] = v;
      }
      return {
        event: "ROUTE_DECISION",
        ts: typeof rec.ts === "number" ? rec.ts : 0,
        epoch: rec.epoch,
        scores: numericScores,
        loaded: rec.loaded.filter((v): v is string => typeof v === "string"),
        skipped_active: rec.skipped_active.filter(
          (v): v is string => typeof v === "string",
        ),
        evicted: rec.evicted.filter((v): v is string => typeof v === "string"),
        latency_ms: rec.latency_ms,
        input_tokens: rec.input_tokens,
      };
    }
    return null;
  }
  if (rec.event === "SKILL_PINNED" && typeof rec.skill === "string") {
    return {
      event: "SKILL_PINNED",
      ts: typeof rec.ts === "number" ? rec.ts : 0,
      epoch: typeof rec.epoch === "number" ? rec.epoch : 0,
      skill: rec.skill,
    };
  }
  return null;
}

/** Render /skill_stats output: aggregates over the append-only JSONL log. */
export function renderSkillStats(telemetryFile: string): string {
  let raw: string;
  try {
    raw = readFileSync(telemetryFile, "utf8");
  } catch {
    return "jev-context: no telemetry recorded yet";
  }
  const events = raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map(parseTelemetryLine)
    .filter((e): e is TelemetryEvent => e !== null);
  const decisions = events.filter(
    (e): e is RouteDecisionRecord => e.event === "ROUTE_DECISION",
  );
  if (decisions.length === 0 && events.length === 0) {
    return "jev-context: no telemetry recorded yet";
  }
  const perSkill = new Map<
    string,
    { scored: number; loaded: number; evicted: number; scoreSum: number }
  >();
  const entryOf = (name: string) => {
    const existing = perSkill.get(name);
    if (existing) return existing;
    const created = { scored: 0, loaded: 0, evicted: 0, scoreSum: 0 };
    perSkill.set(name, created);
    return created;
  };
  let loads = 0;
  let evictions = 0;
  let inputTokens = 0;
  for (const d of decisions) {
    loads += d.loaded.length;
    evictions += d.evicted.length;
    inputTokens += d.input_tokens;
    for (const [name, score] of Object.entries(d.scores)) {
      const e = entryOf(name);
      e.scored += 1;
      e.scoreSum += score;
    }
    for (const name of d.loaded) entryOf(name).loaded += 1;
    for (const name of d.evicted) entryOf(name).evicted += 1;
  }
  const pins = events.filter((e) => e.event === "SKILL_PINNED").length;
  const header =
    `jev-context skill stats — route decisions: ${decisions.length}, ` +
    `loads: ${loads}, evictions: ${evictions}, manual pins: ${pins}, ` +
    `input tokens: ${inputTokens}`;
  const rows = [...perSkill.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, s]) => {
      const avg = s.scored === 0 ? 0 : s.scoreSum / s.scored;
      return `  ${name}: scored=${s.scored} loaded=${s.loaded} evicted=${s.evicted} avg_score=${avg.toFixed(2)}`;
    });
  return [header, ...rows].join("\n");
}

// --------------------------------------------------------------------------
// Injection: one synthetic user message at messages[0] — the position
// immediately after the system prompt in the provider payload — frozen
// byte-stable for the epoch (§3.4).
// --------------------------------------------------------------------------

export interface SkillPayload {
  name: string;
  body: string;
}

export function buildSkillInjection(
  skills: readonly SkillPayload[],
  now: number,
): UserMessage {
  const blocks = skills.map(
    (s) => `<skill name="${s.name}">\n${s.body}\n</skill>`,
  );
  const content = [
    "The following skills were routed into this conversation by",
    "jev-context. Their documentation below is active guidance for",
    "the work at hand.",
    "",
    ...blocks,
  ].join("\n");
  return { role: "user", content, timestamp: now };
}

/**
 * Return shape for the `context` seam (structurally identical to Pi's
 * ContextEventResult, which the package root does not export).
 */
export interface SkillInjectionResult {
  messages?: AgentMessage[];
}

// --------------------------------------------------------------------------
// Router: the Nozzle-1 state machine. Pure of Pi plumbing — handlers adapt.
// --------------------------------------------------------------------------

export interface SkillRouterDeps {
  catalog: readonly SkillEntry[];
  jevScore: JevScoreFn;
  apiKey: string | null;
  loadThreshold: number;
  topK: number;
  decayThreshold: number;
  decayIntervalTurns: number;
  digestCapBytes: number;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  log: (line: string) => void;
  recordTelemetry: (event: TelemetryEvent) => void;
  now: () => number;
}

/** Active-set entry: score at load, pin flag, user turns since load. */
interface ActiveSkill {
  score: number;
  pinned: boolean;
  turnsSinceLoad: number;
}

export interface SkillRouter {
  onBeforeAgentStart(input: {
    prompt: string;
    entries: readonly DigestEntry[];
    /** Prebuilt by the wiring when Nozzle 2 shares the boundary (one digest
     *  per epoch, frozen design); built from prompt+entries when absent. */
    digest?: string;
  }): Promise<void>;
  onContext(event: ContextEvent): SkillInjectionResult;
  onAgentSettled(): void;
  /**
   * Manual `/skill:<name>` load: activates the skill and pins it against
   * decay. Works without an API key (owner action, no Jev call). Returns
   * false for names not in the catalog.
   */
  manualLoad(name: string): boolean;
  /** Introspection seam for tests and `skill_stats`. */
  activeSkills(): readonly SkillScore[];
  /** Catalog skill names (command registration seam). */
  catalogSkills(): readonly string[];
}

export function createSkillRouter(deps: SkillRouterDeps): SkillRouter {
  let epoch = 0;
  let injection: UserMessage | null = null;
  const active = new Map<string, ActiveSkill>();
  const degradedNotified = new Set<string>();

  const sortedActive = (): SkillScore[] =>
    [...active.entries()]
      .map(([name, a]) => ({ name, score: a.score }))
      .sort(byScoreThenName);

  const degrade = (errorClass: string, detail: string): void => {
    deps.log(`ROUTE_DEGRADED: reason=${errorClass} ${detail} epoch=${epoch}`);
    if (!degradedNotified.has(errorClass)) {
      degradedNotified.add(errorClass);
      deps.notify(
        `jev-context: Jev scoring unavailable (${errorClass}); keeping the current skill set`,
        "warning",
      );
    }
  };

  const rebuildInjection = (): void => {
    const act = sortedActive();
    injection =
      act.length === 0
        ? null
        : buildSkillInjection(
            act.map((s) => ({
              name: s.name,
              body: deps.catalog.find((c) => c.name === s.name)?.body ?? "",
            })),
            deps.now(),
          );
  };

  return {
    activeSkills: () => sortedActive(),

    catalogSkills: () => deps.catalog.map((s) => s.name),

    manualLoad(name) {
      if (!deps.catalog.some((c) => c.name === name)) return false;
      const existing = active.get(name);
      active.set(name, {
        score: existing?.score ?? 1,
        pinned: true,
        turnsSinceLoad: 0,
      });
      deps.log(`SKILL_PINNED: skill=${name} epoch=${epoch}`);
      deps.recordTelemetry({
        event: "SKILL_PINNED",
        ts: deps.now(),
        epoch,
        skill: name,
      });
      rebuildInjection();
      return true;
    },

    async onBeforeAgentStart({ prompt, entries, digest: prebuilt }) {
      if (deps.apiKey === null) return; // absent mode (§5 cross-cutting)
      epoch += 1;
      for (const a of active.values()) a.turnsSinceLoad += 1;
      const skippedActive = sortedActive().map((s) => s.name);
      const digest =
        prebuilt ?? buildSessionDigest(entries, prompt, deps.digestCapBytes);
      // Skip-active: load scoring never re-scores active skills. The decay
      // re-check is the explicit exception: every decayIntervalTurns-th user
      // turn since load, a non-pinned active skill is re-scored once against
      // the current digest and evicted below decayThreshold.
      const loadCandidates = deps.catalog.filter((s) => !active.has(s.name));
      const decayCandidates = [...active.entries()]
        .filter(
          ([name, a]) =>
            !a.pinned &&
            a.turnsSinceLoad % deps.decayIntervalTurns === 0 &&
            deps.catalog.some((c) => c.name === name),
        )
        .map(([name]) => name);
      if (loadCandidates.length === 0 && decayCandidates.length === 0) {
        rebuildInjection();
        return;
      }
      const started = deps.now();
      const results = await Promise.all([
        ...loadCandidates.map((skill) =>
          deps.jevScore({
            state: digest,
            skillName: skill.name,
            skillBody: skill.body,
          }),
        ),
        ...decayCandidates.map((name) =>
          deps.jevScore({
            state: digest,
            skillName: name,
            skillBody: deps.catalog.find((c) => c.name === name)?.body ?? "",
          }),
        ),
      ]);
      const latencyMs = deps.now() - started;
      const loadScored: SkillScore[] = [];
      const decayScored: SkillScore[] = [];
      const evicted: string[] = [];
      let inputTokens = 0;
      for (let i = 0; i < loadCandidates.length; i++) {
        const r = results[i];
        inputTokens += r.inputTokens;
        if (r.score === null) {
          degrade(r.error ?? "unknown", `skill=${loadCandidates[i].name}`);
          continue;
        }
        loadScored.push({ name: loadCandidates[i].name, score: r.score });
      }
      for (let i = 0; i < decayCandidates.length; i++) {
        const r = results[loadCandidates.length + i];
        inputTokens += r.inputTokens;
        if (r.score === null) {
          // Fail-static: a skill is never evicted on an unknown score.
          degrade(r.error ?? "unknown", `decay_skill=${decayCandidates[i]}`);
          continue;
        }
        decayScored.push({ name: decayCandidates[i], score: r.score });
        if (r.score < deps.decayThreshold) {
          active.delete(decayCandidates[i]);
          evicted.push(decayCandidates[i]);
        }
      }
      // Policy (threshold + top-K) applies to load candidates only; decay
      // re-check scores are recorded but never (re)load a skill.
      const loaded = selectSkillsToLoad(
        loadScored,
        deps.loadThreshold,
        deps.topK,
      );
      for (const s of loaded) {
        active.set(s.name, {
          score: s.score,
          pinned: false,
          turnsSinceLoad: 0,
        });
      }
      const scored = [...loadScored, ...decayScored];
      const scoreMap: Record<string, number> = {};
      for (const s of scored) scoreMap[s.name] = s.score;
      deps.log(
        `ROUTE_DECISION: epoch=${epoch} scores={${scored.map((s) => `${s.name}:${s.score}`).join(",")}} loaded=[${loaded.map((s) => s.name).join(",")}] skipped_active=[${skippedActive.join(",")}] evicted=[${evicted.join(",")}] latency_ms=${latencyMs} input_tokens=${inputTokens}`,
      );
      deps.recordTelemetry({
        event: "ROUTE_DECISION",
        ts: deps.now(),
        epoch,
        scores: scoreMap,
        loaded: loaded.map((s) => s.name),
        skipped_active: skippedActive,
        evicted,
        latency_ms: latencyMs,
        input_tokens: inputTokens,
      });
      rebuildInjection();
    },

    onContext(event) {
      return injection === null
        ? {}
        : { messages: [injection, ...event.messages] };
    },

    onAgentSettled() {
      injection = null;
    },
  };
}

// --------------------------------------------------------------------------
// Tool surface router (Nozzle 2): the namespace state machine. Shares the
// digest and the `before_agent_start` epoch boundary with Nozzle 1 (built
// once by the wiring); pure of Pi plumbing — the tool-set seams are injected.
// Boundary-only mutation (§3.4): setActiveTools fires exclusively here, and
// only when the computed set actually changed.
// --------------------------------------------------------------------------

export interface ToolSurfaceRouterDeps {
  namespaces: Readonly<Record<string, ToolNamespaceConfig>>;
  /** Hardcoded floor ∪ owner config; never removed by routing. */
  coreTools: readonly string[];
  threshold: number;
  apiKey: string | null;
  jevNamespaceScore: JevNamespaceScoreFn;
  getAllTools: () => readonly ToolSurfaceInfo[];
  getActiveTools: () => readonly string[];
  setActiveTools: (names: string[]) => void;
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  log: (line: string) => void;
  now: () => number;
}

export interface ToolSurfaceRouter {
  onBeforeAgentStart(input: { digest: string }): Promise<void>;
  /** Namespaces whose tools are currently surfaced on (tests, telemetry). */
  activeNamespaces(): readonly string[];
}

function sameNameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name) => b.includes(name));
}

export function createToolSurfaceRouter(
  deps: ToolSurfaceRouterDeps,
): ToolSurfaceRouter {
  let epoch = 0;
  let active: string[] = [];
  const degradedNotified = new Set<string>();
  const unknownLogged = new Set<string>();

  const degrade = (errorClass: string, detail: string): void => {
    deps.log(
      `ROUTE_DEGRADED: reason=${errorClass} nozzle=tools ${detail} epoch=${epoch}`,
    );
    if (!degradedNotified.has(errorClass)) {
      degradedNotified.add(errorClass);
      deps.notify(
        `jev-context: Jev scoring unavailable (${errorClass}); all tool namespaces stay visible`,
        "warning",
      );
    }
  };

  /** Fail-static restore: every configured namespace visible (Pi default). */
  const restoreAll = (
    resolved: readonly ResolvedNamespace[],
    current: readonly string[],
  ): void => {
    const next = [...current];
    for (const ns of resolved) {
      for (const tool of ns.tools) {
        if (!next.includes(tool)) next.push(tool);
      }
    }
    if (!sameNameSet(next, current)) deps.setActiveTools(next);
  };

  return {
    activeNamespaces: () => active,

    async onBeforeAgentStart({ digest }) {
      if (deps.apiKey === null) return; // absent mode: behaves as if absent
      if (Object.keys(deps.namespaces).length === 0) return; // no opinions shipped
      epoch += 1;
      const { resolved, unknown } = resolveNamespaces(
        deps.namespaces,
        deps.getAllTools(),
      );
      for (const [ns, names] of Object.entries(unknown)) {
        for (const toolName of names) {
          const key = `${ns}:${toolName}`;
          if (unknownLogged.has(key)) continue;
          unknownLogged.add(key);
          deps.log(
            `TOOL_SURFACE_CONFIG: namespace=${ns} unknown_tool=${toolName}`,
          );
        }
      }
      if (resolved.length === 0) return; // nothing resolved: no mutation
      const current = [...deps.getActiveTools()];
      const result = await deps.jevNamespaceScore({
        state: digest,
        namespaces: resolved.map((r) => ({
          name: r.name,
          descriptions: r.descriptions,
        })),
      });
      if (result.scores === null) {
        // Whole-request failure: fail-static (§3.5), Pi default visibility.
        degrade(result.error ?? "unknown", "batch");
        restoreAll(resolved, current);
        active = resolved.map((r) => r.name);
        return;
      }
      const scores: Record<string, number> = {};
      const visible = new Set<string>();
      const inactiveTools = new Set<string>();
      const nextActive: string[] = [];
      for (const ns of resolved) {
        const score = result.scores[ns.name];
        if (score === null || score === undefined) {
          // Per-namespace parse gap: fail-static for that namespace.
          degrade("bad_response", `namespace=${ns.name}`);
          for (const t of ns.tools) visible.add(t);
          nextActive.push(ns.name);
          continue;
        }
        scores[ns.name] = score;
        if (score >= deps.threshold) {
          nextActive.push(ns.name);
          for (const t of ns.tools) visible.add(t);
        } else {
          for (const t of ns.tools) inactiveTools.add(t);
        }
      }
      // Core is never routed (§5): never removed, force-present if Pi has it.
      const available = new Set(deps.getAllTools().map((t) => t.name));
      for (const core of deps.coreTools) {
        inactiveTools.delete(core);
        if (available.has(core)) visible.add(core);
      }
      // A tool in two namespaces stays visible if either namespace is on.
      const hidden = new Set([...inactiveTools].filter((t) => !visible.has(t)));
      const next = current.filter((t) => !hidden.has(t));
      for (const t of [...visible].sort()) {
        if (!next.includes(t)) next.push(t);
      }
      if (!sameNameSet(next, current)) deps.setActiveTools(next);
      active = nextActive;
      deps.log(
        `TOOL_SURFACE: epoch=${epoch} active=[${nextActive.join(",")}] scores={${Object.entries(
          scores,
        )
          .map(([k, v]) => `${k}:${v}`)
          .join(",")}}`,
      );
    },
  };
}

// --------------------------------------------------------------------------
// Pi wiring: init on every session_start (config, key, catalog re-derived;
// session switches and reloads get a fresh router), adapt events to router.
// --------------------------------------------------------------------------

export interface JevContextDeps {
  homeDir: string;
  env: Record<string, string | undefined>;
  now: () => number;
  log: (line: string) => void;
  /** Test seam: replaces the real Jev client entirely. */
  jevScore?: JevScoreFn;
  /** Test seam: replaces the real batched namespace client entirely. */
  jevNamespaceScore?: JevNamespaceScoreFn;
  /**
   * Tool-set seams (pi.getAllTools/getActiveTools/setActiveTools). When
   * absent, Nozzle 2 is inert and Nozzle 1 behaves exactly as before.
   */
  tools?: ToolSurfaceSeams;
}

export interface ToolSurfaceSeams {
  getAllTools: () => readonly ToolSurfaceInfo[];
  getActiveTools: () => readonly string[];
  setActiveTools: (names: string[]) => void;
}

export interface JevContextHandlers {
  onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): void;
  onBeforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext,
  ): Promise<void>;
  onContext(event: ContextEvent): SkillInjectionResult;
  onAgentSettled(): void;
  /** Manual `/skill:<name>` load: active + pinned against decay. */
  manualLoad(name: string): boolean;
  /** Current session's catalog skill names (for command registration). */
  catalogSkills(): readonly string[];
  /** Aggregate render for the `skill_stats` command. */
  renderStats(): string;
}

/** Command registration surface (pi.registerCommand), injectable for tests. */
export type CommandRegistrar = (
  name: string,
  options: {
    description: string;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  },
) => void;

export function createJevContextExtension(
  deps: JevContextDeps,
  registerCommand?: CommandRegistrar,
): JevContextHandlers {
  let router: SkillRouter | null = null;
  let toolRouter: ToolSurfaceRouter | null = null;
  let telemetryFile = defaultTelemetryFile(deps.homeDir);
  let digestCapBytes = DEFAULT_DIGEST_CAP_BYTES;
  const registeredSkills = new Set<string>();

  const build = (ctx: ExtensionContext): SkillRouter => {
    const { config, warnings } = loadConfig({
      userConfigPath: join(deps.homeDir, ".pi", "agent", "jev-context.json"),
      projectConfigPath: join(ctx.cwd, ".pi", "jev-context.json"),
      homeDir: deps.homeDir,
      cwd: ctx.cwd,
    });
    for (const w of warnings) ctx.ui.notify(`jev-context: ${w}`, "warning");
    telemetryFile = config.telemetryFile;
    digestCapBytes = config.digestCapBytes;
    const apiKey = resolveApiKey(config, deps.env);
    if (apiKey === null) {
      ctx.ui.notify(
        `jev-context: no Jev API key (set $${config.apiKeyEnv} or apiKeyFile in config); skill routing and tool surfacing disabled`,
        "warning",
      );
    }
    const jevScore: JevScoreFn =
      deps.jevScore ??
      (apiKey === null
        ? () =>
            Promise.resolve({
              score: null,
              inputTokens: 0,
              latencyMs: 0,
              error: "no_api_key",
            })
        : createJevScorer({
            endpoint: config.endpoint,
            model: config.model,
            apiKey,
            timeoutMs: config.requestTimeoutMs,
          }));
    const jevNamespaceScore: JevNamespaceScoreFn =
      deps.jevNamespaceScore ??
      (apiKey === null
        ? () =>
            Promise.resolve({
              scores: null,
              inputTokens: 0,
              latencyMs: 0,
              error: "no_api_key",
            })
        : createJevNamespaceScorer({
            endpoint: config.endpoint,
            model: config.model,
            apiKey,
            timeoutMs: config.requestTimeoutMs,
          }));
    const catalog = scanSkillCatalog(config.skillRoots);
    router = createSkillRouter({
      catalog,
      jevScore,
      apiKey,
      loadThreshold: config.loadThreshold,
      topK: config.topK,
      decayThreshold: config.decayThreshold,
      decayIntervalTurns: config.decayIntervalTurns,
      digestCapBytes: config.digestCapBytes,
      notify: (message, type) => ctx.ui.notify(message, type),
      log: deps.log,
      recordTelemetry: (event) =>
        appendTelemetry(telemetryFile, event, deps.log),
      now: deps.now,
    });
    toolRouter =
      deps.tools === undefined
        ? null
        : createToolSurfaceRouter({
            namespaces: config.toolNamespaces,
            coreTools: config.coreTools,
            threshold: config.toolSurfaceThreshold,
            apiKey,
            jevNamespaceScore,
            getAllTools: deps.tools.getAllTools,
            getActiveTools: deps.tools.getActiveTools,
            setActiveTools: deps.tools.setActiveTools,
            notify: (message, type) => ctx.ui.notify(message, type),
            log: deps.log,
            now: deps.now,
          });
    // Per-skill manual-load commands, named after Pi's native skill-command
    // convention (`/skill:<name>`). Registered once per skill name across
    // sessions; the handler always targets the live router.
    if (registerCommand !== undefined) {
      for (const skill of catalog) {
        if (registeredSkills.has(skill.name)) continue;
        registeredSkills.add(skill.name);
        const name = skill.name;
        registerCommand(`skill:${name}`, {
          description: `jev-context: load and pin the '${name}' skill`,
          handler: async (_args, cmdCtx) => {
            const ok = router?.manualLoad(name) ?? false;
            cmdCtx.ui.notify(
              ok
                ? `jev-context: skill '${name}' loaded and pinned`
                : `jev-context: skill '${name}' is not available`,
              ok ? "info" : "error",
            );
          },
        });
      }
    }
    return router;
  };

  registerCommand?.("skill_stats", {
    description: "jev-context: skill routing statistics",
    handler: async (_args, cmdCtx) => {
      cmdCtx.ui.notify(renderSkillStats(telemetryFile), "info");
    },
  });

  return {
    // Every session_start is a full reset: fresh catalog scan, config,
    // active set. Covers startup, reload, new, resume, and fork.
    onSessionStart(_event, ctx) {
      router = build(ctx);
    },
    async onBeforeAgentStart(event, ctx) {
      // Defensive lazy init only; session_start has normally fired first.
      if (router === null) router = build(ctx);
      const entries = ctx.sessionManager.getBranch();
      // One digest per boundary, shared by both nozzles (frozen design):
      // built here, handed to the skill pass and the namespace pass alike.
      const digest = buildSessionDigest(entries, event.prompt, digestCapBytes);
      await Promise.all([
        router.onBeforeAgentStart({ prompt: event.prompt, entries, digest }),
        toolRouter === null
          ? Promise.resolve()
          : toolRouter.onBeforeAgentStart({ digest }),
      ]);
    },
    onContext(event) {
      return router === null ? {} : router.onContext(event);
    },
    onAgentSettled() {
      router?.onAgentSettled();
    },
    manualLoad(name) {
      return router === null ? false : router.manualLoad(name);
    },
    catalogSkills() {
      return router === null ? [] : router.catalogSkills();
    },
    renderStats() {
      return renderSkillStats(telemetryFile);
    },
  };
}

/** Pi extension factory: wires the router to the event and command seams. */
export default function jevContext(pi: ExtensionAPI): void {
  const handlers = createJevContextExtension(
    {
      homeDir: homedir(),
      env: process.env,
      now: () => Date.now(),
      log: (line) => console.error(line),
      tools: {
        getAllTools: () => pi.getAllTools(),
        getActiveTools: () => pi.getActiveTools(),
        setActiveTools: (names) => pi.setActiveTools(names),
      },
    },
    (name, options) => pi.registerCommand(name, options),
  );
  pi.on("session_start", handlers.onSessionStart);
  pi.on("before_agent_start", handlers.onBeforeAgentStart);
  pi.on("context", handlers.onContext);
  pi.on("agent_settled", handlers.onAgentSettled);
}
