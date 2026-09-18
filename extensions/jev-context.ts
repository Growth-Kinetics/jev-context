/**
 * jev-context — Jev-routed skill loading for Pi (GOAL 2026-09-18-001, Nozzle 1).
 *
 * What: at each user-turn boundary (`before_agent_start`), scores the skill
 *   catalog against a digest of the session via the Jev (TypeSafe System One)
 *   API — one parallel request per not-yet-active skill with the full skill
 *   body embedded in the noul question — then injects the winning skill
 *   bodies into the deep-copied message list of the `context` event, frozen
 *   until `agent_settled`.
 * Events used: `session_start` (init: config, API key, catalog scan),
 *   `before_agent_start` (digest + scoring pass + injection rebuild),
 *   `context` (inject into the message copy), `agent_settled` (close epoch).
 * State owned: skill catalog cache, active-skill set (name -> score, pinned
 *   flag, turns since load), the per-epoch frozen injection message, epoch
 *   counter, once-per-reason degradation marks, and the append-only telemetry
 *   JSONL. All session state rebuilds on `session_start` (any reason).
 * Commands: `skill:<name>` per catalog skill (manual load, pinned against
 *   decay — mirrors Pi's native skill-command naming), `skill_stats`.
 * Config: `~/.pi/agent/jev-context.json` then `<cwd>/.pi/jev-context.json`;
 *   the API key comes from the config-named env var (default
 *   $PI_TYPESAFE_JEV) or the config-named file. The key is never logged (§3.6).
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
    digestCapBytes: 80_000,
    requestTimeoutMs: 300_000,
    telemetryFile: defaultTelemetryFile(homeDir),
    skillRoots: defaultSkillRoots(homeDir, cwd),
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

/** Keep only known, correctly-typed fields; expand `~/` in path fields. */
function pickConfigFields(
  raw: unknown,
  homeDir: string,
): Partial<JevContextConfig> {
  const r = asRecord(raw);
  if (r === null) return {};
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
  return out;
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
      config = {
        ...config,
        ...pickConfigFields(JSON.parse(raw), paths.homeDir),
      };
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

    async onBeforeAgentStart({ prompt, entries }) {
      if (deps.apiKey === null) return; // absent mode (§5 cross-cutting)
      epoch += 1;
      for (const a of active.values()) a.turnsSinceLoad += 1;
      const skippedActive = sortedActive().map((s) => s.name);
      const digest = buildSessionDigest(entries, prompt, deps.digestCapBytes);
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
  let telemetryFile = defaultTelemetryFile(deps.homeDir);
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
    const apiKey = resolveApiKey(config, deps.env);
    if (apiKey === null) {
      ctx.ui.notify(
        `jev-context: no Jev API key (set $${config.apiKeyEnv} or apiKeyFile in config); skill routing disabled`,
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
      await router.onBeforeAgentStart({
        prompt: event.prompt,
        entries: ctx.sessionManager.getBranch(),
      });
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
    },
    (name, options) => pi.registerCommand(name, options),
  );
  pi.on("session_start", handlers.onSessionStart);
  pi.on("before_agent_start", handlers.onBeforeAgentStart);
  pi.on("context", handlers.onContext);
  pi.on("agent_settled", handlers.onAgentSettled);
}
