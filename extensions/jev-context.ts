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
 *   logged (§3.5); a single transient 429 freezes the current set, repeated
 *   429s fail static. Escape hatch: a tool call answered with Pi's
 *   synthesized "Tool <name> not found" result (detected on `message_end`)
 *   force-surfaces the owning namespace at the next boundary
 *   (TOOL_SURFACE_MISS). Every boundary appends a TOOL_SURFACE record to the
 *   telemetry JSONL.
 * Nozzle 3 — epoch pruning: at `agent_settled` the closed epoch (branch
 *   entries since the last user message) is captured and every complete
 *   tool call/result pair in it is judged in ONE batched Jev request —
 *   state = the epoch (user message, assistant text/thinking, tool call
 *   names/args, and the outputs under judgment; oversized outputs are
 *   head+tail excerpted, which is input preparation, not a helpfulness
 *   rule), one noul per pair ("Given how this turn concluded, is this tool
 *   output helpful to subsequent turns?"). Verdicts are cached by the
 *   pair's toolCall id and judged once ever, never mid-loop; the cache
 *   carries the session entry ids of both sides of each pair. Code owns
 *   mechanics only; every helpfulness decision is Jev's (owner's ruling).
 *   Application happens at the next user-turn boundary (awaiting any
 *   in-flight judge pass), in one of two modes feature-detected per
 *   session: on Pi ≥ 0.87 (appendContextEdit present) each pruned pair
 *   lands as append-only `context_edit` entries — the toolResult entry
 *   omitted, the owning assistant entry's content replaced with its
 *   parts minus the pruned toolCall part(s) (thinking/text kept
 *   verbatim, zero parts left = omitted) — durable across resume, with
 *   the raw transcript never modified (§3.3), and existing context_edit
 *   targets on the branch seed the pruner at session_start so they are
 *   never re-judged; on Pi < 0.87 the frozen applied set filters the
 *   deep-copied message list of the `context` event instead — the
 *   toolCall part and its whole toolResult message removed, every
 *   thinking/text part remaining — with identical model-visible results.
 *   The applied set is byte-stable within the epoch (§3.4); new verdicts
 *   apply only at the next boundary. Every judged epoch appends a
 *   PRUNE_JUDGED record, every boundary that applies new verdicts appends
 *   a PRUNE_EPOCH record (mode/judged/pruned/kept/tokens_reclaimed/edits/
 *   scores) to the telemetry JSONL, and the session's prune mode is logged
 *   once as PRUNE_MODE. Fail-static: judge failures log ROUTE_DEGRADED,
 *   notify once per error class, and cache nothing (zero pruning = Pi
 *   native).
 * Events used: `session_start` (init: config, API key, catalog scan,
 *   fail-static tool baseline, context_edit resume seeding),
 *   `before_agent_start` (digest + both scoring passes + injection rebuild +
 *   tool-set application + prune application at the boundary),
 *   `context` (skill injection; pair filtering only in filter mode),
 *   `agent_settled` (close epoch + Nozzle-3 epoch judgment), `message_end`
 *   (unknown-tool miss detection).
 * State owned: skill catalog cache, active-skill set (name -> score, pinned
 *   flag, turns since load), the per-epoch frozen injection message, namespace
 *   active set, pending namespace misses, the prune verdict cache (toolCall
 *   id -> verdict with entry ids) and its frozen per-epoch applied set
 *   (filter mode), the edited-target set (edit mode), once-per-reason
 *   degradation marks,
 *   once-per-name config logs, epoch counters, and the append-only telemetry
 *   JSONL. All session state rebuilds on `session_start` (any reason).
 * Commands: `skill:<name>` per catalog skill (manual load, pinned against
 *   decay — mirrors Pi's native skill-command naming), `skill_stats`.
 * Config: `~/.pi/agent/jev-context.json` then `<cwd>/.pi/jev-context.json`;
 *   the API key comes from the config-named env var (default
 *   $PI_TYPESAFE_JEV) or the config-named file. The key is never logged (§3.6).
 *   `toolNamespaces` maps namespace -> { tools, prefix } (owner rules, §3.8 —
 *   the extension ships no bundle opinions); `coreTools` extends the
 *   hardcoded core floor; `toolSurfaceThreshold` gates namespaces.
 *   `pruneStateCapBytes` bounds the batched judgment state;
 *   `pruneThreshold` is the helpfulness score at or below which a pair is
 *   pruned.
 * Invariants (VERIFYING.md): raw session entries are never modified — the
 *   transcript stays append-only (§3.3); injection is byte-stable within an
 *   epoch (§3.4); degradation is loud — notify once per reason, log
 *   ROUTE_DEGRADED, keep the current set (§3.5); boundary events emit
 *   structured logs (§3.9).
 */

import type { Dirent } from "node:fs";
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  TextContent,
  ThinkingContent,
  UserMessage,
} from "@earendil-works/pi-ai";
import type {
  AgentSettledEvent,
  BeforeAgentStartEvent,
  ContextEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  MessageEndEvent,
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
  /**
   * When true, structured log lines (ROUTE_DECISION, TOOL_SURFACE, …) also go
   * to stderr. Default false: the TUI paints extension stderr near the input
   * bar, which is noise. The JSONL telemetry file is always on regardless.
   */
  consoleLog: boolean;
  skillRoots: string[];
  toolNamespaces: Record<string, ToolNamespaceConfig>;
  toolSurfaceThreshold: number;
  coreTools: string[];
  pruneThreshold: number;
  pruneStateCapBytes: number;
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

/** Judgment-state budget: safely under the measured 32k-token state wall. */
export const DEFAULT_PRUNE_STATE_CAP_BYTES = 60_000;

/** Frozen design: prune at >= 0.8 confidence of "not helpful" (score <= 0.2). */
export const DEFAULT_PRUNE_THRESHOLD = 0.2;

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
    consoleLog: false,
    skillRoots: defaultSkillRoots(homeDir, cwd),
    toolNamespaces: {},
    toolSurfaceThreshold: 0.6,
    coreTools: [...CORE_TOOLS],
    pruneThreshold: DEFAULT_PRUNE_THRESHOLD,
    pruneStateCapBytes: DEFAULT_PRUNE_STATE_CAP_BYTES,
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
  if (typeof r.consoleLog === "boolean") out.consoleLog = r.consoleLog;
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
  if (typeof r.pruneThreshold === "number") {
    out.pruneThreshold = r.pruneThreshold;
  }
  if (typeof r.pruneStateCapBytes === "number") {
    out.pruneStateCapBytes = r.pruneStateCapBytes;
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
  /** Session entry id — present on real SessionManager branch entries; the
   *  context-edit prune path (Pi ≥ 0.87) targets entries by it. */
  id?: string;
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
// Batched prune client (Nozzle 3): ONE Jev request per closed epoch carrying
// one noul per tool call/result pair under judgment. State = the whole epoch
// (user message, assistant text/thinking, tool call names/args, and the
// outputs under judgment — oversized outputs head+tail excerpted upstream,
// which is input preparation, not a helpfulness rule). Question shape from
// the frozen design: "Given how this turn concluded, is this tool output
// helpful to subsequent turns?" Same injectable-seam rule (§4): tests
// substitute the function or point the real judge at a fixture server.
// --------------------------------------------------------------------------

export interface PrunePairPayload {
  /** toolCall id of the pair — question key and verdict-cache key. */
  id: string;
  toolName: string;
  /** 1-based position of the pair's call within the epoch. */
  ordinal: number;
  /** True when the state shows a head+tail excerpt of this output. */
  excerpted: boolean;
}

export interface PruneJudgeRequest {
  state: string;
  pairs: readonly PrunePairPayload[];
}

export interface PruneJudgeResult {
  /** Per-pair helpfulness score; null entry = unparseable answer for that
   *  pair. Null map = whole-request failure (see `error`). */
  scores: Record<string, number | null> | null;
  inputTokens: number;
  latencyMs: number;
  error?: string;
}

export type JevPruneJudgeFn = (
  request: PruneJudgeRequest,
) => Promise<PruneJudgeResult>;

/** Question key prefix; pair ids come from provider tool calls. */
export function pruneQuestionKey(pairId: string): string {
  return `pair_${pairId}`;
}

const PRUNE_CRITERIA = {
  true: "The output carries information that subsequent turns in this conversation need",
  false:
    "The output is dead weight: subsequent turns do not need anything in it",
} as const;

export function buildPruneJudgeInstructions(pair: PrunePairPayload): string {
  const question = `Tool call #${pair.ordinal} ('${pair.toolName}') in the conversation state produced the output under judgment. Given how this turn concluded, is this tool output helpful to subsequent turns?`;
  return pair.excerpted
    ? `${question} The output was too large for the state budget: only its head and tail are shown, with the omitted middle marked.`
    : question;
}

export function createJevPruneJudge(options: {
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}): JevPruneJudgeFn {
  return async (request) => {
    const started = Date.now();
    const questions: Record<string, unknown> = {};
    for (const pair of request.pairs) {
      questions[pruneQuestionKey(pair.id)] = {
        type: "noul",
        instructions: buildPruneJudgeInstructions(pair),
        criteria: PRUNE_CRITERIA,
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
    for (const pair of request.pairs) {
      const noul = asRecord(answers[pruneQuestionKey(pair.id)])?.noul;
      scores[pair.id] =
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
// Epoch capture + judgment-state render (Nozzle 3): the closed epoch is the
// slice of branch entries after the last user message entry. Judgment units
// are the COMPLETE tool call/result pairs inside that slice (hindsight: the
// outcome is visible); a call without its result, or a result whose call
// lies outside the slice, is never judged. The pair's toolCall id is the
// message id that survives into the context-event message copy —
// AgentMessage carries no entry id — so verdicts are keyed by it. Rendering
// is pure input preparation: fixed conversation lines first, then each
// output within an equal share of the remaining byte budget, oversized
// outputs as head+tail excerpts with the omission marked.
// --------------------------------------------------------------------------

export interface EpochPair {
  /** toolCall id — the verdict-cache key ("message id" of the pair). */
  id: string;
  toolName: string;
  /** 1-based position of the pair's call within the epoch. */
  ordinal: number;
  /** Full text of the tool result (text parts joined). */
  output: string;
  outputBytes: number;
  /** Byte size of the toolCall part JSON; feeds the tokens_reclaimed estimate. */
  callBytes: number;
  /** Session entry id of the assistant message owning the call. */
  assistantEntryId?: string;
  /** Session entry id of the pair's toolResult message. */
  resultEntryId?: string;
  /** The owning assistant entry's full content at capture — the base the
   *  replacement edit (Pi ≥ 0.87) subtracts pruned toolCall parts from. */
  assistantContent?: AssistantMessage["content"];
}

/** Chronological epoch content: rendered text lines and tool calls. */
export type EpochSegment =
  | { kind: "text"; line: string }
  | {
      kind: "call";
      id: string;
      ordinal: number;
      toolName: string;
      args: string;
    };

export interface CapturedEpoch {
  /** Text of the user message that opened the epoch. */
  userText: string;
  segments: EpochSegment[];
  /** Complete call/result pairs of the epoch, in call order. */
  pairs: EpochPair[];
}

export function captureEpochPairs(
  entries: readonly DigestEntry[],
): CapturedEpoch | null {
  let anchor = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = entries[i].message;
    if (entries[i].type === "message" && message?.role === "user") {
      anchor = i;
      break;
    }
  }
  if (anchor === -1) return null;
  const anchorMessage = entries[anchor].message;
  const userText =
    anchorMessage === undefined
      ? ""
      : digestChunksOf(anchorMessage)
          .map((c) => c.text)
          .join("\n");
  const segments: EpochSegment[] = [];
  if (userText) segments.push({ kind: "text", line: `[user] ${userText}\n` });
  const pairs: EpochPair[] = [];
  const open = new Map<string, EpochPair>();
  let calls = 0;
  for (let i = anchor + 1; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message === undefined) continue;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text") {
          if (part.text) {
            segments.push({
              kind: "text",
              line: `[assistant] ${part.text}\n`,
            });
          }
        } else if (part.type === "thinking") {
          if (part.thinking) {
            segments.push({
              kind: "text",
              line: `[assistant thinking] ${part.thinking}\n`,
            });
          }
        } else if (part.type === "toolCall") {
          calls += 1;
          segments.push({
            kind: "call",
            id: part.id,
            ordinal: calls,
            toolName: part.name,
            args: JSON.stringify(part.arguments),
          });
          open.set(part.id, {
            id: part.id,
            toolName: part.name,
            ordinal: calls,
            output: "",
            outputBytes: 0,
            callBytes: Buffer.byteLength(JSON.stringify(part), "utf8"),
            assistantEntryId: entry.id,
            assistantContent: message.content,
          });
        }
      }
    } else if (message.role === "toolResult") {
      const pair = open.get(message.toolCallId);
      if (pair === undefined) continue; // call outside the slice: not ours
      const output = message.content
        .filter((p): p is TextContent => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      pair.output = output;
      pair.outputBytes = Buffer.byteLength(output, "utf8");
      pair.resultEntryId = entry.id;
      pairs.push(pair);
      open.delete(message.toolCallId);
    }
  }
  pairs.sort((a, b) => a.ordinal - b.ordinal);
  return { userText, segments, pairs };
}

/** Floor per-output excerpt budget; wins over the cap in degenerate configs
 *  (input preparation only — never a prune decision). */
const MIN_OUTPUT_EXCERPT_BYTES = 1024;

function headUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

function tailUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString("utf8");
}

/** Drop the oldest bytes, keeping a UTF-8-safe tail behind an ellipsis. */
function clipUtf8Front(text: string, budgetBytes: number): string {
  return `…${tailUtf8(text, Math.max(0, budgetBytes - 3))}`;
}

function omissionMarker(omittedBytes: number): string {
  return `\n[… ${omittedBytes} bytes omitted …]\n`;
}

/** Head+tail excerpt within budget; the marker reports the true omission. */
function headTailExcerpt(
  output: string,
  outputBytes: number,
  budgetBytes: number,
): string {
  // Marker digits: upper-bound the omission (outputBytes) so the rendered
  // marker never overflows the budget when the real omission has fewer digits.
  const markerBytes = Buffer.byteLength(omissionMarker(outputBytes), "utf8");
  const head = Math.max(0, Math.floor((budgetBytes - markerBytes) / 2));
  const tail = Math.max(0, budgetBytes - markerBytes - head);
  const headText = headUtf8(output, head);
  const tailText = tailUtf8(output, tail);
  const omitted =
    outputBytes -
    Buffer.byteLength(headText, "utf8") -
    Buffer.byteLength(tailText, "utf8");
  return `${headText}${omissionMarker(omitted)}${tailText}`;
}

export interface RenderedPruneState {
  state: string;
  /** Pairs as presented in the state, with excerpt marks (judge payloads). */
  pairs: PrunePairPayload[];
}

export function renderPruneState(
  captured: CapturedEpoch,
  capBytes: number,
): RenderedPruneState {
  const callLine = (seg: Extract<EpochSegment, { kind: "call" }>): string =>
    `[tool_call #${seg.ordinal} ${seg.toolName}] ${seg.args}\n`;
  let fixedBytes = 0;
  for (const seg of captured.segments) {
    fixedBytes += Buffer.byteLength(
      seg.kind === "text" ? seg.line : callLine(seg),
      "utf8",
    );
  }
  // Outputs share what the fixed lines leave; the floor keeps every excerpt
  // judgeable. Fixed content over budget is clipped from the front (oldest
  // first) at emit time — the hard backstop that keeps state <= capBytes.
  const reserve = captured.pairs.length * MIN_OUTPUT_EXCERPT_BYTES;
  const fixedBudget = Math.max(0, capBytes - reserve);
  const clipping = fixedBytes > fixedBudget;
  const perOutput =
    captured.pairs.length === 0
      ? 0
      : Math.max(
          MIN_OUTPUT_EXCERPT_BYTES,
          Math.floor(
            (capBytes - Math.min(fixedBytes, fixedBudget)) /
              captured.pairs.length,
          ),
        );
  const outputs = new Map<string, { text: string; excerpted: boolean }>();
  const payloads: PrunePairPayload[] = [];
  for (const pair of captured.pairs) {
    const excerpted = pair.outputBytes > perOutput;
    outputs.set(pair.id, {
      text: excerpted
        ? headTailExcerpt(pair.output, pair.outputBytes, perOutput)
        : pair.output,
      excerpted,
    });
    payloads.push({
      id: pair.id,
      toolName: pair.toolName,
      ordinal: pair.ordinal,
      excerpted,
    });
  }
  const lines: string[] = [];
  for (const seg of captured.segments) {
    if (seg.kind === "text") {
      lines.push(seg.line);
      continue;
    }
    lines.push(callLine(seg));
    const rendered = outputs.get(seg.id);
    if (rendered !== undefined) {
      lines.push(
        `[tool_result #${seg.ordinal} ${seg.toolName}] ${rendered.text}\n`,
      );
    }
  }
  let state = lines.join("");
  if (clipping) state = clipUtf8Front(state, capBytes);
  return { state, pairs: payloads };
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

export interface ToolSurfaceRecord {
  event: "TOOL_SURFACE";
  ts: number;
  epoch: number;
  active: string[];
  /** Namespaces force-surfaced by the miss-recovery escape hatch. */
  forced: string[];
  scores: Record<string, number>;
  latency_ms: number;
  input_tokens: number;
  /** Error class when the epoch ran fail-static instead of scored. */
  degraded?: string;
}

export interface PruneJudgedRecord {
  event: "PRUNE_JUDGED";
  ts: number;
  epoch: number;
  judged: number;
  /** Helpfulness scores keyed by `#<ordinal>` within the judged epoch. */
  scores: Record<string, number>;
  latency_ms: number;
  input_tokens: number;
}

export interface PruneEpochRecord {
  event: "PRUNE_EPOCH";
  ts: number;
  epoch: number;
  /** Verdicts newly applied at this boundary. */
  judged: number;
  pruned: number;
  kept: number;
  /** Estimated tokens of the removed content (toolCall part JSON plus
   *  toolResult content) at 3.5 bytes/token; telemetry only. */
  tokens_reclaimed: number;
  /** context_edit entry ids appended at this boundary ([] in filter mode). */
  edits: string[];
  /** Application mode: durable edits (Pi ≥ 0.87) or the filter fallback. */
  mode: "context_edit" | "context_filter";
  /** Newly applied helpfulness scores, by toolCall id. */
  scores: Record<string, number>;
}

export type TelemetryEvent =
  | RouteDecisionRecord
  | SkillPinnedRecord
  | ToolSurfaceRecord
  | PruneJudgedRecord
  | PruneEpochRecord;

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
  if (rec.event === "TOOL_SURFACE") {
    const scores = asRecord(rec.scores);
    if (
      typeof rec.epoch === "number" &&
      Array.isArray(rec.active) &&
      Array.isArray(rec.forced) &&
      scores !== null &&
      typeof rec.latency_ms === "number" &&
      typeof rec.input_tokens === "number"
    ) {
      const numericScores: Record<string, number> = {};
      for (const [k, v] of Object.entries(scores)) {
        if (typeof v === "number") numericScores[k] = v;
      }
      return {
        event: "TOOL_SURFACE",
        ts: typeof rec.ts === "number" ? rec.ts : 0,
        epoch: rec.epoch,
        active: rec.active.filter((v): v is string => typeof v === "string"),
        forced: rec.forced.filter((v): v is string => typeof v === "string"),
        scores: numericScores,
        latency_ms: rec.latency_ms,
        input_tokens: rec.input_tokens,
        ...(typeof rec.degraded === "string" ? { degraded: rec.degraded } : {}),
      };
    }
    return null;
  }
  if (rec.event === "PRUNE_JUDGED") {
    const scores = asRecord(rec.scores);
    if (
      typeof rec.epoch === "number" &&
      typeof rec.judged === "number" &&
      scores !== null &&
      typeof rec.latency_ms === "number" &&
      typeof rec.input_tokens === "number"
    ) {
      const numericScores: Record<string, number> = {};
      for (const [k, v] of Object.entries(scores)) {
        if (typeof v === "number") numericScores[k] = v;
      }
      return {
        event: "PRUNE_JUDGED",
        ts: typeof rec.ts === "number" ? rec.ts : 0,
        epoch: rec.epoch,
        judged: rec.judged,
        scores: numericScores,
        latency_ms: rec.latency_ms,
        input_tokens: rec.input_tokens,
      };
    }
    return null;
  }
  if (rec.event === "PRUNE_EPOCH") {
    const scores = asRecord(rec.scores);
    if (
      typeof rec.epoch === "number" &&
      typeof rec.judged === "number" &&
      typeof rec.pruned === "number" &&
      typeof rec.kept === "number" &&
      typeof rec.tokens_reclaimed === "number" &&
      scores !== null
    ) {
      const numericScores: Record<string, number> = {};
      for (const [k, v] of Object.entries(scores)) {
        if (typeof v === "number") numericScores[k] = v;
      }
      return {
        event: "PRUNE_EPOCH",
        ts: typeof rec.ts === "number" ? rec.ts : 0,
        epoch: rec.epoch,
        judged: rec.judged,
        pruned: rec.pruned,
        kept: rec.kept,
        tokens_reclaimed: rec.tokens_reclaimed,
        scores: numericScores,
        // Pre-mode records parse as the filter fallback they were.
        edits: Array.isArray(rec.edits)
          ? rec.edits.filter((v): v is string => typeof v === "string")
          : [],
        mode: rec.mode === "context_edit" ? "context_edit" : "context_filter",
      };
    }
    return null;
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
  recordTelemetry: (event: TelemetryEvent) => void;
  now: () => number;
}

export interface ToolSurfaceRouter {
  /**
   * Fail-static baseline: every configured namespace visible before the
   * first boundary routes. No-op on a fresh Pi session (Pi default = all
   * visible); corrects stale routing after a reload, and IS the fail-static
   * behavior when the API key is missing (§3.5).
   */
  onSessionStart(): void;
  onBeforeAgentStart(input: { digest: string }): Promise<void>;
  /**
   * Escape hatch (frozen design): Pi's agent loop answers calls to unknown
   * tools with a synthesized `Tool <name> not found` error result. Detecting
   * one here force-surfaces the owning namespace at the next boundary.
   */
  onMessageEnd(message: AgentMessage): void;
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
  let consecutive429 = 0;
  const degradedNotified = new Set<string>();
  const unknownLogged = new Set<string>();
  /** Pending miss recovery: namespace -> tool name that was not found. */
  const missedNamespaces = new Map<string, string>();
  const unconfiguredLogged = new Set<string>();

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

    onSessionStart() {
      if (Object.keys(deps.namespaces).length === 0) return;
      const { resolved } = resolveNamespaces(
        deps.namespaces,
        deps.getAllTools(),
      );
      restoreAll(resolved, deps.getActiveTools());
    },

    onMessageEnd(message) {
      if (deps.apiKey === null) return; // absent mode: nothing was routed off
      if (Object.keys(deps.namespaces).length === 0) return;
      if (message.role !== "toolResult" || !message.isError) return;
      const text = message.content
        .filter((p): p is TextContent => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();
      // Exact shape of Pi's synthesized unknown-tool result (pi-agent-core
      // agent-loop.js: createErrorToolResult(`Tool ${name} not found`)).
      if (text !== `Tool ${message.toolName} not found`) return;
      const { resolved } = resolveNamespaces(
        deps.namespaces,
        deps.getAllTools(),
      );
      const hit = resolved.find((ns) => ns.tools.includes(message.toolName));
      if (hit !== undefined) {
        missedNamespaces.set(hit.name, message.toolName);
        return;
      }
      // Not ours to recover; one log line helps the owner extend config.
      if (unconfiguredLogged.has(message.toolName)) return;
      unconfiguredLogged.add(message.toolName);
      deps.log(
        `TOOL_SURFACE_MISS: tool=${message.toolName} namespace=unconfigured`,
      );
    },

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
      // Miss recovery (M2): namespaces to force-surface this boundary. One
      // log line per recovered miss, regardless of which path applies it.
      const forced = new Map(missedNamespaces);
      missedNamespaces.clear();
      const forcedApplied: string[] = [];
      const forcedList = (): { ns: ResolvedNamespace; toolName: string }[] => {
        const out: { ns: ResolvedNamespace; toolName: string }[] = [];
        for (const [nsName, toolName] of forced) {
          const ns = resolved.find((r) => r.name === nsName);
          if (ns === undefined) continue; // resolved to nothing this epoch
          deps.log(
            `TOOL_SURFACE_MISS: namespace=${nsName} tool=${toolName} epoch=${epoch}`,
          );
          forcedApplied.push(nsName);
          out.push({ ns, toolName });
        }
        return out;
      };
      const started = deps.now();
      const result = await deps.jevNamespaceScore({
        state: digest,
        namespaces: resolved.map((r) => ({
          name: r.name,
          descriptions: r.descriptions,
        })),
      });
      const latencyMs = deps.now() - started;
      if (result.scores === null) {
        const errorClass = result.error ?? "unknown";
        // A single 429 is transient: freeze the current set (forced misses
        // still surface — visibility-first), retry next boundary. A REPEATED
        // 429 fails static like any other outage (frozen design).
        if (errorClass === "http_429") consecutive429 += 1;
        if (errorClass === "http_429" && consecutive429 < 2) {
          deps.log(
            `ROUTE_DEGRADED: reason=http_429 nozzle=tools action=keep_current epoch=${epoch}`,
          );
          const frozen = [...current];
          for (const f of forcedList()) {
            for (const t of f.ns.tools) {
              if (!frozen.includes(t)) frozen.push(t);
            }
            if (!active.includes(f.ns.name)) active.push(f.ns.name);
          }
          if (!sameNameSet(frozen, current)) deps.setActiveTools(frozen);
          deps.recordTelemetry({
            event: "TOOL_SURFACE",
            ts: deps.now(),
            epoch,
            active: [...active],
            forced: forcedApplied,
            scores: {},
            latency_ms: latencyMs,
            input_tokens: 0,
            degraded: "http_429",
          });
          return;
        }
        // Whole-request failure: fail-static (§3.5), Pi default visibility.
        degrade(errorClass, "batch");
        restoreAll(resolved, current);
        active = resolved.map((r) => r.name);
        // restoreAll already surfaced every namespace; the log stands.
        forcedList();
        deps.recordTelemetry({
          event: "TOOL_SURFACE",
          ts: deps.now(),
          epoch,
          active: [...active],
          forced: forcedApplied,
          scores: {},
          latency_ms: latencyMs,
          input_tokens: 0,
          degraded: errorClass,
        });
        return;
      }
      consecutive429 = 0;
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
      // Forced namespaces win over a low score for this one boundary.
      for (const f of forcedList()) {
        if (!nextActive.includes(f.ns.name)) nextActive.push(f.ns.name);
        for (const t of f.ns.tools) {
          visible.add(t);
          inactiveTools.delete(t);
        }
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
          .join(",")}} forced=[${forcedApplied.join(",")}]`,
      );
      deps.recordTelemetry({
        event: "TOOL_SURFACE",
        ts: deps.now(),
        epoch,
        active: [...nextActive],
        forced: forcedApplied,
        scores,
        latency_ms: latencyMs,
        input_tokens: result.inputTokens,
      });
    },
  };
}

// --------------------------------------------------------------------------
// Prune application (Nozzle 3, M2): remove the tool call/result PAIRS the
// frozen applied set condemns from a context-event message copy. The
// provider tool_use/tool_result pairing invariant holds by construction:
// both sides go or neither. All thinking/text parts REMAIN — learning
// stays, garbage goes. An assistant message that carried nothing but
// pruned calls leaves no empty husk. Pure: same input + same frozen set
// = byte-identical output (§3.4). Returns the input reference when
// nothing matches, so a no-op context stays a no-op for the wiring.
// --------------------------------------------------------------------------

export function applyPruneSet(
  messages: readonly AgentMessage[],
  pruneIds: ReadonlySet<string>,
): AgentMessage[] {
  if (pruneIds.size === 0) return messages as AgentMessage[];
  let changed = false;
  const out: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const kept = message.content.filter(
        (part) => part.type !== "toolCall" || !pruneIds.has(part.id),
      );
      if (kept.length === message.content.length) {
        out.push(message);
        continue;
      }
      changed = true;
      if (kept.length === 0) continue; // carried only pruned pair(s)
      out.push({ ...message, content: kept });
    } else if (message.role === "toolResult") {
      if (pruneIds.has(message.toolCallId)) {
        changed = true;
        continue;
      }
      out.push(message);
    } else {
      out.push(message);
    }
  }
  return changed ? out : (messages as AgentMessage[]);
}

// --------------------------------------------------------------------------
// Epoch pruner (Nozzle 3): the judgment state machine. `agent_settled`
// closes an epoch; the pruner captures it, judges every not-yet-judged
// complete pair in one batched request, and caches verdicts by toolCall id
// — judged once ever, never mid-loop. Verdicts apply at the next user-turn
// boundary (byte-stability §3.4), in one of two modes feature-detected by
// the wiring: on Pi ≥ 0.87 each pruned pair lands as append-only
// `context_edit` entries (durable across resume; the session projection
// owns model visibility and the `context` event no longer filters); on
// Pi < 0.87 the frozen applied set filters the context-event message copy
// instead. Resume-aware: entries already targeted by existing context_edit
// entries seed an edited-target set and are never re-judged. Fail-static
// (§3.5): any judge failure logs ROUTE_DEGRADED, notifies once per error
// class, and caches nothing (zero pruning = Pi native); unjudged pairs
// stay eligible for retry at the next settle. Code owns mechanics only —
// every helpfulness decision is Jev's (owner's ruling).
// --------------------------------------------------------------------------

/**
 * Pi ≥ 0.87 durable prune seam: appends a `context_edit` session entry
 * that omits an earlier entry from model context (replacement null) or
 * replaces only its content (role/metadata retained). Raw entries are
 * never modified; the transcript stays append-only. Returns the new
 * edit entry's id.
 */
export type AppendContextEditFn = (
  targetId: string,
  replacement: { content: AssistantMessage["content"] } | null,
) => string;

export interface PruneVerdict {
  /** Jev helpfulness score in [0,1]; application thresholds it. */
  score: number;
  /** Settle epoch in which the verdict was reached. */
  epoch: number;
  /** Byte size of the judged output; feeds the tokens_reclaimed estimate. */
  outputBytes: number;
  /** Byte size of the toolCall part JSON; feeds the tokens_reclaimed estimate. */
  callBytes: number;
  /** Session entry id of the assistant message owning the pair's call. */
  assistantEntryId?: string;
  /** Session entry id of the pair's toolResult message. */
  resultEntryId?: string;
  /** Owning assistant entry's content at capture — the base the
   *  replacement edit subtracts pruned toolCall parts from. */
  assistantContent?: AssistantMessage["content"];
}

export interface EpochPrunerDeps {
  apiKey: string | null;
  jevPruneJudge: JevPruneJudgeFn;
  stateCapBytes: number;
  /** Helpfulness score at or below which a pair is pruned. */
  pruneThreshold: number;
  /**
   * Pi ≥ 0.87 context-edit seam, feature-detected by the wiring. Present
   *  = durable edit mode: prunes land as appended `context_edit` entries
   *  at the boundary. Absent (Pi < 0.87) = filter fallback: the frozen
   *  applied set is removed from the context-event message copy.
   */
  appendContextEdit?: AppendContextEditFn;
  /**
   * Entry ids already targeted by `context_edit` entries on the branch
   * (resume seeding). Pairs touching a seeded entry are never re-judged;
   * their prunes are already durable in the session file.
   */
  editedTargets?: readonly string[];
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  log: (line: string) => void;
  recordTelemetry: (event: TelemetryEvent) => void;
  now: () => number;
}

export interface EpochPruner {
  /** Judge the closed epoch. Never rejects: failures are loud + fail-static.
   *  The returned promise settles when the pass is done (M2 boundary and
   *  tests await it); Pi may fire-and-forget. */
  onAgentSettled(entries: readonly DigestEntry[]): Promise<void>;
  /** Verdict for one pair, by toolCall id. */
  verdict(id: string): PruneVerdict | undefined;
  /** All cached verdicts (application seam). */
  verdicts(): ReadonlyMap<string, PruneVerdict>;
  /** In-flight judge pass, if any (the boundary awaits it before applying). */
  pending(): Promise<void> | null;
  /**
   * Apply new verdicts at the user-turn boundary: awaits any in-flight
   * judge pass, then — edit mode — appends one omit edit per pruned
   * toolResult entry and ONE replacement edit per assistant entry (its
   * parts minus every pruned toolCall part; zero parts left = omit); —
   * filter mode — freezes the pruned ids into the applied set. Emits
   * PRUNE_EPOCH when new verdicts apply. Boundary-only (§3.4).
   */
  refreshAppliedSet(): Promise<void>;
  /**
   * Filter mode: remove the frozen applied set's pruned pairs from a
   * context-event message copy (pure, byte-stable within an epoch). Edit
   * mode: identity — the session projection owns pruning.
   */
  applyPrunes(messages: readonly AgentMessage[]): AgentMessage[];
  /** The frozen prune ids of the applied set (filter mode; tests). */
  appliedIds(): ReadonlySet<string>;
}

/** Bytes→tokens estimate for reclaim telemetry: the eval harness's
 *  calibrated constant (eval/harness/tokens.ts). Telemetry only, never a
 *  decision input. */
export const BYTES_PER_TOKEN_ESTIMATE = 3.5;

export function createEpochPruner(deps: EpochPrunerDeps): EpochPruner {
  let epoch = 0;
  const verdictMap = new Map<string, PruneVerdict>();
  /** Pairs with a judge pass in flight (double-settle re-entrancy guard). */
  const judging = new Set<string>();
  const degradedNotified = new Set<string>();
  let pendingJudge: Promise<void> | null = null;
  /** Frozen applied set: verdicts snapshotted at the last boundary (§3.4). */
  const applied = new Map<string, PruneVerdict>();
  /** Frozen prune ids: applied verdicts at or below the threshold. Edit
   *  mode leaves this empty — the session projection owns pruning. */
  let appliedPruneIds: ReadonlySet<string> = new Set();
  /** Entry ids already targeted by context_edit entries (resume seeding
   *  plus every edit this session applied): never re-judged. */
  const editedTargets = new Set<string>(deps.editedTargets ?? []);
  const editSink = deps.appendContextEdit;
  const mode: PruneEpochRecord["mode"] =
    editSink === undefined ? "context_filter" : "context_edit";
  // The mode is fixed per session (feature-detected at build); log it once.
  // Absent mode stays silent, consistent with the absent-mode contract.
  if (deps.apiKey !== null) deps.log(`PRUNE_MODE: mode=${mode}`);

  const degrade = (errorClass: string, detail: string): void => {
    deps.log(
      `ROUTE_DEGRADED: reason=${errorClass} nozzle=prune ${detail} epoch=${epoch}`,
    );
    if (!degradedNotified.has(errorClass)) {
      degradedNotified.add(errorClass);
      deps.notify(
        `jev-context: Jev pruning unavailable (${errorClass}); tool outputs stay unpruned`,
        "warning",
      );
    }
  };

  const judge = async (entries: readonly DigestEntry[]): Promise<void> => {
    epoch += 1;
    const captured = captureEpochPairs(entries);
    if (captured === null) return;
    // Resume-aware judge-once: a pair whose assistant or result entry is
    // already the target of a context_edit entry is never re-judged — its
    // prune is already durable in the session file.
    const seeded = (p: EpochPair): boolean =>
      (p.assistantEntryId !== undefined &&
        editedTargets.has(p.assistantEntryId)) ||
      (p.resultEntryId !== undefined && editedTargets.has(p.resultEntryId));
    const unjudged = new Set(
      captured.pairs
        .filter(
          (p) => !verdictMap.has(p.id) && !judging.has(p.id) && !seeded(p),
        )
        .map((p) => p.id),
    );
    if (unjudged.size === 0) return;
    for (const id of unjudged) judging.add(id);
    try {
      const rendered = renderPruneState(captured, deps.stateCapBytes);
      const payloads = rendered.pairs.filter((p) => unjudged.has(p.id));
      const started = deps.now();
      const result = await deps.jevPruneJudge({
        state: rendered.state,
        pairs: payloads,
      });
      const latencyMs = deps.now() - started;
      if (result.scores === null) {
        degrade(result.error ?? "unknown", `pairs=${payloads.length}`);
        return;
      }
      const scores: Record<string, number> = {};
      for (const p of payloads) {
        const score = result.scores[p.id];
        if (score === null || score === undefined) {
          // Per-pair parse gap: fail-static for that pair, cache nothing.
          degrade("bad_response", `pair=${p.id}`);
          continue;
        }
        const pair = captured.pairs.find((cp) => cp.id === p.id);
        verdictMap.set(p.id, {
          score,
          epoch,
          outputBytes: pair?.outputBytes ?? 0,
          callBytes: pair?.callBytes ?? 0,
          assistantEntryId: pair?.assistantEntryId,
          resultEntryId: pair?.resultEntryId,
          assistantContent: pair?.assistantContent,
        });
        scores[`#${p.ordinal}`] = score;
      }
      const judged = Object.keys(scores).length;
      if (judged === 0) return;
      deps.log(
        `PRUNE_JUDGED: epoch=${epoch} judged=${judged} scores={${Object.entries(
          scores,
        )
          .map(([k, v]) => `${k}:${v}`)
          .join(
            ",",
          )}} latency_ms=${latencyMs} input_tokens=${result.inputTokens}`,
      );
      deps.recordTelemetry({
        event: "PRUNE_JUDGED",
        ts: deps.now(),
        epoch,
        judged,
        scores,
        latency_ms: latencyMs,
        input_tokens: result.inputTokens,
      });
    } finally {
      for (const id of unjudged) judging.delete(id);
    }
  };

  /**
   * Edit mode (Pi ≥ 0.87): append one omit edit per pruned toolResult
   * entry and ONE replacement edit per owning assistant entry — the
   * entry's parts minus every pruned toolCall part, thinking/text kept
   * verbatim; an entry left with zero parts is omitted rather than
   * replaced with empty content. Raw entries are never modified.
   */
  const applyPruneEdits = (pruned: [string, PruneVerdict][]): string[] => {
    if (editSink === undefined) return [];
    const editIds: string[] = [];
    for (const [, v] of pruned) {
      if (v.resultEntryId === undefined) continue;
      editIds.push(editSink(v.resultEntryId, null));
      editedTargets.add(v.resultEntryId);
    }
    const byEntry = new Map<
      string,
      { content: AssistantMessage["content"]; prunedIds: Set<string> }
    >();
    for (const [id, v] of pruned) {
      if (v.assistantEntryId === undefined || v.assistantContent === undefined)
        continue;
      const group = byEntry.get(v.assistantEntryId) ?? {
        content: v.assistantContent,
        prunedIds: new Set<string>(),
      };
      group.prunedIds.add(id);
      byEntry.set(v.assistantEntryId, group);
    }
    for (const [entryId, group] of byEntry) {
      const content = group.content.filter(
        (part) => part.type !== "toolCall" || !group.prunedIds.has(part.id),
      );
      editIds.push(
        editSink(entryId, content.length === 0 ? null : { content }),
      );
      editedTargets.add(entryId);
    }
    return editIds;
  };

  const refreshAppliedSet = async (): Promise<void> => {
    if (deps.apiKey === null) return; // absent mode
    if (pendingJudge !== null) await pendingJudge;
    const fresh = [...verdictMap.entries()].filter(([id]) => !applied.has(id));
    if (fresh.length === 0) return;
    for (const [id, v] of fresh) applied.set(id, v);
    const pruned = fresh.filter(([, v]) => v.score <= deps.pruneThreshold);
    let editIds: string[] = [];
    if (editSink === undefined) {
      // Filter fallback (Pi < 0.87): freeze the pruned ids; the context
      // handler removes them from the message copy this epoch.
      const nextIds = new Set<string>();
      for (const [id, v] of applied) {
        if (v.score <= deps.pruneThreshold) nextIds.add(id);
      }
      appliedPruneIds = nextIds;
    } else {
      // Edit mode (Pi ≥ 0.87): the projection owns visibility from here.
      editIds = applyPruneEdits(pruned);
    }
    // PRUNE_EPOCH: what THIS boundary newly applies. tokens_reclaimed is the
    // estimated token count of the REMOVED content — the pruned toolCall
    // part JSON plus the toolResult content — at the harness's 3.5
    // bytes/token (issue #9: the old 4-bytes/token output-only estimate
    // undercounted). Telemetry only, never a decision input.
    const tokensReclaimed = Math.ceil(
      pruned.reduce((sum, [, v]) => sum + v.callBytes + v.outputBytes, 0) /
        BYTES_PER_TOKEN_ESTIMATE,
    );
    const settledEpoch = Math.max(...fresh.map(([, v]) => v.epoch));
    const scores: Record<string, number> = {};
    for (const [id, v] of fresh) scores[id] = v.score;
    deps.log(
      `PRUNE_EPOCH: epoch=${settledEpoch} mode=${mode} judged=${fresh.length} pruned=${pruned.length} kept=${fresh.length - pruned.length} tokens_reclaimed=${tokensReclaimed} edits=[${editIds.join(",")}] scores={${Object.entries(
        scores,
      )
        .map(([k, v]) => `${k}:${v}`)
        .join(",")}}`,
    );
    deps.recordTelemetry({
      event: "PRUNE_EPOCH",
      ts: deps.now(),
      epoch: settledEpoch,
      judged: fresh.length,
      pruned: pruned.length,
      kept: fresh.length - pruned.length,
      tokens_reclaimed: tokensReclaimed,
      edits: editIds,
      mode,
      scores,
    });
  };

  return {
    verdict: (id) => verdictMap.get(id),
    verdicts: () => verdictMap,
    pending: () => pendingJudge,
    refreshAppliedSet,
    applyPrunes: (messages) => applyPruneSet(messages, appliedPruneIds),
    appliedIds: () => appliedPruneIds,
    onAgentSettled(entries) {
      if (deps.apiKey === null) return Promise.resolve(); // absent mode
      const run = judge(entries).catch((error) => {
        // Never-reject contract: the judge client maps expected failures to
        // results; anything reaching here is a defect — loud, fail-static.
        degrade(
          "internal",
          `error=${error instanceof Error ? error.message : String(error)}`,
        );
      });
      pendingJudge = run;
      void run.finally(() => {
        if (pendingJudge === run) pendingJudge = null;
      });
      return run;
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
  /** Test seam: replaces the real batched prune-judge client entirely. */
  jevPruneJudge?: JevPruneJudgeFn;
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
  onAgentSettled(
    event: AgentSettledEvent,
    ctx: ExtensionContext,
  ): Promise<void>;
  /** Unknown-tool miss detection (Nozzle 2 escape hatch). */
  onMessageEnd(event: MessageEndEvent): void;
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
  let pruner: EpochPruner | null = null;
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
    // Degradation stays loud via ui.notify (VERIFYING 3.5); routine judgment
    // lines are stderr-gated so the TUI input bar stays clean by default.
    const gatedLog = (line: string): void => {
      if (config.consoleLog) deps.log(line);
    };
    const apiKey = resolveApiKey(config, deps.env);
    if (apiKey === null) {
      ctx.ui.notify(
        `jev-context: no Jev API key (set $${config.apiKeyEnv} or apiKeyFile in config); skill routing, tool surfacing, and epoch pruning disabled`,
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
    const jevPruneJudge: JevPruneJudgeFn =
      deps.jevPruneJudge ??
      (apiKey === null
        ? () =>
            Promise.resolve({
              scores: null,
              inputTokens: 0,
              latencyMs: 0,
              error: "no_api_key",
            })
        : createJevPruneJudge({
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
      log: gatedLog,
      recordTelemetry: (event) =>
        appendTelemetry(telemetryFile, event, gatedLog),
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
            log: gatedLog,
            recordTelemetry: (event) =>
              appendTelemetry(telemetryFile, event, gatedLog),
            now: deps.now,
          });
    // Pi ≥ 0.87 feature detection: the runtime SessionManager carries
    // appendContextEdit (the ReadonlySessionManager type omits it), making
    // prunes durable append-only context_edit entries. Pi < 0.87 falls
    // back to the context-event filter path.
    const editCapable = ctx.sessionManager as unknown as {
      appendContextEdit?: AppendContextEditFn;
    };
    const appendContextEdit =
      typeof editCapable.appendContextEdit === "function"
        ? editCapable.appendContextEdit.bind(ctx.sessionManager)
        : undefined;
    // Resume-aware judge-once: targets of existing context_edit entries on
    // the branch seed the pruner; their pairs are never re-judged.
    const editedTargets: string[] = [];
    if (appendContextEdit !== undefined) {
      for (const entry of ctx.sessionManager.getBranch()) {
        const raw = entry as { type: string; targetId?: unknown };
        if (raw.type !== "context_edit") continue;
        if (typeof raw.targetId === "string") editedTargets.push(raw.targetId);
      }
    }
    pruner = createEpochPruner({
      apiKey,
      jevPruneJudge,
      stateCapBytes: config.pruneStateCapBytes,
      pruneThreshold: config.pruneThreshold,
      appendContextEdit,
      editedTargets,
      notify: (message, type) => ctx.ui.notify(message, type),
      log: gatedLog,
      recordTelemetry: (event) =>
        appendTelemetry(telemetryFile, event, gatedLog),
      now: deps.now,
    });
    // Fail-static baseline: every session (re)starts from Pi-default tool
    // visibility, key or no key; the first boundary routes from there.
    toolRouter?.onSessionStart();
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
        // The prune applied set refreshes at the same boundary, after any
        // in-flight judge pass from the settle completes (§3.4).
        pruner === null ? Promise.resolve() : pruner.refreshAppliedSet(),
      ]);
    },
    onContext(event) {
      const pruned =
        pruner === null ? event.messages : pruner.applyPrunes(event.messages);
      const base =
        router === null
          ? {}
          : router.onContext(
              pruned === event.messages
                ? event
                : { ...event, messages: pruned },
            );
      // The skill router returns {} when it has no injection; that must not
      // drop the prune surgery from the result.
      if (base.messages === undefined && pruned !== event.messages) {
        return { messages: pruned };
      }
      return base;
    },
    onAgentSettled(_event, ctx) {
      router?.onAgentSettled();
      if (pruner === null) return Promise.resolve();
      // The judge promise is returned so tests (and the M2 boundary via
      // pruner.pending()) can await it; it never rejects.
      return pruner.onAgentSettled(ctx.sessionManager.getBranch());
    },
    onMessageEnd(event) {
      toolRouter?.onMessageEnd(event.message);
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
  pi.on("message_end", handlers.onMessageEnd);
}
