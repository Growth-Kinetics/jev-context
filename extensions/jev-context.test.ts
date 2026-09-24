/**
 * Tests for the jev-context extension (Nozzle 1: spec 2026-09-18-001 M1-M3;
 * Nozzle 2: spec 2026-09-18-002 M1-M2 and spec 2026-09-20-003 M1, the
 * routing-state/description work closing issues #8 and #5; Nozzle 3: spec
 * 2026-09-18-003 M1-M2 and spec 2026-09-20-001 M1-M2, the context-edit
 * migration).
 * §5 scenario titles are mirrored verbatim from VERIFYING.md so
 * "scenario exists ⇔ test exists" is diffable.
 * No network: the Jev client is exercised against a loopback fixture server
 * (§4), everything else through the injected JevScoreFn seam. Fakes that must
 * satisfy Pi runtime types use a documented `as unknown as` double cast.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  TextContent,
  ThinkingContent,
  ToolCall,
  UserMessage,
} from "@earendil-works/pi-ai";
import type {
  BeforeAgentStartEvent,
  ContextEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import jevContext, {
  type AppendContextEditFn,
  applyPruneSet,
  buildPruneJudgeInstructions,
  buildRoutingState,
  buildSessionDigest,
  buildSkillInjection,
  CORE_TOOLS,
  captureEpochPairs,
  createEpochPruner,
  createJevContextExtension,
  createJevNamespaceScorer,
  createJevPruneJudge,
  createJevScorer,
  createSkillRouter,
  createToolSurfaceRouter,
  type DigestEntry,
  defaultSkillRoots,
  type EpochPrunerDeps,
  type JevNamespaceScoreFn,
  type JevPruneJudgeFn,
  type JevScoreFn,
  type JevScoreRequest,
  LATEST_USER_MESSAGE_CAP_BYTES,
  loadConfig,
  type NamespaceScoreRequest,
  type PruneEpochRecord,
  type PruneJudgeRequest,
  pruneQuestionKey,
  type RoutingState,
  renderPruneState,
  renderSkillStats,
  resolveApiKey,
  type SkillEntry,
  type SkillInjectionResult,
  type SkillRouterDeps,
  scanSkillCatalog,
  selectSkillsToLoad,
  surfaceQuestionKey,
  type TelemetryEvent,
  type ToolNamespaceConfig,
  type ToolSurfaceRouterDeps,
} from "./jev-context.ts";

// ---------------------------------------------------------------- helpers

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "jev-context-"));
}

function userMessage(text: string, timestamp = 1): AgentMessage {
  return { role: "user", content: text, timestamp };
}

function assistantMessage(
  parts: (TextContent | ThinkingContent | ToolCall)[],
  timestamp = 1,
): AgentMessage {
  return {
    role: "assistant",
    content: parts,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function messageEntry(message: AgentMessage, id?: string): DigestEntry {
  return id === undefined
    ? { type: "message", message }
    : { type: "message", id, message };
}

function contextEvent(messages: AgentMessage[]): ContextEvent {
  return { type: "context", messages };
}

function skillEntry(name: string, body: string): SkillEntry {
  return { name, body, path: `/fixture/${name}` };
}

function fakeScorer(scores: Record<string, number>): JevScoreFn {
  return async (req) => ({
    score: scores[req.skillName] ?? 0,
    inputTokens: 10,
    latencyMs: 1,
  });
}

/** Routing-state fixture: a digest marker with an empty latest message. */
function fakeState(digest: string, latest = ""): RoutingState {
  return { latest_user_message: latest, conversation_digest: digest };
}

function makeRouter(
  catalog: SkillEntry[],
  jevScore: JevScoreFn,
  extra: Partial<SkillRouterDeps> = {},
) {
  const logs: string[] = [];
  const notifies: { message: string; type: string | undefined }[] = [];
  const telemetry: TelemetryEvent[] = [];
  const router = createSkillRouter({
    catalog,
    jevScore,
    apiKey: "test-key",
    loadThreshold: 0.6,
    topK: 3,
    decayThreshold: 0.25,
    decayIntervalTurns: 5,
    digestCapBytes: 80_000,
    notify: (message, type) => notifies.push({ message, type }),
    log: (line) => logs.push(line),
    recordTelemetry: (event) => telemetry.push(event),
    now: () => 1000,
    ...extra,
  });
  return { router, logs, notifies, telemetry };
}

function injectedOf(result: SkillInjectionResult): UserMessage {
  const message = result.messages?.[0];
  assert.ok(
    message !== undefined && message.role === "user",
    "expected an injected user message at index 0",
  );
  return message;
}

function textOf(message: UserMessage): string {
  const content = message.content;
  assert.ok(typeof content === "string");
  return content;
}

function asRec(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null);
  return value as Record<string, unknown>;
}

// ------------------------------------------------------------- §5 scenarios

test("extension loads and registers on session_start, before_agent_start, context, and agent_settled", () => {
  const registered = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  const pi = {
    on(event: string, handler: unknown): void {
      registered.set(event, handler);
    },
    registerCommand(name: string, options: unknown): void {
      commands.set(name, options);
    },
  } as unknown as ExtensionAPI;
  jevContext(pi);
  assert.deepEqual([...registered.keys()].sort(), [
    "agent_settled",
    "before_agent_start",
    "context",
    "message_end",
    "session_start",
  ]);
  assert.ok(commands.has("skill_stats"));
});

test("Given a catalog of N skills and a new user message, when `before_agent_start` fires, then exactly one Jev request per not-yet-active skill is issued, in parallel, with the full skill body in the question and the routing state (latest user message plus digest) as state", async () => {
  const catalog = [
    skillEntry("a", "BODY-A"),
    skillEntry("b", "BODY-B"),
    skillEntry("c", "BODY-C"),
  ];
  const started: string[] = [];
  const requests = new Map<string, JevScoreRequest>();
  const gates = new Map<string, () => void>();
  const jevScore: JevScoreFn = (req) => {
    started.push(req.skillName);
    requests.set(req.skillName, req);
    return new Promise((resolve) =>
      gates.set(req.skillName, () =>
        resolve({ score: 0.1, inputTokens: 5, latencyMs: 1 }),
      ),
    );
  };
  const { router } = makeRouter(catalog, jevScore);
  const pending = router.onBeforeAgentStart({
    prompt: "hello",
    entries: [messageEntry(userMessage("old turn"))],
  });
  // All requests issued before any resolution: fully parallel.
  assert.deepEqual([...started].sort(), ["a", "b", "c"]);
  const expectedDigest = "[user] old turn\n[user] hello\n";
  for (const [name, req] of requests) {
    assert.deepEqual(req.state, fakeState(expectedDigest, "hello"));
    assert.equal(req.skillBody, `BODY-${name.toUpperCase()}`);
  }
  for (const gate of gates.values()) gate();
  await pending;
  assert.deepEqual(router.activeSkills(), []); // all below threshold
});

test("Given skill scores [0.86, 0.16, …] and threshold 0.6, when the epoch starts, then only skills ≥ 0.6 enter the active set, capped at top-3 by score", async () => {
  const catalog = ["a", "b", "c", "d", "e"].map((n) =>
    skillEntry(n, `BODY-${n}`),
  );
  const jevScore = fakeScorer({ a: 0.86, b: 0.16, c: 0.7, d: 0.65, e: 0.61 });
  const { router } = makeRouter(catalog, jevScore);
  await router.onBeforeAgentStart({ prompt: "hi", entries: [] });
  assert.deepEqual(
    router.activeSkills().map((s) => s.name),
    ["a", "c", "d"], // e (0.61) passes threshold but loses the top-3 cap
  );
  // Boundary: exactly 0.6 is in, 0.59 is out.
  assert.deepEqual(
    selectSkillsToLoad(
      [
        { name: "x", score: 0.6 },
        { name: "y", score: 0.59 },
      ],
      0.6,
      3,
    ).map((s) => s.name),
    ["x"],
  );
});

test("Given a skill already active, when a new user message arrives, then no Jev request is issued for that skill", async () => {
  const catalog = [skillEntry("a", "A"), skillEntry("b", "B")];
  const calls: string[] = [];
  const jevScore: JevScoreFn = async (req) => {
    calls.push(req.skillName);
    return {
      score: req.skillName === "a" ? 0.9 : 0.1,
      inputTokens: 1,
      latencyMs: 1,
    };
  };
  const { router } = makeRouter(catalog, jevScore);
  await router.onBeforeAgentStart({ prompt: "one", entries: [] });
  assert.deepEqual(
    router.activeSkills().map((s) => s.name),
    ["a"],
  );
  router.onAgentSettled();
  calls.length = 0;
  await router.onBeforeAgentStart({ prompt: "two", entries: [] });
  assert.deepEqual(calls, ["b"]);
});

test("Given an active skill set, when the `context` event fires, then skill bodies are injected at a fixed position immediately after the system prompt and prior messages keep their order", async () => {
  const { router } = makeRouter(
    [skillEntry("a", "ALPHA-BODY")],
    fakeScorer({ a: 0.9 }),
  );
  await router.onBeforeAgentStart({ prompt: "hi", entries: [] });
  const prior = [userMessage("first", 1), userMessage("second", 2)];
  const event = contextEvent(prior);
  const result = router.onContext(event);
  const content = textOf(injectedOf(result));
  assert.ok(content.includes('<skill name="a">'));
  assert.ok(content.includes("ALPHA-BODY"));
  assert.equal(result.messages?.length, 3);
  assert.deepEqual(result.messages?.slice(1), prior);
  // Non-destructive (§3.3): the event's list is never mutated.
  assert.deepEqual(event.messages, [
    userMessage("first", 1),
    userMessage("second", 2),
  ]);
});

test("Given two consecutive `context` events within one epoch, then the injected content is byte-identical between them (cache-stability invariant)", async () => {
  const { router } = makeRouter([skillEntry("a", "A")], fakeScorer({ a: 0.9 }));
  await router.onBeforeAgentStart({ prompt: "hi", entries: [] });
  const first = injectedOf(router.onContext(contextEvent([userMessage("a")])));
  const second = injectedOf(
    router.onContext(contextEvent([userMessage("b"), userMessage("c")])),
  );
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.strictEqual(first, second);
});

test("Given an `agent_settled` boundary, when the next epoch's first `context` event fires, then the injection is rebuilt and remains at the fixed position", async () => {
  const { router } = makeRouter([skillEntry("a", "A")], fakeScorer({ a: 0.9 }));
  await router.onBeforeAgentStart({ prompt: "one", entries: [] });
  const epochOne = injectedOf(
    router.onContext(contextEvent([userMessage("x")])),
  );
  router.onAgentSettled();
  await router.onBeforeAgentStart({ prompt: "two", entries: [] });
  const epochTwo = injectedOf(
    router.onContext(contextEvent([userMessage("y")])),
  );
  assert.notStrictEqual(epochOne, epochTwo);
  assert.ok(textOf(epochTwo).includes('<skill name="a">'));
});

test("Given Jev is unreachable or errors during scoring, when the epoch starts, then the extension notifies once per error class, logs `ROUTE_DEGRADED`, and keeps the current skill set (fail-static)", async () => {
  const catalog = [skillEntry("a", "A"), skillEntry("b", "B")];
  let failing = false;
  const jevScore: JevScoreFn = async (req) =>
    failing
      ? { score: null, inputTokens: 0, latencyMs: 1, error: "http_500" }
      : {
          score: req.skillName === "a" ? 0.9 : 0.1,
          inputTokens: 1,
          latencyMs: 1,
        };
  const { router, logs, notifies } = makeRouter(catalog, jevScore);
  await router.onBeforeAgentStart({ prompt: "one", entries: [] });
  router.onAgentSettled();
  failing = true;
  await router.onBeforeAgentStart({ prompt: "two", entries: [] });
  assert.equal(notifies.length, 1);
  assert.equal(notifies[0].type, "warning");
  assert.ok(logs.some((l) => l.startsWith("ROUTE_DEGRADED: reason=http_500")));
  // Fail-static: the previously loaded skill is still injected.
  const content = textOf(
    injectedOf(router.onContext(contextEvent([userMessage("x")]))),
  );
  assert.ok(content.includes('<skill name="a">'));
  router.onAgentSettled();
  await router.onBeforeAgentStart({ prompt: "three", entries: [] });
  assert.equal(notifies.length, 1); // once per error class
  assert.equal(
    logs.filter((l) => l.startsWith("ROUTE_DEGRADED:")).length,
    2, // logged every time
  );
});

test("Given no API key configured, when Pi starts, then the extension loads, notifies once, and behaves as if absent", async () => {
  const notifications: string[] = [];
  const logs: string[] = [];
  let scorerCalls = 0;
  const handlers = createJevContextExtension({
    homeDir: makeTmpDir(),
    env: {},
    now: () => 1000,
    log: (line) => logs.push(line),
    jevScore: async () => {
      scorerCalls++;
      return { score: 0.9, inputTokens: 1, latencyMs: 1 };
    },
  });
  const ctx = {
    cwd: makeTmpDir(),
    ui: { notify: (message: string) => notifications.push(message) },
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionContext;
  handlers.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
  assert.equal(notifications.length, 1);
  assert.ok(notifications[0].includes("no Jev API key"));
  await handlers.onBeforeAgentStart(
    {
      type: "before_agent_start",
      prompt: "hi",
      systemPrompt: "",
      systemPromptOptions:
        {} as unknown as BeforeAgentStartEvent["systemPromptOptions"],
    },
    ctx,
  );
  assert.equal(scorerCalls, 0);
  assert.deepEqual(handlers.onContext(contextEvent([userMessage("x")])), {});
  assert.deepEqual(logs, []);
  // Notified once across the whole session, not once per init touchpoint.
  assert.equal(notifications.length, 1);
});

test("session_start builds the router once; later turns reuse it (no re-init, no re-scoring of active skills)", async () => {
  const home = makeTmpDir();
  mkdirSync(join(home, ".pi", "agent", "skills", "demo"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "skills", "demo", "SKILL.md"),
    "DEMO-BODY",
  );
  let scorerCalls = 0;
  const handlers = createJevContextExtension({
    homeDir: home,
    env: { PI_TYPESAFE_JEV: "test-key" },
    now: () => 1000,
    log: () => {},
    jevScore: async () => {
      scorerCalls++;
      return { score: 0.9, inputTokens: 1, latencyMs: 1 };
    },
  });
  const ctx = {
    cwd: makeTmpDir(),
    ui: { notify: () => {} },
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionContext;
  const turn = (prompt: string) => ({
    type: "before_agent_start" as const,
    prompt,
    systemPrompt: "",
    systemPromptOptions:
      {} as unknown as BeforeAgentStartEvent["systemPromptOptions"],
  });
  handlers.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
  await handlers.onBeforeAgentStart(turn("one"), ctx);
  assert.equal(scorerCalls, 1); // catalog scan found demo; scored once
  await handlers.onAgentSettled({ type: "agent_settled" }, ctx);
  await handlers.onBeforeAgentStart(turn("two"), ctx);
  assert.equal(scorerCalls, 1); // active skill not re-scored, router not rebuilt
  const injected = injectedOf(
    handlers.onContext(contextEvent([userMessage("x")])),
  );
  assert.ok(textOf(injected).includes("DEMO-BODY"));
  // A session boundary resets state: the next turn re-scores the catalog.
  handlers.onSessionStart({ type: "session_start", reason: "new" }, ctx);
  await handlers.onBeforeAgentStart(turn("three"), ctx);
  assert.equal(scorerCalls, 2);
});

// ------------------------------------------------------------------ digest

test("digest keeps user turns and assistant text/thinking, excludes tool calls, tool results, images, and non-message entries", () => {
  const entries: DigestEntry[] = [
    messageEntry(userMessage("U1")),
    messageEntry(
      assistantMessage([
        { type: "text", text: "A1" },
        { type: "thinking", thinking: "T1" },
        {
          type: "toolCall",
          id: "t1",
          name: "bash",
          arguments: { command: "rm -rf /" },
        },
      ]),
    ),
    messageEntry({
      role: "toolResult",
      toolCallId: "t1",
      toolName: "bash",
      content: [{ type: "text", text: "TOOL-OUTPUT-XYZ" }],
      isError: false,
      timestamp: 3,
    }),
    { type: "custom_message" },
    messageEntry({
      role: "user",
      content: [
        { type: "text", text: "U2" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
      timestamp: 4,
    }),
  ];
  const digest = buildSessionDigest(entries, "current prompt", 10_000);
  assert.equal(
    digest,
    "[user] U1\n[assistant] A1\n[assistant] T1\n[user] U2\n[user] current prompt\n",
  );
  assert.ok(!digest.includes("TOOL-OUTPUT-XYZ"));
  assert.ok(!digest.includes("rm -rf"));
  assert.ok(!digest.includes("bash"));
});

test("digest walks newest-first under the byte cap and emits chronologically", () => {
  const entries: DigestEntry[] = [
    messageEntry(userMessage("ancient")), // 15 bytes
    messageEntry(assistantMessage([{ type: "text", text: "mid" }])), // 16 bytes
    messageEntry(userMessage("recent")), // 14 bytes
  ];
  const cap = 11 + 14 + 16; // prompt + recent + mid fit exactly; ancient drops
  const digest = buildSessionDigest(entries, "now", cap);
  assert.equal(digest, "[assistant] mid\n[user] recent\n[user] now\n");
  assert.ok(Buffer.byteLength(digest, "utf8") <= cap);
});

// ----------------------------------------------------------------- catalog

test("routing state truncates an oversized latest user message to 8KB head+tail, logged at the boundary", async () => {
  // 15KB prompt: H*5000 + M*5000 + T*5000.
  const huge = `${"H".repeat(5000)}${"M".repeat(5000)}${"T".repeat(5000)}`;
  const built = buildRoutingState({ latestUserMessage: huge, digest: "D" });
  assert.ok(built.latestTruncated);
  assert.ok(
    Buffer.byteLength(built.state.latest_user_message, "utf8") <=
      LATEST_USER_MESSAGE_CAP_BYTES,
  );
  assert.ok(built.state.latest_user_message.startsWith("H".repeat(100)));
  assert.ok(built.state.latest_user_message.endsWith("T".repeat(100)));
  assert.ok(built.state.latest_user_message.includes("bytes omitted"));
  assert.ok(!built.state.latest_user_message.includes("M".repeat(100)));
  assert.equal(built.state.conversation_digest, "D");
  // Under the cap: verbatim, no truncation flag.
  const small = buildRoutingState({ latestUserMessage: "hi", digest: "D" });
  assert.deepEqual(small, {
    state: { latest_user_message: "hi", conversation_digest: "D" },
    latestTruncated: false,
  });
  // The boundary path logs the trip and still scores with the excerpt.
  const requests: JevScoreRequest[] = [];
  const { router, logs } = makeRouter(
    [skillEntry("a", "BODY-A")],
    async (req) => {
      requests.push(req);
      return { score: 0.1, inputTokens: 1, latencyMs: 1 };
    },
  );
  await router.onBeforeAgentStart({ prompt: huge, entries: [] });
  assert.ok(
    logs.some((l) =>
      l.startsWith("ROUTE_STATE_TRUNCATED: field=latest_user_message"),
    ),
  );
  assert.ok(requests[0].state.latest_user_message.includes("bytes omitted"));
});

test("catalog scan discovers nested SKILL.md directories across roots, first root winning name conflicts", () => {
  const rootA = makeTmpDir();
  const rootB = makeTmpDir();
  mkdirSync(join(rootA, "alpha"), { recursive: true });
  writeFileSync(join(rootA, "alpha", "SKILL.md"), "ALPHA-FROM-A");
  mkdirSync(join(rootA, "nested", "deep", "gamma"), { recursive: true });
  writeFileSync(join(rootA, "nested", "deep", "gamma", "SKILL.md"), "GAMMA");
  mkdirSync(join(rootB, "alpha"), { recursive: true });
  writeFileSync(join(rootB, "alpha", "SKILL.md"), "ALPHA-FROM-B");
  mkdirSync(join(rootB, "beta"), { recursive: true });
  writeFileSync(join(rootB, "beta", "SKILL.md"), "BETA");
  const catalog = scanSkillCatalog([rootA, rootB, join(rootB, "missing")]);
  const byName = new Map(catalog.map((s) => [s.name, s.body]));
  assert.deepEqual([...byName.keys()].sort(), ["alpha", "beta", "gamma"]);
  assert.equal(byName.get("alpha"), "ALPHA-FROM-A"); // first root wins
  assert.equal(byName.get("beta"), "BETA");
  assert.equal(byName.get("gamma"), "GAMMA"); // recursion through plain dirs
});

test("catalog scan does not recurse below a directory containing SKILL.md", () => {
  const root = makeTmpDir();
  mkdirSync(join(root, "outer", "inner"), { recursive: true });
  writeFileSync(join(root, "outer", "SKILL.md"), "OUTER");
  writeFileSync(join(root, "outer", "inner", "SKILL.md"), "INNER");
  const catalog = scanSkillCatalog([root]);
  assert.deepEqual(
    catalog.map((s) => s.name),
    ["outer"],
  );
});

// ------------------------------------------------------------------ client

test("Jev client POSTs state, model, and the full skill body in the noul question, and parses score and input tokens", async (t) => {
  const captured: {
    method?: string;
    url?: string;
    auth?: string;
    body?: string;
  } = {};
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      captured.method = req.method;
      captured.url = req.url;
      captured.auth = req.headers.authorization;
      captured.body = data;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          answers: { should_load: { noul: 0.83 } },
          usage: { input_tokens: 1234 },
        }),
      );
    });
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const scorer = createJevScorer({
    endpoint: `http://127.0.0.1:${address.port}/v1/systemone`,
    model: "jev-latest",
    apiKey: "test-key",
    timeoutMs: 5000,
  });
  const result = await scorer({
    state: fakeState("DIGEST-STATE"),
    skillName: "demo",
    skillBody: "FULL-SKILL-BODY",
  });
  assert.equal(result.score, 0.83);
  assert.equal(result.inputTokens, 1234);
  assert.equal(captured.method, "POST");
  assert.equal(captured.url, "/v1/systemone");
  assert.equal(captured.auth, "Bearer test-key");
  assert.ok(captured.body !== undefined);
  const payload = asRec(JSON.parse(captured.body));
  assert.deepEqual(payload.state, fakeState("DIGEST-STATE"));
  assert.equal(payload.model, "jev-latest");
  const shouldLoad = asRec(asRec(payload.questions).should_load);
  assert.equal(shouldLoad.type, "noul");
  const instructions = shouldLoad.instructions;
  assert.ok(typeof instructions === "string");
  assert.ok(instructions.includes("FULL-SKILL-BODY"));
  assert.ok(instructions.includes("'demo'"));
  // Frozen design (issue #8): the noul names the routing-state fields.
  assert.ok(instructions.includes("`latest_user_message`"));
  assert.ok(instructions.includes("`conversation_digest`"));
  assert.ok(typeof asRec(shouldLoad.criteria).true === "string");
});

test("Jev client maps HTTP errors, malformed bodies, and timeouts to score=null results", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/hang") return; // never respond
    if (req.url === "/e500") {
      res.writeHead(500);
      res.end("boom");
      return;
    }
    if (req.url === "/e429") {
      res.writeHead(429);
      res.end("busy");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("this is not json");
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const req: JevScoreRequest = {
    state: fakeState(""),
    skillName: "s",
    skillBody: "b",
  };
  const scorerFor = (path: string, timeoutMs = 5000) =>
    createJevScorer({
      endpoint: `${base}${path}`,
      model: "m",
      apiKey: "k",
      timeoutMs,
    });
  const r500 = await scorerFor("/e500")(req);
  assert.equal(r500.score, null);
  assert.equal(r500.error, "http_500");
  const r429 = await scorerFor("/e429")(req);
  assert.equal(r429.score, null);
  assert.equal(r429.error, "http_429");
  const rBad = await scorerFor("/bad")(req);
  assert.equal(rBad.score, null);
  assert.equal(rBad.error, "bad_response");
  const rTimeout = await scorerFor("/hang", 50)(req);
  assert.equal(rTimeout.score, null);
  assert.equal(rTimeout.error, "timeout");
});

// ------------------------------------------------------- config and policy

test("config loads defaults, merges user then project JSON, warns on malformed files", () => {
  const home = makeTmpDir();
  const project = makeTmpDir();
  const userConfigPath = join(home, "jev-context.json");
  const projectConfigPath = join(project, "jev-context.json");
  writeFileSync(
    userConfigPath,
    JSON.stringify({ topK: 2, loadThreshold: 0.5 }),
  );
  writeFileSync(projectConfigPath, JSON.stringify({ loadThreshold: 0.7 }));
  const paths = {
    userConfigPath,
    projectConfigPath,
    homeDir: home,
    cwd: project,
  };
  const first = loadConfig(paths);
  assert.equal(first.config.topK, 2);
  assert.equal(first.config.loadThreshold, 0.7); // project wins
  assert.equal(first.config.endpoint, "https://api.typesafe.ai/v1/systemone");
  assert.equal(first.config.digestCapBytes, 80_000);
  assert.deepEqual(first.config.skillRoots, defaultSkillRoots(home, project));
  assert.deepEqual(first.warnings, []);
  writeFileSync(projectConfigPath, "{ nope");
  const second = loadConfig(paths);
  assert.equal(second.config.loadThreshold, 0.5); // user layer survives
  assert.equal(second.warnings.length, 1);
});

test("API key resolves from the config-named env var first, then the key file, else null", () => {
  const dir = makeTmpDir();
  const keyFile = join(dir, "jev-key");
  writeFileSync(keyFile, " file-key\n");
  assert.equal(
    resolveApiKey(
      { apiKeyEnv: "JEV_TEST_KEY", apiKeyFile: keyFile },
      { JEV_TEST_KEY: "env-key" },
    ),
    "env-key",
  );
  assert.equal(
    resolveApiKey({ apiKeyEnv: "JEV_TEST_KEY", apiKeyFile: keyFile }, {}),
    "file-key",
  );
  assert.equal(
    resolveApiKey(
      { apiKeyEnv: "JEV_TEST_KEY", apiKeyFile: join(dir, "missing") },
      {},
    ),
    null,
  );
  assert.equal(
    resolveApiKey({ apiKeyEnv: "JEV_TEST_KEY", apiKeyFile: undefined }, {}),
    null,
  );
});

test("ROUTE_DECISION log carries epoch, scores, loaded, skipped_active, evicted, latency, tokens", async () => {
  const { router, logs } = makeRouter(
    [skillEntry("a", "A"), skillEntry("b", "B")],
    fakeScorer({ a: 0.9, b: 0.1 }),
  );
  await router.onBeforeAgentStart({ prompt: "hi", entries: [] });
  assert.ok(
    logs.includes(
      "ROUTE_DECISION: epoch=1 scores={a:0.9,b:0.1} loaded=[a] skipped_active=[] evicted=[] latency_ms=0 input_tokens=20",
    ),
  );
});

test("buildSkillInjection renders name and body into one user message", () => {
  const message = buildSkillInjection([{ name: "x", body: "BODY" }], 42);
  assert.equal(message.role, "user");
  assert.equal(message.timestamp, 42);
  assert.ok(textOf(message).includes('<skill name="x">\nBODY\n</skill>'));
});

// ------------------------------------------------------------- M3 lifecycle

function beforeStartEvent(prompt: string): BeforeAgentStartEvent {
  return {
    type: "before_agent_start",
    prompt,
    systemPrompt: "",
    systemPromptOptions:
      {} as unknown as BeforeAgentStartEvent["systemPromptOptions"],
  };
}

test("Given an active skill whose decay re-check scores < 0.25 at the K-th user turn since load, then it leaves the injection set at the next boundary", async () => {
  let scoreA = 0.9;
  const jevScore: JevScoreFn = async (req) => ({
    score: req.skillName === "a" ? scoreA : 0.1,
    inputTokens: 1,
    latencyMs: 1,
  });
  const { router, logs } = makeRouter([skillEntry("a", "A")], jevScore, {
    decayIntervalTurns: 2,
    decayThreshold: 0.25,
  });
  const turn = (prompt: string) =>
    router.onBeforeAgentStart({ prompt, entries: [] });
  await turn("one"); // a loads (0 turns since load)
  assert.deepEqual(
    router.activeSkills().map((s) => s.name),
    ["a"],
  );
  await turn("two"); // 1st turn since load: no re-check
  assert.deepEqual(
    router.activeSkills().map((s) => s.name),
    ["a"],
  );
  scoreA = 0.1;
  await turn("three"); // 2nd turn since load: re-check scores 0.1 < 0.25
  assert.deepEqual(router.activeSkills(), []);
  // Evicted skills leave the injection set at this boundary.
  assert.deepEqual(router.onContext(contextEvent([userMessage("x")])), {});
  assert.ok(logs.some((l) => l.includes("evicted=[a]")));
});

test("decay re-check at or above the decay threshold keeps the skill active", async () => {
  let scoreA = 0.9;
  const jevScore: JevScoreFn = async () => ({
    score: scoreA,
    inputTokens: 1,
    latencyMs: 1,
  });
  const { router } = makeRouter([skillEntry("a", "A")], jevScore, {
    decayIntervalTurns: 2,
    decayThreshold: 0.25,
  });
  const turn = (prompt: string) =>
    router.onBeforeAgentStart({ prompt, entries: [] });
  await turn("one");
  await turn("two");
  scoreA = 0.5;
  await turn("three"); // re-check: 0.5 >= 0.25 stays
  assert.deepEqual(
    router.activeSkills().map((s) => s.name),
    ["a"],
  );
});

test("decay re-check scoring errors never evict (fail-static)", async () => {
  let calls = 0;
  const jevScore: JevScoreFn = async () => {
    calls += 1;
    return calls === 1
      ? { score: 0.9, inputTokens: 1, latencyMs: 1 }
      : { score: null, inputTokens: 0, latencyMs: 1, error: "unreachable" };
  };
  const { router, logs } = makeRouter([skillEntry("a", "A")], jevScore, {
    decayIntervalTurns: 2,
    decayThreshold: 0.25,
  });
  const turn = (prompt: string) =>
    router.onBeforeAgentStart({ prompt, entries: [] });
  await turn("one");
  await turn("two");
  await turn("three"); // re-check errors: skill stays
  assert.deepEqual(
    router.activeSkills().map((s) => s.name),
    ["a"],
  );
  assert.ok(
    logs.some((l) => l.startsWith("ROUTE_DEGRADED: reason=unreachable")),
  );
});

test("Given a manual `/skill:name` invocation, then that skill is active and pinned against decay", async () => {
  const calls: string[] = [];
  const scoreB = 0.1;
  let lowScores = false;
  const jevScore: JevScoreFn = async (req) => {
    calls.push(req.skillName);
    const score = lowScores ? 0.1 : req.skillName === "b" ? scoreB : 0.9;
    return { score, inputTokens: 1, latencyMs: 1 };
  };
  const { router, telemetry } = makeRouter(
    [skillEntry("a", "A"), skillEntry("b", "B")],
    jevScore,
    { decayIntervalTurns: 2, decayThreshold: 0.25 },
  );
  const turn = (prompt: string) =>
    router.onBeforeAgentStart({ prompt, entries: [] });
  await turn("one"); // a routes in, b does not
  assert.equal(router.manualLoad("b"), true);
  assert.equal(router.manualLoad("nope"), false); // unknown skill
  // Pinned load is injected immediately, without waiting for a boundary.
  const content = textOf(
    injectedOf(router.onContext(contextEvent([userMessage("x")]))),
  );
  assert.ok(content.includes('<skill name="b">'));
  assert.ok(
    telemetry.some((e) => e.event === "SKILL_PINNED" && e.skill === "b"),
  );
  lowScores = true;
  calls.length = 0;
  await turn("two");
  await turn("three"); // a's 2nd turn since load: re-check 0.1 -> evicted
  await turn("four");
  await turn("five");
  assert.deepEqual(
    router.activeSkills().map((s) => s.name),
    ["b"], // pinned b survives; a was evicted
  );
  assert.ok(!calls.includes("b")); // pinned skills are never re-scored
});

test("Given a completed scoring pass, when the pass ends, then a `ROUTE_DECISION` record is appended to the telemetry JSONL with scores, loaded, skipped_active, evicted, latency, and tokens", async () => {
  const home = makeTmpDir();
  mkdirSync(join(home, ".pi", "agent", "skills", "demo"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "skills", "demo", "SKILL.md"),
    "DEMO-BODY",
  );
  const handlers = createJevContextExtension({
    homeDir: home,
    env: { PI_TYPESAFE_JEV: "test-key" },
    now: () => 1000,
    log: () => {},
    jevScore: fakeScorer({ demo: 0.9 }),
  });
  const ctx = {
    cwd: makeTmpDir(),
    ui: { notify: () => {} },
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionContext;
  handlers.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
  await handlers.onBeforeAgentStart(beforeStartEvent("one"), ctx);
  const file = join(home, ".pi", "agent", "jev-context-telemetry.jsonl");
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const rec = asRec(JSON.parse(lines[0]));
  assert.equal(rec.event, "ROUTE_DECISION");
  assert.equal(rec.epoch, 1);
  assert.deepEqual(rec.scores, { demo: 0.9 });
  assert.deepEqual(rec.loaded, ["demo"]);
  assert.deepEqual(rec.skipped_active, []);
  assert.deepEqual(rec.evicted, []);
  assert.equal(rec.latency_ms, 0);
  assert.equal(rec.input_tokens, 10);
  assert.equal(rec.ts, 1000);
});

test("Given a telemetry log with recorded decisions, when `/skill_stats` runs, then it renders aggregates: passes, loads, evictions, per-skill hit counts, and tokens spent", () => {
  const file = join(makeTmpDir(), "telemetry.jsonl");
  writeFileSync(
    file,
    [
      JSON.stringify({
        event: "ROUTE_DECISION",
        ts: 1,
        epoch: 1,
        scores: { a: 0.9, b: 0.2 },
        loaded: ["a"],
        skipped_active: [],
        evicted: [],
        latency_ms: 5,
        input_tokens: 100,
      }),
      JSON.stringify({
        event: "ROUTE_DECISION",
        ts: 2,
        epoch: 2,
        scores: { b: 0.7 },
        loaded: ["b"],
        skipped_active: ["a"],
        evicted: [],
        latency_ms: 5,
        input_tokens: 50,
      }),
      JSON.stringify({
        event: "ROUTE_DECISION",
        ts: 3,
        epoch: 3,
        scores: { a: 0.1 },
        loaded: [],
        skipped_active: ["a", "b"],
        evicted: ["a"],
        latency_ms: 5,
        input_tokens: 25,
      }),
      JSON.stringify({ event: "SKILL_PINNED", ts: 4, epoch: 3, skill: "c" }),
      // Nozzle-2 records coexist: skill aggregates ignore them (§3.9).
      JSON.stringify({
        event: "TOOL_SURFACE",
        ts: 5,
        epoch: 4,
        active: ["browser"],
        forced: [],
        scores: { browser: 0.9 },
        latency_ms: 3,
        input_tokens: 40,
      }),
      "not json",
      "",
    ].join("\n"),
  );
  const out = renderSkillStats(file);
  assert.ok(out.includes("route decisions: 3"));
  assert.ok(out.includes("loads: 2"));
  assert.ok(out.includes("evictions: 1"));
  assert.ok(out.includes("manual pins: 1"));
  assert.ok(out.includes("input tokens: 175"));
  assert.ok(out.includes("a: scored=2 loaded=1 evicted=1 avg_score=0.50"));
  assert.ok(out.includes("b: scored=2 loaded=1 evicted=0 avg_score=0.45"));
  assert.ok(
    renderSkillStats(join(makeTmpDir(), "missing.jsonl")).includes(
      "no telemetry",
    ),
  );
});

test("factory registers `skill_stats` and per-skill `skill:<name>` commands; a skill command pins the skill", async () => {
  const home = makeTmpDir();
  mkdirSync(join(home, ".pi", "agent", "skills", "demo"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "skills", "demo", "SKILL.md"),
    "DEMO-BODY",
  );
  const commands = new Map<
    string,
    (args: string, ctx: ExtensionCommandContext) => Promise<void>
  >();
  const handlers = createJevContextExtension(
    {
      homeDir: home,
      env: { PI_TYPESAFE_JEV: "test-key" },
      now: () => 1000,
      log: () => {},
      jevScore: fakeScorer({ demo: 0.1 }),
    },
    (name, options) => {
      commands.set(name, options.handler);
    },
  );
  assert.ok(commands.has("skill_stats"));
  const notifications: string[] = [];
  const cmdCtx = {
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionCommandContext;
  const ctx = {
    cwd: makeTmpDir(),
    ui: { notify: () => {} },
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionContext;
  handlers.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
  assert.ok(commands.has("skill:demo"));
  const pin = commands.get("skill:demo");
  assert.ok(pin !== undefined);
  await pin("", cmdCtx);
  // Pinned via command even though the router score (0.1) is below threshold.
  const content = textOf(
    injectedOf(handlers.onContext(contextEvent([userMessage("x")]))),
  );
  assert.ok(content.includes("DEMO-BODY"));
  const stats = commands.get("skill_stats");
  assert.ok(stats !== undefined);
  await stats("", cmdCtx);
  assert.ok(notifications.some((m) => m.includes("loaded and pinned")));
  assert.ok(notifications.some((m) => m.includes("manual pins: 1")));
});

// ============================================ Nozzle 2 — tool surfacing (M1)

/** Fake tool world: Pi's tool-set seams backed by a mutable array. */
function makeToolWorld(names: string[]) {
  const current = [...names];
  const all = names.map((name) => ({
    name,
    description: `${name} description`,
  }));
  const sets: string[][] = [];
  return {
    current,
    sets,
    seams: {
      getAllTools: () => all,
      getActiveTools: () => [...current],
      setActiveTools: (next: string[]) => {
        sets.push(next);
        current.length = 0;
        current.push(...next);
      },
    },
  };
}

function fakeNsScorer(scores: Record<string, number>): JevNamespaceScoreFn {
  return async (req) => {
    const out: Record<string, number | null> = {};
    for (const ns of req.namespaces) out[ns.name] = scores[ns.name] ?? 0;
    return { scores: out, inputTokens: 10, latencyMs: 1 };
  };
}

function makeNsRouter(
  namespaces: Record<string, ToolNamespaceConfig>,
  jevNamespaceScore: JevNamespaceScoreFn,
  world: ReturnType<typeof makeToolWorld>,
  extra: Partial<ToolSurfaceRouterDeps> = {},
) {
  const logs: string[] = [];
  const notifies: { message: string; type: string | undefined }[] = [];
  const telemetry: TelemetryEvent[] = [];
  const router = createToolSurfaceRouter({
    namespaces,
    coreTools: [...CORE_TOOLS],
    threshold: 0.6,
    apiKey: "test-key",
    jevNamespaceScore,
    ...world.seams,
    notify: (message, type) => notifies.push({ message, type }),
    log: (line) => logs.push(line),
    recordTelemetry: (event) => telemetry.push(event),
    now: () => 1000,
    ...extra,
  });
  return { router, logs, notifies, telemetry };
}

// ------------------------------------------------------------- §5 scenarios

test("Given the always-on core (read, write, edit, bash, grep, find, ls), then it is present in every LLM call regardless of Jev state", async () => {
  const world = makeToolWorld([...CORE_TOOLS, "browser_task", "send_whatsapp"]);
  let failing = false;
  const scorer: JevNamespaceScoreFn = async (req) =>
    failing
      ? { scores: null, inputTokens: 0, latencyMs: 1, error: "unreachable" }
      : fakeNsScorer({ browser: 0.1 })(req);
  const { router } = makeNsRouter(
    // Owner misconfiguration on purpose: the namespace lists a core tool.
    // Routing must never remove the core even when the namespace routes off.
    { browser: { tools: ["browser_task", "read"], prefix: undefined } },
    scorer,
    world,
  );
  await router.onBeforeAgentStart({ state: fakeState("d1") }); // browser routed off
  assert.ok(!world.current.includes("browser_task"));
  for (const core of CORE_TOOLS) assert.ok(world.current.includes(core));
  failing = true; // Jev down: fail-static restore, core untouched
  await router.onBeforeAgentStart({ state: fakeState("d2") });
  assert.ok(world.current.includes("browser_task"));
  for (const core of CORE_TOOLS) assert.ok(world.current.includes(core));
});

test("Given a turn whose routing state scores a tool namespace ≥ threshold, when the `context` event fires, then that namespace's schemas are included; below threshold, they are absent", async () => {
  const world = makeToolWorld([
    ...CORE_TOOLS,
    "browser_task",
    "browser_open",
    "tavily_search",
  ]);
  let browserScore = 0.9;
  const scorer: JevNamespaceScoreFn = async () => ({
    scores: { browser: browserScore, tavily: 0.2 },
    inputTokens: 5,
    latencyMs: 1,
  });
  const { router, logs } = makeNsRouter(
    {
      browser: { tools: [], prefix: "browser_" },
      tavily: { tools: ["tavily_search"], prefix: undefined },
    },
    scorer,
    world,
  );
  await router.onBeforeAgentStart({ state: fakeState("d1") });
  // browser ≥ 0.6: both prefix-resolved tools enter the set; tavily < 0.6:
  // its tool leaves the set it started in (Pi default = all visible).
  assert.ok(world.current.includes("browser_task"));
  assert.ok(world.current.includes("browser_open"));
  assert.ok(!world.current.includes("tavily_search"));
  assert.deepEqual(router.activeNamespaces(), ["browser"]);
  assert.ok(
    logs.some((l) =>
      l.startsWith(
        "TOOL_SURFACE: epoch=1 active=[browser] scores={browser:0.9,tavily:0.2}",
      ),
    ),
  );
  // Next boundary: browser drops below threshold and leaves at the boundary.
  browserScore = 0.2;
  await router.onBeforeAgentStart({ state: fakeState("d2") });
  assert.ok(!world.current.includes("browser_task"));
  assert.ok(!world.current.includes("browser_open"));
  assert.deepEqual(router.activeNamespaces(), []);
});

test("one batched Jev request per epoch carries one noul per configured namespace over the routing state shared with skill routing", async () => {
  const home = makeTmpDir();
  mkdirSync(join(home, ".pi", "agent", "skills", "demo"), {
    recursive: true,
  });
  writeFileSync(
    join(home, ".pi", "agent", "skills", "demo", "SKILL.md"),
    "DEMO-BODY",
  );
  const cwd = makeTmpDir();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "jev-context.json"),
    JSON.stringify({
      toolNamespaces: {
        browser: { prefix: "browser_" },
        goal: { tools: ["goal_advance"] },
      },
    }),
  );
  const world = makeToolWorld([...CORE_TOOLS, "browser_task", "goal_advance"]);
  const skillStates: RoutingState[] = [];
  const nsRequests: NamespaceScoreRequest[] = [];
  const handlers = createJevContextExtension({
    homeDir: home,
    env: { PI_TYPESAFE_JEV: "test-key" },
    now: () => 1000,
    log: () => {},
    jevScore: async (req) => {
      skillStates.push(req.state);
      return { score: 0.1, inputTokens: 1, latencyMs: 1 };
    },
    jevNamespaceScore: async (req) => {
      nsRequests.push(req);
      return {
        scores: { browser: 0.9, goal: 0.1 },
        inputTokens: 5,
        latencyMs: 1,
      };
    },
    tools: world.seams,
  });
  const ctx = {
    cwd,
    ui: { notify: () => {} },
    sessionManager: {
      getBranch: () => [messageEntry(userMessage("earlier turn"))],
    },
  } as unknown as ExtensionContext;
  handlers.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
  await handlers.onBeforeAgentStart(beforeStartEvent("now prompt"), ctx);
  // One boundary -> exactly one batched namespace request, both namespaces in it.
  assert.equal(nsRequests.length, 1);
  assert.deepEqual(
    nsRequests[0].namespaces.map((n) => n.name),
    ["browser", "goal"],
  );
  // The routing state is built once per boundary and shared with Nozzle 1:
  // the latest message verbatim in its own field, digest alongside it.
  const expectedDigest = "[user] earlier turn\n[user] now prompt\n";
  assert.deepEqual(
    nsRequests[0].state,
    fakeState(expectedDigest, "now prompt"),
  );
  assert.deepEqual(skillStates, [fakeState(expectedDigest, "now prompt")]);
  assert.ok(nsRequests[0].namespaces[0].descriptions.includes("browser_task"));
  // Boundary-applied surfacing: browser on (0.9), goal off (0.1).
  assert.ok(world.current.includes("browser_task"));
  assert.ok(!world.current.includes("goal_advance"));
});

// ------------------------------------------------------------- client

test("batched namespace client POSTs one request with one noul per namespace and parses per-namespace scores", async (t) => {
  const captured: { auth?: string; body?: string } = {};
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      captured.auth = req.headers.authorization;
      captured.body = data;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          answers: {
            surface_browser: { noul: 0.77 },
            surface_goal: { noul: 0.12 },
          },
          usage: { input_tokens: 432 },
        }),
      );
    });
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const scorer = createJevNamespaceScorer({
    endpoint: `http://127.0.0.1:${address.port}/v1/systemone`,
    model: "jev-latest",
    apiKey: "test-key",
    timeoutMs: 5000,
  });
  const result = await scorer({
    state: fakeState("DIGEST-STATE"),
    namespaces: [
      {
        name: "browser",
        descriptions: "browser_task: drives Chrome",
        description: "Headed-Chrome browser automation",
      },
      { name: "goal", descriptions: "goal_advance: marks items done" },
    ],
  });
  assert.deepEqual(result.scores, { browser: 0.77, goal: 0.12 });
  assert.equal(result.inputTokens, 432);
  assert.equal(captured.auth, "Bearer test-key");
  assert.ok(captured.body !== undefined);
  const payload = asRec(JSON.parse(captured.body));
  assert.deepEqual(payload.state, fakeState("DIGEST-STATE"));
  assert.deepEqual(Object.keys(asRec(payload.questions)).sort(), [
    "surface_browser",
    "surface_goal",
  ]);
  const browserQ = asRec(asRec(payload.questions).surface_browser);
  assert.equal(browserQ.type, "noul");
  assert.ok(typeof asRec(browserQ.criteria).true === "string");
  const instructions = browserQ.instructions;
  assert.ok(typeof instructions === "string");
  assert.ok(instructions.includes("'browser'"));
  assert.ok(instructions.includes("browser_task: drives Chrome"));
  // Frozen design (issue #8): the configured namespace description rides as
  // "<name>: <description>; tools:" ahead of the tool lines, and the noul
  // names the routing-state fields.
  assert.ok(
    instructions.includes(
      "browser: Headed-Chrome browser automation; tools:\n",
    ),
  );
  assert.ok(instructions.includes("`latest_user_message`"));
  // No description configured: the goal noul has no header line.
  const goalQ = asRec(asRec(payload.questions).surface_goal);
  const goalInstructions = goalQ.instructions;
  assert.ok(typeof goalInstructions === "string");
  assert.ok(!goalInstructions.includes("; tools:"));
  assert.ok(surfaceQuestionKey("browser") === "surface_browser");
});

test("batched namespace client maps HTTP errors, malformed bodies, and timeouts to scores=null results", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/hang") return; // never respond
    if (req.url === "/e500") {
      res.writeHead(500);
      res.end("boom");
      return;
    }
    if (req.url === "/e429") {
      res.writeHead(429);
      res.end("busy");
      return;
    }
    if (req.url === "/partial") {
      // One namespace answer missing: per-namespace null, not whole-failure.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answers: { surface_a: { noul: 0.5 } } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("this is not json");
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const req: NamespaceScoreRequest = {
    state: fakeState(""),
    namespaces: [
      { name: "a", descriptions: "a: x" },
      { name: "b", descriptions: "b: y" },
    ],
  };
  const scorerFor = (path: string, timeoutMs = 5000) =>
    createJevNamespaceScorer({
      endpoint: `${base}${path}`,
      model: "m",
      apiKey: "k",
      timeoutMs,
    });
  const r500 = await scorerFor("/e500")(req);
  assert.equal(r500.scores, null);
  assert.equal(r500.error, "http_500");
  const r429 = await scorerFor("/e429")(req);
  assert.equal(r429.scores, null);
  assert.equal(r429.error, "http_429");
  const rBad = await scorerFor("/bad")(req);
  assert.equal(rBad.scores, null);
  assert.equal(rBad.error, "bad_response");
  const rTimeout = await scorerFor("/hang", 50)(req);
  assert.equal(rTimeout.scores, null);
  assert.equal(rTimeout.error, "timeout");
  const rPartial = await scorerFor("/partial")(req);
  assert.deepEqual(rPartial.scores, { a: 0.5, b: null });
});

// ------------------------------------------------------- config and policy

test("config parses toolNamespaces (tools + prefix + description), toolSurfaceThreshold, and extends the core floor", () => {
  const home = makeTmpDir();
  const project = makeTmpDir();
  const userConfigPath = join(home, "jev-context.json");
  const projectConfigPath = join(project, "jev-context.json");
  writeFileSync(
    userConfigPath,
    JSON.stringify({
      toolNamespaces: {
        browser: { prefix: "browser_", description: "Browser automation" },
        goal: { tools: ["goal_advance", "goal_park"], description: "" },
        broken: { tools: [] },
      },
      toolSurfaceThreshold: 0.5,
      coreTools: ["powershell", "read"],
    }),
  );
  writeFileSync(
    projectConfigPath,
    JSON.stringify({ toolNamespaces: { pins: { tools: ["pin_set"] } } }),
  );
  const { config, warnings } = loadConfig({
    userConfigPath,
    projectConfigPath,
    homeDir: home,
    cwd: project,
  });
  // Project layer replaces the namespace map wholesale (same merge semantics
  // as every other config field).
  assert.deepEqual(config.toolNamespaces, {
    pins: { tools: ["pin_set"], prefix: undefined },
  });
  assert.equal(config.toolSurfaceThreshold, 0.5);
  // Owner coreTools extend the hardcoded floor; `read` deduped.
  for (const core of CORE_TOOLS) assert.ok(config.coreTools.includes(core));
  assert.ok(config.coreTools.includes("powershell"));
  assert.equal(config.coreTools.filter((t) => t === "read").length, 1);
  assert.ok(warnings.some((w) => w.includes("toolNamespaces.broken")));
  // Namespace description: owner metadata (issue #8), parsed when non-empty;
  // an empty string is treated as absent. Asserted on the user layer, which
  // the project layer above replaced wholesale.
  const solo = loadConfig({
    userConfigPath,
    projectConfigPath: join(project, "absent.json"),
    homeDir: home,
    cwd: project,
  });
  assert.equal(
    solo.config.toolNamespaces.browser.description,
    "Browser automation",
  );
  assert.equal(solo.config.toolNamespaces.goal.description, undefined);
});

test("namespace resolution intersects explicit tools with available tools, matches prefixes, and logs unknown names once", async () => {
  const world = makeToolWorld([...CORE_TOOLS, "browser_task", "tavily_search"]);
  const { router, logs } = makeNsRouter(
    {
      web: { tools: ["browser_task", "nonexistent_tool"], prefix: "tavily_" },
    },
    fakeNsScorer({ web: 0.9 }),
    world,
  );
  await router.onBeforeAgentStart({ state: fakeState("d1") });
  await router.onBeforeAgentStart({ state: fakeState("d2") });
  const configLogs = logs.filter((l) => l.startsWith("TOOL_SURFACE_CONFIG:"));
  assert.deepEqual(configLogs, [
    "TOOL_SURFACE_CONFIG: namespace=web unknown_tool=nonexistent_tool",
  ]); // once per session, not per boundary
  // Explicit + prefix union resolved; unknown name never enters the set.
  assert.ok(world.current.includes("browser_task"));
  assert.ok(world.current.includes("tavily_search"));
  assert.ok(!world.current.includes("nonexistent_tool"));
});

test("batch scoring failure restores every configured namespace to visible (fail-static) and logs ROUTE_DEGRADED", async () => {
  const world = makeToolWorld([...CORE_TOOLS, "tavily_search", "tavily_map"]);
  let failing = false;
  const scorer: JevNamespaceScoreFn = async (req) =>
    failing
      ? { scores: null, inputTokens: 0, latencyMs: 1, error: "http_500" }
      : fakeNsScorer({ tavily: 0.1 })(req);
  const { router, logs, notifies } = makeNsRouter(
    { tavily: { tools: [], prefix: "tavily_" } },
    scorer,
    world,
  );
  await router.onBeforeAgentStart({ state: fakeState("d1") }); // tavily routed off
  assert.ok(!world.current.includes("tavily_search"));
  failing = true;
  await router.onBeforeAgentStart({ state: fakeState("d2") }); // Jev down: restore all
  assert.ok(world.current.includes("tavily_search"));
  assert.ok(world.current.includes("tavily_map"));
  assert.equal(notifies.length, 1);
  assert.equal(notifies[0].type, "warning");
  assert.ok(
    logs.some((l) =>
      l.startsWith("ROUTE_DEGRADED: reason=http_500 nozzle=tools"),
    ),
  );
  await router.onBeforeAgentStart({ state: fakeState("d3") }); // still down
  assert.equal(notifies.length, 1); // once per error class
  assert.equal(
    logs.filter((l) => l.startsWith("ROUTE_DEGRADED:")).length,
    2, // logged every time
  );
});

test("unchanged routing produces no setActiveTools call; unconfigured tools are never touched", async () => {
  const world = makeToolWorld([
    ...CORE_TOOLS,
    "browser_task",
    "heavy_think", // not in any namespace: Pi default, untouched by routing
  ]);
  const { router } = makeNsRouter(
    { browser: { tools: [], prefix: "browser_" } },
    fakeNsScorer({ browser: 0.1 }),
    world,
  );
  await router.onBeforeAgentStart({ state: fakeState("d1") }); // removes browser_task
  assert.equal(world.sets.length, 1);
  await router.onBeforeAgentStart({ state: fakeState("d2") }); // identical outcome
  assert.equal(world.sets.length, 1); // no-op suppressed
  assert.ok(world.current.includes("heavy_think"));
  assert.ok(!world.current.includes("browser_task"));
});

test("tool surfacing is inert without an API key and without configured namespaces", async () => {
  const world = makeToolWorld([...CORE_TOOLS, "browser_task"]);
  let calls = 0;
  const scorer: JevNamespaceScoreFn = async () => {
    calls += 1;
    return { scores: {}, inputTokens: 0, latencyMs: 1 };
  };
  const noKey = makeNsRouter(
    { browser: { tools: [], prefix: "browser_" } },
    scorer,
    world,
    { apiKey: null },
  );
  await noKey.router.onBeforeAgentStart({ state: fakeState("d") });
  const noNamespaces = makeNsRouter({}, scorer, world);
  await noNamespaces.router.onBeforeAgentStart({ state: fakeState("d") });
  assert.equal(calls, 0); // no Jev traffic
  assert.equal(world.sets.length, 0); // Pi's default tool set untouched
});

test("namespace with a per-namespace parse gap stays visible (fail-static) while scored namespaces route normally", async () => {
  const world = makeToolWorld([...CORE_TOOLS, "browser_task", "goal_advance"]);
  const scorer: JevNamespaceScoreFn = async () => ({
    scores: { browser: null, goal: 0.1 },
    inputTokens: 5,
    latencyMs: 1,
  });
  const { router, logs } = makeNsRouter(
    {
      browser: { tools: [], prefix: "browser_" },
      goal: { tools: ["goal_advance"], prefix: undefined },
    },
    scorer,
    world,
  );
  await router.onBeforeAgentStart({ state: fakeState("d") });
  assert.ok(world.current.includes("browser_task")); // gap -> visible
  assert.ok(!world.current.includes("goal_advance")); // scored low -> off
  assert.deepEqual(router.activeNamespaces(), ["browser"]);
  assert.ok(
    logs.some((l) =>
      l.startsWith("ROUTE_DEGRADED: reason=bad_response nozzle=tools"),
    ),
  );
});

// ============================================ Nozzle 2 — degradation (M2)

/** Pi's synthesized unknown-tool result (agent-loop createErrorToolResult). */
function notFoundResult(toolName: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `tc-${toolName}`,
    toolName,
    content: [{ type: "text", text: `Tool ${toolName} not found` }],
    isError: true,
    timestamp: 1,
  };
}

test("Given Jev is down, then all namespaces behave as Pi default (fail-static), and a `ROUTE_DEGRADED` line is logged", async () => {
  const world = makeToolWorld([...CORE_TOOLS, "browser_task", "tavily_search"]);
  let down = false;
  const scorer: JevNamespaceScoreFn = async (req) =>
    down
      ? { scores: null, inputTokens: 0, latencyMs: 1, error: "unreachable" }
      : fakeNsScorer({ browser: 0.1, tavily: 0.1 })(req);
  const { router, logs, notifies } = makeNsRouter(
    {
      browser: { tools: [], prefix: "browser_" },
      tavily: { tools: [], prefix: "tavily_" },
    },
    scorer,
    world,
  );
  await router.onBeforeAgentStart({ state: fakeState("d1") }); // both routed off
  assert.ok(!world.current.includes("browser_task"));
  assert.ok(!world.current.includes("tavily_search"));
  down = true;
  await router.onBeforeAgentStart({ state: fakeState("d2") });
  // Pi default = every namespace visible again.
  assert.ok(world.current.includes("browser_task"));
  assert.ok(world.current.includes("tavily_search"));
  assert.deepEqual(router.activeNamespaces(), ["browser", "tavily"]);
  assert.ok(
    logs.some((l) =>
      l.startsWith("ROUTE_DEGRADED: reason=unreachable nozzle=tools"),
    ),
  );
  assert.equal(notifies.length, 1); // one notify, error class unreachable
});

test("Given a single 429 from the batched namespace request, then the current tool set is frozen for that epoch without a degradation notify, and scoring retries at the next boundary", async () => {
  const world = makeToolWorld([...CORE_TOOLS, "browser_task", "tavily_search"]);
  let mode: "score" | "429" = "score";
  const scorer: JevNamespaceScoreFn = async (req) =>
    mode === "429"
      ? { scores: null, inputTokens: 0, latencyMs: 1, error: "http_429" }
      : fakeNsScorer({ browser: 0.1, tavily: 0.9 })(req);
  const { router, logs, notifies, telemetry } = makeNsRouter(
    {
      browser: { tools: [], prefix: "browser_" },
      tavily: { tools: [], prefix: "tavily_" },
    },
    scorer,
    world,
  );
  await router.onBeforeAgentStart({ state: fakeState("d1") }); // off/on
  assert.ok(!world.current.includes("browser_task"));
  assert.ok(world.current.includes("tavily_search"));
  mode = "429";
  await router.onBeforeAgentStart({ state: fakeState("d2") }); // freeze
  assert.ok(!world.current.includes("browser_task")); // unchanged
  assert.ok(world.current.includes("tavily_search")); // unchanged
  assert.equal(notifies.length, 0); // transient: no user-facing notify
  assert.ok(
    logs.some((l) =>
      l.startsWith(
        "ROUTE_DEGRADED: reason=http_429 nozzle=tools action=keep_current",
      ),
    ),
  );
  const degraded = telemetry.filter(
    (e) => e.event === "TOOL_SURFACE" && e.degraded === "http_429",
  );
  assert.equal(degraded.length, 1);
  mode = "score";
  await router.onBeforeAgentStart({ state: fakeState("d3") }); // retry
  assert.ok(!world.current.includes("browser_task")); // routing resumes
});

test("Given a repeated 429 after a frozen epoch, then every configured namespace fails static to visible, ROUTE_DEGRADED is logged, and the owner is notified once", async () => {
  const world = makeToolWorld([...CORE_TOOLS, "browser_task", "tavily_search"]);
  let mode: "score" | "429" = "score";
  const scorer: JevNamespaceScoreFn = async (req) =>
    mode === "429"
      ? { scores: null, inputTokens: 0, latencyMs: 1, error: "http_429" }
      : fakeNsScorer({ browser: 0.1, tavily: 0.9 })(req);
  const { router, logs, notifies, telemetry } = makeNsRouter(
    {
      browser: { tools: [], prefix: "browser_" },
      tavily: { tools: [], prefix: "tavily_" },
    },
    scorer,
    world,
  );
  await router.onBeforeAgentStart({ state: fakeState("d1") }); // off/on
  assert.ok(!world.current.includes("browser_task"));
  assert.ok(world.current.includes("tavily_search"));
  mode = "429";
  await router.onBeforeAgentStart({ state: fakeState("d2") }); // freeze
  assert.equal(notifies.length, 0);
  await router.onBeforeAgentStart({ state: fakeState("d3") }); // fail static
  assert.ok(world.current.includes("browser_task")); // restored
  assert.ok(world.current.includes("tavily_search"));
  assert.equal(notifies.length, 1);
  assert.equal(notifies[0].type, "warning");
  assert.ok(
    logs.some((l) =>
      l.startsWith("ROUTE_DEGRADED: reason=http_429 nozzle=tools batch"),
    ),
  );
  // Telemetry marks both degraded epochs with the error class.
  const degraded = telemetry.filter(
    (e) => e.event === "TOOL_SURFACE" && e.degraded === "http_429",
  );
  assert.equal(degraded.length, 2);
});

test("a successful scoring pass resets the 429 counter; a later single 429 freezes again without notifying twice", async () => {
  const world = makeToolWorld([...CORE_TOOLS, "browser_task", "tavily_search"]);
  let mode: "score" | "429" = "score";
  const scorer: JevNamespaceScoreFn = async (req) =>
    mode === "429"
      ? { scores: null, inputTokens: 0, latencyMs: 1, error: "http_429" }
      : fakeNsScorer({ browser: 0.1, tavily: 0.9 })(req);
  const { router, notifies } = makeNsRouter(
    {
      browser: { tools: [], prefix: "browser_" },
      tavily: { tools: [], prefix: "tavily_" },
    },
    scorer,
    world,
  );
  await router.onBeforeAgentStart({ state: fakeState("d1") }); // off/on
  mode = "429";
  await router.onBeforeAgentStart({ state: fakeState("d2") }); // freeze
  await router.onBeforeAgentStart({ state: fakeState("d3") }); // fail static
  assert.equal(notifies.length, 1);
  mode = "score";
  await router.onBeforeAgentStart({ state: fakeState("d4") }); // resets
  assert.ok(!world.current.includes("browser_task")); // routing resumes
  mode = "429";
  await router.onBeforeAgentStart({ state: fakeState("d5") }); // freeze
  assert.ok(!world.current.includes("browser_task")); // frozen, not restored
  assert.equal(notifies.length, 1); // still just the one notify
});

test("session_start restores every configured namespace to visible before the first boundary, with or without an API key", async () => {
  const world = makeToolWorld([...CORE_TOOLS, "browser_task"]);
  // Stale routing from a previous session: browser_task was surfaced off.
  world.seams.setActiveTools([...CORE_TOOLS]);
  assert.ok(!world.current.includes("browser_task"));
  let calls = 0;
  const scorer: JevNamespaceScoreFn = async () => {
    calls += 1;
    return { scores: { browser: 0.1 }, inputTokens: 1, latencyMs: 1 };
  };
  const namespaces = { browser: { tools: [], prefix: "browser_" } };
  const withKey = makeNsRouter(namespaces, scorer, world);
  withKey.router.onSessionStart();
  assert.ok(world.current.includes("browser_task")); // baseline restored
  assert.equal(calls, 0); // restore never scores
  // Same fail-static baseline when the key is missing (§3.5, §5 cross-cutting).
  world.seams.setActiveTools([...CORE_TOOLS]);
  const noKey = makeNsRouter(namespaces, scorer, world, { apiKey: null });
  noKey.router.onSessionStart();
  assert.ok(world.current.includes("browser_task"));
  assert.equal(calls, 0);
});

test("Given a tool call answered with Pi's synthesized unknown-tool result, then the owning namespace is force-surfaced at the next boundary for one epoch, logged as TOOL_SURFACE_MISS", async () => {
  const world = makeToolWorld([...CORE_TOOLS, "browser_task"]);
  const { router, logs, telemetry } = makeNsRouter(
    { browser: { tools: [], prefix: "browser_" } },
    fakeNsScorer({ browser: 0.1 }), // below threshold every epoch
    world,
  );
  await router.onBeforeAgentStart({ state: fakeState("d1") }); // browser routed off
  assert.ok(!world.current.includes("browser_task"));
  // The model tries browser_task anyway; Pi answers with the synthesized
  // unknown-tool error. Detection happens on message_end.
  router.onMessageEnd(notFoundResult("browser_task"));
  await router.onBeforeAgentStart({ state: fakeState("d2") }); // miss recovery boundary
  assert.ok(world.current.includes("browser_task")); // forced on despite 0.1
  assert.deepEqual(router.activeNamespaces(), ["browser"]);
  assert.ok(
    logs.some((l) =>
      l.startsWith(
        "TOOL_SURFACE_MISS: namespace=browser tool=browser_task epoch=2",
      ),
    ),
  );
  assert.ok(
    logs.some(
      (l) =>
        l.startsWith("TOOL_SURFACE: epoch=2 active=[browser]") &&
        l.includes("forced=[browser]"),
    ),
  );
  const rec = telemetry.find(
    (e): e is Extract<TelemetryEvent, { event: "TOOL_SURFACE" }> =>
      e.event === "TOOL_SURFACE" && e.epoch === 2,
  );
  assert.deepEqual(rec?.forced, ["browser"]);
  // One-shot: the miss is consumed; scoring rules again at the next boundary.
  await router.onBeforeAgentStart({ state: fakeState("d3") });
  assert.ok(!world.current.includes("browser_task"));
  assert.deepEqual(router.activeNamespaces(), []);
});

test("unknown-tool errors for unconfigured tools log once and never force-surface; ordinary tool errors are ignored", async () => {
  const world = makeToolWorld([...CORE_TOOLS, "browser_task"]);
  const { router, logs } = makeNsRouter(
    { browser: { tools: [], prefix: "browser_" } },
    fakeNsScorer({ browser: 0.9 }),
    world,
  );
  // Ordinary execution error: not the unknown-tool shape, ignored.
  router.onMessageEnd({
    role: "toolResult",
    toolCallId: "tc-1",
    toolName: "bash",
    content: [{ type: "text", text: "Tool bash not found in cache" }],
    isError: true,
    timestamp: 1,
  });
  router.onMessageEnd({
    role: "toolResult",
    toolCallId: "tc-2",
    toolName: "bash",
    content: [{ type: "text", text: "exit code 1" }],
    isError: true,
    timestamp: 2,
  });
  assert.deepEqual(logs, []);
  // Unconfigured tool, exact unknown-tool shape: logged once, not recovered.
  router.onMessageEnd(notFoundResult("mystery_tool"));
  router.onMessageEnd(notFoundResult("mystery_tool"));
  assert.deepEqual(logs, [
    "TOOL_SURFACE_MISS: tool=mystery_tool namespace=unconfigured",
  ]);
  await router.onBeforeAgentStart({ state: fakeState("d") });
  assert.ok(logs.join("\n").includes("forced=[]")); // nothing forced
  assert.ok(!world.current.includes("mystery_tool"));
});

test("wiring detects the miss on message_end, force-surfaces at the next boundary, and appends TOOL_SURFACE telemetry per epoch", async () => {
  const home = makeTmpDir();
  const cwd = makeTmpDir();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "jev-context.json"),
    JSON.stringify({ toolNamespaces: { browser: { prefix: "browser_" } } }),
  );
  const world = makeToolWorld([...CORE_TOOLS, "browser_task"]);
  const logs: string[] = [];
  const handlers = createJevContextExtension({
    homeDir: home,
    env: { PI_TYPESAFE_JEV: "test-key" },
    now: () => 1000,
    log: (line) => logs.push(line),
    jevNamespaceScore: fakeNsScorer({ browser: 0.1 }),
    tools: world.seams,
  });
  const ctx = {
    cwd,
    ui: { notify: () => {} },
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionContext;
  handlers.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
  await handlers.onBeforeAgentStart(beforeStartEvent("one"), ctx);
  assert.ok(!world.current.includes("browser_task")); // routed off
  handlers.onMessageEnd({
    type: "message_end",
    message: notFoundResult("browser_task"),
  });
  await handlers.onBeforeAgentStart(beforeStartEvent("two"), ctx);
  assert.ok(world.current.includes("browser_task")); // recovered
  // Telemetry JSONL: one TOOL_SURFACE record per boundary, miss marked forced.
  const file = join(home, ".pi", "agent", "jev-context-telemetry.jsonl");
  const records = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => asRec(JSON.parse(l)));
  const surfaces = records.filter((r) => r.event === "TOOL_SURFACE");
  assert.equal(surfaces.length, 2);
  assert.equal(surfaces[0].epoch, 1);
  assert.deepEqual(surfaces[0].active, []);
  assert.deepEqual(surfaces[0].forced, []);
  assert.deepEqual(surfaces[0].scores, { browser: 0.1 });
  assert.equal(surfaces[0].input_tokens, 10);
  assert.equal(surfaces[0].latency_ms, 0);
  assert.equal(surfaces[0].ts, 1000);
  assert.deepEqual(surfaces[1].active, ["browser"]);
  assert.deepEqual(surfaces[1].forced, ["browser"]);
});

test("Given a user message naming a configured namespace or installed skill, then the routing request carries it as `latest_user_message` and the namespace description when configured", async () => {
  const home = makeTmpDir();
  mkdirSync(join(home, ".pi", "agent", "skills", "demo"), {
    recursive: true,
  });
  writeFileSync(
    join(home, ".pi", "agent", "skills", "demo", "SKILL.md"),
    "DEMO-BODY",
  );
  const cwd = makeTmpDir();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "jev-context.json"),
    JSON.stringify({
      toolNamespaces: {
        tavily: {
          prefix: "tavily_",
          description: "Web search, extraction, and site crawling APIs",
        },
      },
    }),
  );
  const world = makeToolWorld([...CORE_TOOLS, "tavily_search", "tavily_map"]);
  const skillRequests: JevScoreRequest[] = [];
  const nsRequests: NamespaceScoreRequest[] = [];
  const handlers = createJevContextExtension({
    homeDir: home,
    env: { PI_TYPESAFE_JEV: "test-key" },
    now: () => 1000,
    log: () => {},
    jevScore: async (req) => {
      skillRequests.push(req);
      return { score: 0.1, inputTokens: 1, latencyMs: 1 };
    },
    jevNamespaceScore: async (req) => {
      nsRequests.push(req);
      return { scores: { tavily: 0.9 }, inputTokens: 5, latencyMs: 1 };
    },
    tools: world.seams,
  });
  const ctx = {
    cwd,
    ui: { notify: () => {} },
    sessionManager: {
      getBranch: () => [messageEntry(userMessage("earlier turn"))],
    },
  } as unknown as ExtensionContext;
  handlers.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
  // The user names the namespace explicitly (issue #8's live miss).
  await handlers.onBeforeAgentStart(
    beforeStartEvent("pull the latest numbers with tavily"),
    ctx,
  );
  // Both scorers received ONE shared routing state: the explicit mention
  // verbatim in its own field, the newest-first digest alongside it.
  const expectedDigest =
    "[user] earlier turn\n[user] pull the latest numbers with tavily\n";
  assert.deepEqual(nsRequests[0].state, {
    latest_user_message: "pull the latest numbers with tavily",
    conversation_digest: expectedDigest,
  });
  assert.deepEqual(skillRequests[0].state, nsRequests[0].state);
  // The configured namespace description rides in that namespace's payload
  // (the client embeds it in the noul instructions — covered at the fixture
  // server in the batched-client POST test).
  assert.deepEqual(
    nsRequests[0].namespaces.map((n) => [n.name, n.description]),
    [["tavily", "Web search, extraction, and site crawling APIs"]],
  );
});

// ============================ Nozzle 3 — epoch capture + verdict cache (M1)

// ------------------------------------------------------------- helpers

function toolCallPart(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function toolResultMessage(
  callId: string,
  toolName: string,
  text: string,
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: callId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  };
}

/** Branch entries for one settled epoch: a prior turn, the user anchor that
 *  opens the judged epoch, two complete pairs, and the closing text. */
function epochEntries(): DigestEntry[] {
  return [
    messageEntry(userMessage("earlier question")),
    messageEntry(
      assistantMessage([toolCallPart("tc-old", "bash", { command: "old" })]),
    ),
    messageEntry(toolResultMessage("tc-old", "bash", "OLD-OUTPUT")),
    messageEntry(userMessage("find the config and read it")),
    messageEntry(
      assistantMessage([
        { type: "thinking", thinking: "THINKING-TRACE" },
        toolCallPart("tc-1", "grep", { pattern: "port" }),
        toolCallPart("tc-2", "read", { path: "/etc/app.conf" }),
      ]),
    ),
    messageEntry(toolResultMessage("tc-1", "grep", "GREP-HITS")),
    messageEntry(toolResultMessage("tc-2", "read", "CONFIG-BODY")),
    messageEntry(
      assistantMessage([{ type: "text", text: "The port is 8080." }]),
    ),
  ];
}

function fakePruneJudge(scores: Record<string, number>): JevPruneJudgeFn {
  return async (req) => ({
    scores: Object.fromEntries(
      req.pairs.map((p) => [p.id, scores[p.id] ?? 0.5]),
    ),
    inputTokens: 25,
    latencyMs: 1,
  });
}

function makePruner(
  jevPruneJudge: JevPruneJudgeFn,
  extra: Partial<EpochPrunerDeps> = {},
) {
  const logs: string[] = [];
  const notifies: { message: string; type: string | undefined }[] = [];
  const telemetry: TelemetryEvent[] = [];
  const pruner = createEpochPruner({
    apiKey: "test-key",
    jevPruneJudge,
    stateCapBytes: 60_000,
    pruneThreshold: 0.2,
    notify: (message, type) => notifies.push({ message, type }),
    log: (line) => logs.push(line),
    recordTelemetry: (event) => telemetry.push(event),
    now: () => 1000,
    ...extra,
  });
  return { pruner, logs, notifies, telemetry };
}

// ------------------------------------------------------------- §5 scenarios

test('Given a closed agent epoch, when `agent_settled` fires, then each tool call/result pair of that epoch is judged once ("helpful to subsequent turns?"), verdicts cached by message id', async () => {
  const requests: PruneJudgeRequest[] = [];
  const judge: JevPruneJudgeFn = async (req) => {
    requests.push(req);
    return fakePruneJudge({ "tc-1": 0.9, "tc-2": 0.1 })(req);
  };
  const { pruner, logs, telemetry } = makePruner(judge);
  await pruner.onAgentSettled(epochEntries());
  // ONE batched request for the epoch, one question per pair of the epoch.
  assert.equal(requests.length, 1);
  assert.deepEqual(
    requests[0].pairs.map((p) => p.id),
    ["tc-1", "tc-2"],
  );
  // The prior epoch's pair is not judged.
  assert.ok(!requests[0].pairs.some((p) => p.id === "tc-old"));
  // State = the epoch: user message, assistant text, thinking, tool call
  // names/args, and the outputs under judgment — but not the prior epoch.
  const state = requests[0].state;
  assert.ok(state.includes("[user] find the config and read it"));
  assert.ok(state.includes("[assistant thinking] THINKING-TRACE"));
  assert.ok(state.includes('[tool_call #1 grep] {"pattern":"port"}'));
  assert.ok(state.includes("[tool_result #1 grep] GREP-HITS"));
  assert.ok(state.includes("[tool_result #2 read] CONFIG-BODY"));
  assert.ok(state.includes("[assistant] The port is 8080."));
  assert.ok(!state.includes("OLD-OUTPUT"));
  assert.ok(!state.includes("earlier question"));
  // Verdicts cached by the pair's message id (toolCall id), score intact.
  assert.equal(pruner.verdict("tc-1")?.score, 0.9);
  assert.equal(pruner.verdict("tc-2")?.score, 0.1);
  assert.equal(pruner.verdict("tc-old"), undefined);
  assert.equal(pruner.verdicts().size, 2);
  assert.ok(logs.some((l) => l.startsWith("PRUNE_JUDGED: epoch=1 judged=2")));
  assert.deepEqual(
    telemetry.map((e) => e.event),
    ["PRUNE_JUDGED"],
  );
});

test("Given a message judged in a prior epoch, then it is never re-judged", async () => {
  const requests: PruneJudgeRequest[] = [];
  const judge: JevPruneJudgeFn = async (req) => {
    requests.push(req);
    return fakePruneJudge({ "tc-1": 0.9, "tc-2": 0.1, "tc-3": 0.4 })(req);
  };
  const { pruner } = makePruner(judge);
  const entries = epochEntries();
  await pruner.onAgentSettled(entries);
  // The same window settled again: everything cached, no new request.
  await pruner.onAgentSettled(entries);
  assert.equal(requests.length, 1);
  // A new epoch judges only the new pair; tc-1/tc-2 stay cached.
  const grown = [
    ...entries,
    messageEntry(userMessage("now lint it")),
    messageEntry(
      assistantMessage([
        toolCallPart("tc-3", "bash", { command: "npm run check" }),
      ]),
    ),
    messageEntry(toolResultMessage("tc-3", "bash", "CHECK-OK")),
  ];
  await pruner.onAgentSettled(grown);
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests[1].pairs.map((p) => p.id),
    ["tc-3"],
  );
  // The state still shows the whole current epoch for context.
  assert.ok(requests[1].state.includes("[user] now lint it"));
  assert.equal(pruner.verdicts().size, 3);
});

// ------------------------------------------------------------- capture/render

test("epoch capture: no user message means no epoch; orphan results and unpaired calls are never judgment units", () => {
  assert.equal(
    captureEpochPairs([
      messageEntry(assistantMessage([{ type: "text", text: "hi" }])),
    ]),
    null,
  );
  const captured = captureEpochPairs([
    messageEntry(userMessage("go")),
    messageEntry(assistantMessage([toolCallPart("tc-open", "bash", {})])),
    messageEntry(toolResultMessage("tc-orphan", "read", "ORPHAN")),
  ]);
  assert.ok(captured !== null);
  assert.deepEqual(captured.pairs, []);
  // The unpaired call still renders as conversation context for the state.
  assert.ok(
    captured.segments.some((s) => s.kind === "call" && s.id === "tc-open"),
  );
});

test("oversized excerpt rule: an output too large for the state budget is judged on head+tail with the omission marked; smaller outputs stay whole", () => {
  const bigOutput = `${"A".repeat(100)}${"M".repeat(3600)}${"Z".repeat(100)}`;
  const captured = captureEpochPairs([
    messageEntry(userMessage("u")),
    messageEntry(
      assistantMessage([
        toolCallPart("tc-big", "bash", {}),
        toolCallPart("tc-small", "read", {}),
      ]),
    ),
    messageEntry(toolResultMessage("tc-big", "bash", bigOutput)),
    messageEntry(toolResultMessage("tc-small", "read", "SMALL-OK")),
  ]);
  assert.ok(captured !== null);
  const rendered = renderPruneState(captured, 4000);
  assert.ok(Buffer.byteLength(rendered.state, "utf8") <= 4000);
  const big = rendered.pairs.find((p) => p.id === "tc-big");
  const small = rendered.pairs.find((p) => p.id === "tc-small");
  assert.equal(big?.excerpted, true);
  assert.equal(small?.excerpted, false);
  assert.ok(rendered.state.includes("A".repeat(100))); // head intact
  assert.ok(rendered.state.includes("Z".repeat(100))); // tail intact
  assert.ok(!rendered.state.includes("M".repeat(3600))); // middle omitted
  assert.ok(rendered.state.includes("bytes omitted"));
  assert.ok(rendered.state.includes("[tool_result #2 read] SMALL-OK"));
});

// ------------------------------------------------------------- client

test("batched prune client POSTs one request with one noul per pair and parses per-pair scores", async (t) => {
  const captured: { auth?: string; body?: string } = {};
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      captured.auth = req.headers.authorization;
      captured.body = data;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          answers: {
            pair_tc1: { noul: 0.05 },
            pair_tc2: { noul: 0.91 },
          },
          usage: { input_tokens: 777 },
        }),
      );
    });
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const judge = createJevPruneJudge({
    endpoint: `http://127.0.0.1:${address.port}/v1/systemone`,
    model: "jev-latest",
    apiKey: "test-key",
    timeoutMs: 5000,
  });
  const result = await judge({
    state: "EPOCH-STATE",
    pairs: [
      { id: "tc1", toolName: "bash", ordinal: 1, excerpted: false },
      { id: "tc2", toolName: "read", ordinal: 2, excerpted: true },
    ],
  });
  assert.deepEqual(result.scores, { tc1: 0.05, tc2: 0.91 });
  assert.equal(result.inputTokens, 777);
  assert.equal(captured.auth, "Bearer test-key");
  assert.ok(captured.body !== undefined);
  const payload = asRec(JSON.parse(captured.body));
  assert.equal(payload.state, "EPOCH-STATE");
  assert.deepEqual(Object.keys(asRec(payload.questions)).sort(), [
    "pair_tc1",
    "pair_tc2",
  ]);
  const q1 = asRec(asRec(payload.questions).pair_tc1);
  assert.equal(q1.type, "noul");
  const i1 = q1.instructions;
  assert.ok(typeof i1 === "string");
  assert.ok(i1.includes("#1 ('bash')"));
  assert.ok(i1.includes("is this tool output helpful to subsequent turns?"));
  assert.ok(!i1.includes("head and tail")); // full output: no excerpt note
  const i2 = asRec(asRec(payload.questions).pair_tc2).instructions;
  assert.ok(typeof i2 === "string" && i2.includes("head and tail"));
  assert.ok(typeof asRec(q1.criteria).true === "string");
  assert.ok(pruneQuestionKey("tc1") === "pair_tc1");
  assert.ok(
    buildPruneJudgeInstructions({
      id: "x",
      toolName: "edit",
      ordinal: 3,
      excerpted: false,
    }).includes("#3 ('edit')"),
  );
});

test("batched prune client maps HTTP errors, malformed bodies, and timeouts to scores=null results", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/hang") return; // never respond
    if (req.url === "/e500") {
      res.writeHead(500);
      res.end("boom");
      return;
    }
    if (req.url === "/partial") {
      // One pair's answer missing: per-pair null, not whole-failure.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answers: { pair_a: { noul: 0.3 } } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("this is not json");
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const req: PruneJudgeRequest = {
    state: "",
    pairs: [
      { id: "a", toolName: "bash", ordinal: 1, excerpted: false },
      { id: "b", toolName: "read", ordinal: 2, excerpted: false },
    ],
  };
  const judgeFor = (path: string, timeoutMs = 5000) =>
    createJevPruneJudge({
      endpoint: `${base}${path}`,
      model: "m",
      apiKey: "k",
      timeoutMs,
    });
  const r500 = await judgeFor("/e500")(req);
  assert.equal(r500.scores, null);
  assert.equal(r500.error, "http_500");
  const rBad = await judgeFor("/bad")(req);
  assert.equal(rBad.scores, null);
  assert.equal(rBad.error, "bad_response");
  const rTimeout = await judgeFor("/hang", 50)(req);
  assert.equal(rTimeout.scores, null);
  assert.equal(rTimeout.error, "timeout");
  const rPartial = await judgeFor("/partial")(req);
  assert.deepEqual(rPartial.scores, { a: 0.3, b: null });
});

// ------------------------------------------------------------- degradation

test("a failed judgment caches nothing, logs ROUTE_DEGRADED, notifies once per error class, and prunes nothing (fail-static)", async () => {
  const judge: JevPruneJudgeFn = async () => ({
    scores: null,
    inputTokens: 0,
    latencyMs: 1,
    error: "unreachable",
  });
  const { pruner, logs, notifies, telemetry } = makePruner(judge);
  await pruner.onAgentSettled(epochEntries());
  assert.equal(pruner.verdicts().size, 0);
  assert.ok(
    logs.some((l) =>
      l.startsWith("ROUTE_DEGRADED: reason=unreachable nozzle=prune"),
    ),
  );
  assert.equal(notifies.length, 1);
  assert.equal(telemetry.length, 0);
  // Second failure: logged again, still one notify for the class.
  await pruner.onAgentSettled(epochEntries());
  assert.equal(
    logs.filter((l) =>
      l.startsWith("ROUTE_DEGRADED: reason=unreachable nozzle=prune"),
    ).length,
    2,
  );
  assert.equal(notifies.length, 1);
});

test("pairs whose judgment failed stay eligible: the next settle retries them", async () => {
  let down = true;
  const judge: JevPruneJudgeFn = async (req) =>
    down
      ? { scores: null, inputTokens: 0, latencyMs: 1, error: "unreachable" }
      : fakePruneJudge({ "tc-1": 0.8, "tc-2": 0.6 })(req);
  const { pruner } = makePruner(judge);
  await pruner.onAgentSettled(epochEntries());
  assert.equal(pruner.verdicts().size, 0);
  down = false;
  await pruner.onAgentSettled(epochEntries());
  assert.equal(pruner.verdicts().size, 2);
});

test("absent API key: agent_settled judges nothing and logs nothing (absent mode)", async () => {
  let calls = 0;
  const judge: JevPruneJudgeFn = async (req) => {
    calls++;
    return fakePruneJudge({})(req);
  };
  const { pruner, logs } = makePruner(judge, { apiKey: null });
  await pruner.onAgentSettled(epochEntries());
  assert.equal(calls, 0);
  assert.equal(pruner.verdicts().size, 0);
  assert.deepEqual(logs, []);
});

test("pending() exposes the in-flight judge pass and clears when it settles", async () => {
  const { pruner } = makePruner(fakePruneJudge({ "tc-1": 0.5, "tc-2": 0.5 }));
  assert.equal(pruner.pending(), null);
  const run = pruner.onAgentSettled(epochEntries());
  assert.ok(pruner.pending() !== null);
  await run;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pruner.pending(), null);
});

// ------------------------------------------------------- config and wiring

test("config parses pruneThreshold and pruneStateCapBytes; defaults hold without them", () => {
  const home = makeTmpDir();
  writeFileSync(
    join(home, "jev-context.json"),
    JSON.stringify({ pruneThreshold: 0.15, pruneStateCapBytes: 12_345 }),
  );
  const custom = loadConfig({
    userConfigPath: join(home, "jev-context.json"),
    projectConfigPath: join(makeTmpDir(), "nope.json"),
    homeDir: home,
    cwd: makeTmpDir(),
  });
  assert.equal(custom.config.pruneThreshold, 0.15);
  assert.equal(custom.config.pruneStateCapBytes, 12_345);
  const defaults = loadConfig({
    userConfigPath: join(makeTmpDir(), "nope.json"),
    projectConfigPath: join(makeTmpDir(), "nope.json"),
    homeDir: makeTmpDir(),
    cwd: makeTmpDir(),
  });
  assert.equal(defaults.config.pruneThreshold, 0.2);
  assert.equal(defaults.config.pruneStateCapBytes, 60_000);
  assert.equal(defaults.config.consoleLog, false);
});

test("consoleLog gates stderr: silent by default, loud when opted in, degradation notify always on", async () => {
  const run = async (
    consoleLog: boolean | undefined,
  ): Promise<{ lines: string[]; notes: string[] }> => {
    const home = makeTmpDir();
    mkdirSync(join(home, ".pi", "agent", "skills", "s1"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "skills", "s1", "SKILL.md"),
      "---\nname: s1\ndescription: test skill\n---\nbody\n",
    );
    if (consoleLog !== undefined) {
      writeFileSync(
        join(home, ".pi", "agent", "jev-context.json"),
        JSON.stringify({ consoleLog }),
      );
    }
    const lines: string[] = [];
    const notes: string[] = [];
    const handlers = createJevContextExtension({
      homeDir: home,
      env: { PI_TYPESAFE_JEV: "test-key" },
      now: () => 1000,
      log: (line) => lines.push(line),
      // Scoring fails -> ROUTE_DEGRADED path (log line + ui.notify).
      jevScore: async () => ({
        score: null,
        inputTokens: 0,
        latencyMs: 1,
        error: "http_500",
      }),
    });
    const ctx = {
      cwd: makeTmpDir(),
      ui: { notify: (m: string) => notes.push(m) },
      sessionManager: { getBranch: () => [] },
    } as unknown as ExtensionContext;
    handlers.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
    const evt = {
      type: "before_agent_start" as const,
      prompt: "hi",
      systemPrompt: "",
      systemPromptOptions:
        {} as unknown as BeforeAgentStartEvent["systemPromptOptions"],
    };
    await handlers.onBeforeAgentStart(evt, ctx);
    return { lines, notes };
  };

  const quiet = await run(undefined);
  assert.deepEqual(quiet.lines, []); // default: nothing on stderr
  assert.ok(
    quiet.notes.some((n) => n.includes("unavailable")),
    "degradation notify must survive consoleLog=false",
  );

  const loud = await run(true);
  assert.ok(
    loud.lines.some((l) => l.includes("ROUTE_DEGRADED")),
    "consoleLog=true must restore stderr lines",
  );
});

test("wiring: agent_settled captures the session branch, judges its pairs once, and appends PRUNE_JUDGED telemetry", async () => {
  const home = makeTmpDir();
  const judges: PruneJudgeRequest[] = [];
  const handlers = createJevContextExtension({
    homeDir: home,
    env: { PI_TYPESAFE_JEV: "test-key" },
    now: () => 1000,
    log: () => {},
    jevScore: async () => ({ score: 0.1, inputTokens: 1, latencyMs: 1 }),
    jevPruneJudge: async (req) => {
      judges.push(req);
      return {
        scores: Object.fromEntries(req.pairs.map((p) => [p.id, 0.1])),
        inputTokens: 9,
        latencyMs: 1,
      };
    },
  });
  const ctx = {
    cwd: makeTmpDir(),
    ui: { notify: () => {} },
    sessionManager: { getBranch: () => epochEntries() },
  } as unknown as ExtensionContext;
  handlers.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
  await handlers.onAgentSettled({ type: "agent_settled" }, ctx);
  assert.equal(judges.length, 1);
  assert.deepEqual(
    judges[0].pairs.map((p) => p.id),
    ["tc-1", "tc-2"],
  );
  // PRUNE_JUDGED appended to the telemetry JSONL.
  const file = join(home, ".pi", "agent", "jev-context-telemetry.jsonl");
  const records = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => asRec(JSON.parse(l)));
  const judged = records.filter((r) => r.event === "PRUNE_JUDGED");
  assert.equal(judged.length, 1);
  assert.equal(judged[0].judged, 2);
  assert.deepEqual(judged[0].scores, { "#1": 0.1, "#2": 0.1 });
  assert.equal(judged[0].input_tokens, 9);
  assert.equal(judged[0].ts, 1000);
  // renderSkillStats tolerates the new record type.
  assert.ok(renderSkillStats(file).includes("route decisions: 0"));
});

// ============================ Nozzle 3 — prune application + invariants

// ------------------------------------------------------------- helpers

/** Branch entries for one settled epoch, carrying session entry ids (the
 *  context-edit prune path targets entries by id). Same shape as
 *  epochEntries() so judge fixtures read identically. */
function epochEntriesWithIds(): DigestEntry[] {
  return [
    messageEntry(userMessage("earlier question"), "e-user-old"),
    messageEntry(
      assistantMessage([toolCallPart("tc-old", "bash", { command: "old" })]),
      "e-assistant-old",
    ),
    messageEntry(
      toolResultMessage("tc-old", "bash", "OLD-OUTPUT"),
      "e-result-old",
    ),
    messageEntry(userMessage("find the config and read it"), "e-user"),
    messageEntry(
      assistantMessage([
        { type: "thinking", thinking: "THINKING-TRACE" },
        toolCallPart("tc-1", "grep", { pattern: "port" }),
        toolCallPart("tc-2", "read", { path: "/etc/app.conf" }),
      ]),
      "e-assistant-1",
    ),
    messageEntry(toolResultMessage("tc-1", "grep", "GREP-HITS"), "e-result-1"),
    messageEntry(
      toolResultMessage("tc-2", "read", "CONFIG-BODY"),
      "e-result-2",
    ),
    messageEntry(
      assistantMessage([{ type: "text", text: "The port is 8080." }]),
      "e-assistant-2",
    ),
  ];
}

/** One appendContextEdit call recorded by a fake session manager. */
interface RecordedEdit {
  targetId: string;
  replacement: Parameters<AppendContextEditFn>[1];
}

/** Fake Pi ≥ 0.87 session manager: branch reads plus an edit recorder. */
function makeEditSessionManager(branch: DigestEntry[]): {
  sessionManager: ExtensionContext["sessionManager"];
  edits: RecordedEdit[];
} {
  const edits: RecordedEdit[] = [];
  const sessionManager = {
    getBranch: () => branch,
    appendContextEdit: (
      targetId: string,
      replacement: RecordedEdit["replacement"],
    ): string => {
      edits.push({ targetId, replacement });
      return `edit-${edits.length}`;
    },
  } as unknown as ExtensionContext["sessionManager"];
  return { sessionManager, edits };
}

/** Test-side mirror of Pi 0.87's buildSessionProjection semantics: latest
 *  edit per target wins; null omits the entry, { content } replaces only
 *  the content. Raw entries are inputs, never mutated. */
function projectWithEdits(
  entries: readonly DigestEntry[],
  edits: readonly RecordedEdit[],
): AgentMessage[] {
  const latest = new Map<string, RecordedEdit["replacement"]>();
  for (const e of edits) latest.set(e.targetId, e.replacement);
  const out: AgentMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message === undefined) continue;
    const base = entry.message;
    const replacement =
      entry.id === undefined ? undefined : latest.get(entry.id);
    if (replacement === null) continue; // omitted from model context
    if (replacement === undefined || base.role !== "assistant") {
      out.push(base);
    } else {
      out.push({ ...base, content: replacement.content });
    }
  }
  return out;
}

/** Conversation copy carrying two pairs with thinking/text around them. */
function pairMessages(): AgentMessage[] {
  return [
    userMessage("find and read"),
    assistantMessage([
      { type: "thinking", thinking: "THINK-1" },
      toolCallPart("tc-1", "grep", { pattern: "port" }),
      { type: "text", text: "TEXT-1" },
      toolCallPart("tc-2", "read", { path: "/x" }),
    ]),
    toolResultMessage("tc-1", "grep", "GREP-HITS"),
    toolResultMessage("tc-2", "read", "CONFIG-BODY"),
    assistantMessage([{ type: "text", text: "done" }]),
  ];
}

// ------------------------------------------------------------- §5 scenarios

test("Given a prune verdict, when the next `context` event fires, then the call/result pair is removed from the copy and all thinking/text parts of those messages remain", async () => {
  const { pruner } = makePruner(fakePruneJudge({ "tc-1": 0.1, "tc-2": 0.9 }));
  await pruner.onAgentSettled(epochEntries());
  await pruner.refreshAppliedSet();
  const out = pruner.applyPrunes(pairMessages());
  // The pruned pair's toolResult is gone; the kept pair's result stays.
  const results = out.filter((m) => m.role === "toolResult");
  assert.deepEqual(
    results.map((m) => m.toolCallId),
    ["tc-2"],
  );
  // The assistant message that carried tc-1 keeps its thinking/text parts.
  const first = out[1];
  assert.ok(first.role === "assistant");
  assert.deepEqual(
    first.content.map((p) => p.type),
    ["thinking", "text", "toolCall"],
  );
  assert.ok(
    !first.content.some((p) => p.type === "toolCall" && p.id === "tc-1"),
  );
  assert.ok(
    first.content.some(
      (p) => p.type === "thinking" && p.thinking === "THINK-1",
    ),
  );
  assert.ok(
    first.content.some((p) => p.type === "text" && p.text === "TEXT-1"),
  );
});

test("Given any prune, then no raw session entry is modified; prunes appear only as appended `context_edit` entries targeting the pair's entries", async () => {
  const home = makeTmpDir();
  const branch = epochEntriesWithIds();
  const rawBefore = JSON.stringify(branch);
  const { sessionManager, edits } = makeEditSessionManager(branch);
  const handlers = createJevContextExtension({
    homeDir: home,
    env: { PI_TYPESAFE_JEV: "test-key" },
    now: () => 1000,
    log: () => {},
    jevScore: async () => ({ score: 0.1, inputTokens: 1, latencyMs: 1 }),
    jevPruneJudge: fakePruneJudge({ "tc-1": 0.1, "tc-2": 0.9 }),
  });
  const ctx = {
    cwd: makeTmpDir(),
    ui: { notify: () => {} },
    sessionManager,
  } as unknown as ExtensionContext;
  handlers.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
  await handlers.onAgentSettled({ type: "agent_settled" }, ctx);
  await handlers.onBeforeAgentStart(beforeStartEvent("next turn"), ctx);
  // Prunes appear only as appended edits targeting the pair's two entries:
  // the toolResult entry omitted, the owning assistant entry's content
  // replaced (thinking kept verbatim, the kept call kept, tc-1 removed).
  assert.deepEqual(edits.map((e) => e.targetId).sort(), [
    "e-assistant-1",
    "e-result-1",
  ]);
  const resultEdit = edits.find((e) => e.targetId === "e-result-1");
  assert.ok(resultEdit !== undefined);
  assert.equal(resultEdit.replacement, null);
  const assistantEdit = edits.find((e) => e.targetId === "e-assistant-1");
  assert.ok(assistantEdit !== undefined);
  const content = assistantEdit.replacement?.content;
  assert.ok(Array.isArray(content));
  assert.deepEqual(
    content.map((p) => p.type),
    ["thinking", "toolCall"],
  );
  assert.ok(
    content.some((p) => p.type === "toolCall" && p.id === "tc-2"),
    "the kept pair's toolCall part survives the replacement",
  );
  // No raw session entry is modified by the prune.
  assert.equal(JSON.stringify(branch), rawBefore);
  // The model-visible projection: the pruned pair gone, thinking/text kept.
  const visible = projectWithEdits(branch, edits);
  assert.ok(
    !visible.some((m) => m.role === "toolResult" && m.toolCallId === "tc-1"),
  );
  assert.ok(
    visible.some((m) => m.role === "toolResult" && m.toolCallId === "tc-2"),
  );
  const a1 = visible.find(
    (m) =>
      m.role === "assistant" &&
      m.content.some(
        (p) => p.type === "thinking" && p.thinking === "THINKING-TRACE",
      ),
  );
  assert.ok(a1 !== undefined && a1.role === "assistant");
  assert.deepEqual(
    a1.content.map((p) => p.type),
    ["thinking", "toolCall"],
  );
  assert.ok(
    visible.some(
      (m) =>
        m.role === "assistant" &&
        m.content.some(
          (p) => p.type === "text" && p.text === "The port is 8080.",
        ),
    ),
  );
});

test("Given a session resumed with existing `context_edit` entries, then their targets are not re-judged and remain omitted/replaced in the projection", async () => {
  const home = makeTmpDir();
  // The prior session already pruned tc-1: its edits are on the branch.
  const priorEdits: RecordedEdit[] = [
    { targetId: "e-result-1", replacement: null },
    {
      targetId: "e-assistant-1",
      replacement: {
        content: [
          { type: "thinking", thinking: "THINKING-TRACE" },
          toolCallPart("tc-2", "read", { path: "/etc/app.conf" }),
        ],
      },
    },
  ];
  const priorEditEntries = priorEdits.map((e, i) => ({
    type: "context_edit",
    id: `ce-${i}`,
    targetId: e.targetId,
    replacement: e.replacement,
  }));
  const branch: DigestEntry[] = [...epochEntriesWithIds(), ...priorEditEntries];
  const { sessionManager, edits } = makeEditSessionManager(branch);
  let judgeCalls = 0;
  const handlers = createJevContextExtension({
    homeDir: home,
    env: { PI_TYPESAFE_JEV: "test-key" },
    now: () => 1000,
    log: () => {},
    jevScore: async () => ({ score: 0.1, inputTokens: 1, latencyMs: 1 }),
    jevPruneJudge: async (req) => {
      judgeCalls += 1;
      return fakePruneJudge({ "tc-1": 0.1, "tc-2": 0.1 })(req);
    },
  });
  const ctx = {
    cwd: makeTmpDir(),
    ui: { notify: () => {} },
    sessionManager,
  } as unknown as ExtensionContext;
  handlers.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
  await handlers.onAgentSettled({ type: "agent_settled" }, ctx);
  await handlers.onBeforeAgentStart(beforeStartEvent("next turn"), ctx);
  // Both pairs of the epoch touch edit-targeted entries (e-assistant-1 is
  // replaced, e-result-1 omitted): nothing is re-judged, nothing re-edited.
  assert.equal(judgeCalls, 0);
  assert.deepEqual(edits, []);
  // The prior edits still own the projection: the pair stays omitted and
  // the assistant entry keeps exactly thinking + the kept call.
  const visible = projectWithEdits(branch, priorEdits);
  assert.ok(
    !visible.some((m) => m.role === "toolResult" && m.toolCallId === "tc-1"),
  );
  const a1 = visible.find(
    (m) =>
      m.role === "assistant" &&
      m.content.some(
        (p) => p.type === "thinking" && p.thinking === "THINKING-TRACE",
      ),
  );
  assert.ok(a1 !== undefined && a1.role === "assistant");
  assert.deepEqual(
    a1.content.map((p) => p.type),
    ["thinking", "toolCall"],
  );
});

test("edit mode: both pruned calls of one assistant entry produce ONE replacement edit; results are omitted", async () => {
  const edits: RecordedEdit[] = [];
  const sink: AppendContextEditFn = (targetId, replacement) => {
    edits.push({ targetId, replacement });
    return `edit-${edits.length}`;
  };
  const { pruner } = makePruner(fakePruneJudge({ "tc-1": 0.1, "tc-2": 0.1 }), {
    appendContextEdit: sink,
  });
  await pruner.onAgentSettled(epochEntriesWithIds());
  await pruner.refreshAppliedSet();
  const resultEdits = edits.filter((e) => e.targetId.startsWith("e-result"));
  assert.deepEqual(resultEdits.map((e) => e.targetId).sort(), [
    "e-result-1",
    "e-result-2",
  ]);
  assert.ok(resultEdits.every((e) => e.replacement === null));
  const assistantEdits = edits.filter((e) => e.targetId === "e-assistant-1");
  assert.equal(assistantEdits.length, 1); // ONE edit covers both pruned calls
  assert.deepEqual(assistantEdits[0].replacement?.content, [
    { type: "thinking", thinking: "THINKING-TRACE" },
  ]);
});

test("edit mode: an assistant entry left with zero parts after pruning is omitted, not replaced empty", async () => {
  const edits: RecordedEdit[] = [];
  const sink: AppendContextEditFn = (targetId, replacement) => {
    edits.push({ targetId, replacement });
    return `edit-${edits.length}`;
  };
  const { pruner } = makePruner(fakePruneJudge({ tc1: 0.1 }), {
    appendContextEdit: sink,
  });
  const entries: DigestEntry[] = [
    messageEntry(userMessage("go"), "e-u"),
    messageEntry(assistantMessage([toolCallPart("tc1", "bash", {})]), "e-a"),
    messageEntry(toolResultMessage("tc1", "bash", "OUT"), "e-r"),
  ];
  await pruner.onAgentSettled(entries);
  await pruner.refreshAppliedSet();
  assert.deepEqual(
    edits.map((e) => [e.targetId, e.replacement]),
    [
      ["e-r", null],
      ["e-a", null],
    ],
  );
  const visible = projectWithEdits(entries, edits);
  assert.deepEqual(
    visible.map((m) => m.role),
    ["user"],
  );
});

test("edit mode: the `context` event copy is not filtered — the session projection owns pruning", async () => {
  const edits: RecordedEdit[] = [];
  const sink: AppendContextEditFn = (targetId, replacement) => {
    edits.push({ targetId, replacement });
    return `edit-${edits.length}`;
  };
  const { pruner } = makePruner(fakePruneJudge({ "tc-1": 0.1, "tc-2": 0.9 }), {
    appendContextEdit: sink,
  });
  await pruner.onAgentSettled(epochEntriesWithIds());
  await pruner.refreshAppliedSet();
  assert.ok(edits.length > 0); // the prune really applied as edits
  const messages = pairMessages();
  assert.equal(pruner.applyPrunes(messages), messages); // identity, no filter
  assert.deepEqual([...pruner.appliedIds()], []);
});

// ------------------------------------------------------------- application

test("prune threshold: helpful-score at or below 0.2 prunes, the middle band keeps", async () => {
  const { pruner } = makePruner(fakePruneJudge({ "tc-1": 0.2, "tc-2": 0.21 }));
  await pruner.onAgentSettled(epochEntries());
  await pruner.refreshAppliedSet();
  assert.deepEqual([...pruner.appliedIds()].sort(), ["tc-1"]);
});

test("the applied set is byte-stable within an epoch; new prunes apply only at the next boundary", async () => {
  const { pruner } = makePruner(
    fakePruneJudge({ "tc-1": 0.1, "tc-2": 0.9, "tc-3": 0.1 }),
  );
  const entries = epochEntries();
  await pruner.onAgentSettled(entries);
  await pruner.refreshAppliedSet(); // boundary: tc-1 applies
  const before = pruner.applyPrunes(pairMessages());
  // Epoch 2 settles; tc-3 is judged — but the applied set is frozen (§3.4).
  const grown = [
    ...entries,
    messageEntry(userMessage("again")),
    messageEntry(assistantMessage([toolCallPart("tc-3", "bash", {})])),
    messageEntry(toolResultMessage("tc-3", "bash", "B3")),
  ];
  await pruner.onAgentSettled(grown);
  const during = pruner.applyPrunes(pairMessages());
  assert.equal(JSON.stringify(during), JSON.stringify(before));
  assert.equal(pruner.verdict("tc-3")?.score, 0.1);
  assert.ok(!pruner.appliedIds().has("tc-3"));
  // The next boundary applies it.
  await pruner.refreshAppliedSet();
  assert.ok(pruner.appliedIds().has("tc-3"));
  const withThree = [
    ...pairMessages(),
    assistantMessage([toolCallPart("tc-3", "bash", {})]),
    toolResultMessage("tc-3", "bash", "B3"),
  ];
  const after = pruner.applyPrunes(withThree);
  assert.ok(
    !after.some((m) => m.role === "toolResult" && m.toolCallId === "tc-3"),
  );
});

test("PRUNE_EPOCH: a boundary that applies new verdicts logs and records judged/pruned/kept/tokens_reclaimed/edits/mode/scores", async () => {
  const { pruner, logs, telemetry } = makePruner(
    fakePruneJudge({ "tc-1": 0.1, "tc-2": 0.9 }),
  );
  await pruner.onAgentSettled(epochEntries());
  await pruner.refreshAppliedSet();
  const line = logs.find((l) => l.startsWith("PRUNE_EPOCH:"));
  assert.ok(line !== undefined);
  assert.ok(line.includes("epoch=1"));
  assert.ok(line.includes("mode=context_filter"));
  assert.ok(line.includes("judged=2"));
  assert.ok(line.includes("pruned=1"));
  assert.ok(line.includes("kept=1"));
  assert.ok(line.includes("edits=[]"));
  const rec = telemetry.find(
    (e): e is PruneEpochRecord => e.event === "PRUNE_EPOCH",
  );
  assert.ok(rec !== undefined);
  assert.equal(rec.judged, 2);
  assert.equal(rec.pruned, 1);
  assert.equal(rec.kept, 1);
  assert.deepEqual(rec.scores, { "tc-1": 0.1, "tc-2": 0.9 });
  // Filter mode appends no edits and says so.
  assert.deepEqual(rec.edits, []);
  assert.equal(rec.mode, "context_filter");
  // tokens_reclaimed derives from the removed content's bytes (estimate > 0).
  assert.ok(rec.tokens_reclaimed > 0);
  // A boundary with no new verdicts stays quiet.
  const logCount = logs.length;
  await pruner.refreshAppliedSet();
  assert.equal(logs.length, logCount);
});

test("reclaim accounting: tokens_reclaimed estimates the removed content (toolCall JSON + toolResult) at 3.5 bytes/token (issue #9)", async () => {
  const { pruner, telemetry } = makePruner(
    fakePruneJudge({ "tc-1": 0.1, "tc-2": 0.9 }),
  );
  await pruner.onAgentSettled(epochEntries());
  await pruner.refreshAppliedSet();
  const rec = telemetry.find(
    (e): e is PruneEpochRecord => e.event === "PRUNE_EPOCH",
  );
  assert.ok(rec !== undefined);
  // Removed content for the pruned pair tc-1: the toolCall part JSON
  // ({"type":"toolCall","id":"tc-1","name":"grep","arguments":{"pattern":"port"}}
  // = 76 bytes) plus the toolResult text ("GREP-HITS" = 9 bytes):
  // ceil(85 / 3.5) = 25. The pre-#9 accounting (output bytes only at
  // 4 bytes/token) reported 3; a units regression moves this number.
  assert.equal(rec.tokens_reclaimed, 25);
});

test("edit mode: PRUNE_EPOCH records mode=context_edit and the appended context_edit entry ids", async () => {
  const recorded: RecordedEdit[] = [];
  const sink: AppendContextEditFn = (targetId, replacement) => {
    recorded.push({ targetId, replacement });
    return `edit-${recorded.length}`;
  };
  const { pruner, logs, telemetry } = makePruner(
    fakePruneJudge({ "tc-1": 0.1, "tc-2": 0.9 }),
    { appendContextEdit: sink },
  );
  await pruner.onAgentSettled(epochEntriesWithIds());
  await pruner.refreshAppliedSet();
  const rec = telemetry.find(
    (e): e is PruneEpochRecord => e.event === "PRUNE_EPOCH",
  );
  assert.ok(rec !== undefined);
  assert.equal(rec.mode, "context_edit");
  // Application order: the result omit, then the assistant replacement.
  assert.deepEqual(rec.edits, ["edit-1", "edit-2"]);
  assert.deepEqual(
    recorded.map((e) => e.targetId),
    ["e-result-1", "e-assistant-1"],
  );
  const line = logs.find((l) => l.startsWith("PRUNE_EPOCH:"));
  assert.ok(line !== undefined);
  assert.ok(line.includes("mode=context_edit"));
  assert.ok(line.includes("edits=[edit-1,edit-2]"));
});

test("PRUNE_MODE is logged once per session, naming the detected mode", () => {
  const sink: AppendContextEditFn = () => "edit-1";
  const editMode = makePruner(fakePruneJudge({}), { appendContextEdit: sink });
  assert.deepEqual(editMode.logs, ["PRUNE_MODE: mode=context_edit"]);
  const filterMode = makePruner(fakePruneJudge({}));
  assert.deepEqual(filterMode.logs, ["PRUNE_MODE: mode=context_filter"]);
  // Absent mode stays silent (the absent-mode contract logs nothing).
  const absent = makePruner(fakePruneJudge({}), { apiKey: null });
  assert.deepEqual(absent.logs, []);
});

test("provider pairing invariant: after pair surgery, every remaining tool call has its result and every result its call", async () => {
  const { pruner } = makePruner(fakePruneJudge({ "tc-1": 0.1, "tc-2": 0.9 }));
  await pruner.onAgentSettled(epochEntries());
  await pruner.refreshAppliedSet();
  const out = pruner.applyPrunes(pairMessages());
  const callIds = out.flatMap((m) =>
    m.role === "assistant"
      ? m.content.flatMap((p) => (p.type === "toolCall" ? [p.id] : []))
      : [],
  );
  const resultIds = out.flatMap((m) =>
    m.role === "toolResult" ? [m.toolCallId] : [],
  );
  assert.deepEqual(callIds.sort(), resultIds.sort());
});

test("an assistant message that carried only pruned tool calls leaves no empty husk", async () => {
  const { pruner } = makePruner(fakePruneJudge({ "tc-1": 0.1, "tc-2": 0.1 }));
  await pruner.onAgentSettled(epochEntries());
  await pruner.refreshAppliedSet();
  const messages: AgentMessage[] = [
    userMessage("go"),
    assistantMessage([
      toolCallPart("tc-1", "grep", {}),
      toolCallPart("tc-2", "read", {}),
    ]),
    toolResultMessage("tc-1", "grep", "G"),
    toolResultMessage("tc-2", "read", "R"),
  ];
  const out = pruner.applyPrunes(messages);
  assert.deepEqual(
    out.map((m) => m.role),
    ["user"],
  );
});

test("applyPruneSet returns the input reference when nothing is pruned (a no-op context stays a no-op)", () => {
  const messages = pairMessages();
  assert.equal(applyPruneSet(messages, new Set()), messages);
  assert.equal(applyPruneSet(messages, new Set(["tc-nope"])), messages);
});

test("context composition: skill injection stays at position 0 while pruned pairs are removed from the conversation copy", async () => {
  const home = makeTmpDir();
  mkdirSync(join(home, ".pi", "agent", "skills", "demo"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "skills", "demo", "SKILL.md"),
    "DEMO-BODY",
  );
  const handlers = createJevContextExtension({
    homeDir: home,
    env: { PI_TYPESAFE_JEV: "test-key" },
    now: () => 1000,
    log: () => {},
    jevScore: async () => ({ score: 0.9, inputTokens: 1, latencyMs: 1 }),
    jevPruneJudge: fakePruneJudge({ "tc-1": 0.1, "tc-2": 0.9 }),
  });
  const ctx = {
    cwd: makeTmpDir(),
    ui: { notify: () => {} },
    sessionManager: { getBranch: () => epochEntries() },
  } as unknown as ExtensionContext;
  handlers.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
  await handlers.onAgentSettled({ type: "agent_settled" }, ctx);
  await handlers.onBeforeAgentStart(beforeStartEvent("route"), ctx);
  const out = handlers.onContext(contextEvent(pairMessages()));
  const messages = out.messages;
  assert.ok(messages !== undefined);
  const injected = messages[0];
  assert.ok(
    injected.role === "user" &&
      typeof injected.content === "string" &&
      injected.content.includes("DEMO-BODY"),
  );
  assert.ok(
    !messages.some((m) => m.role === "toolResult" && m.toolCallId === "tc-1"),
  );
  assert.ok(
    messages.some((m) => m.role === "toolResult" && m.toolCallId === "tc-2"),
  );
  // PRUNE_EPOCH also lands in the telemetry JSONL; skill_stats tolerates it.
  const file = join(home, ".pi", "agent", "jev-context-telemetry.jsonl");
  const events = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => asRec(JSON.parse(l)).event);
  assert.ok(events.includes("PRUNE_EPOCH"));
  assert.ok(renderSkillStats(file).includes("route decisions: 1"));
});

test("Given Pi without `appendContextEdit`, then pruning falls back to context-event filtering with identical model-visible results", async () => {
  const branch = epochEntriesWithIds();
  const conversation: AgentMessage[] = branch.flatMap((e) =>
    e.type === "message" && e.message !== undefined ? [e.message] : [],
  );
  // One session run per mode: filter = session manager without the seam
  // (Pi < 0.87), edit = fake Pi ≥ 0.87 session manager recording edits.
  const run = async (
    editCapable: boolean,
  ): Promise<{ visible: AgentMessage[]; lines: string[] }> => {
    const home = makeTmpDir();
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "jev-context.json"),
      JSON.stringify({ consoleLog: true }),
    );
    const lines: string[] = [];
    const handlers = createJevContextExtension({
      homeDir: home,
      env: { PI_TYPESAFE_JEV: "test-key" },
      now: () => 1000,
      log: (line) => lines.push(line),
      jevScore: async () => ({ score: 0.1, inputTokens: 1, latencyMs: 1 }),
      jevPruneJudge: fakePruneJudge({ "tc-1": 0.1, "tc-2": 0.9 }),
    });
    const { sessionManager, edits } = makeEditSessionManager(branch);
    const ctx = {
      cwd: makeTmpDir(),
      ui: { notify: () => {} },
      sessionManager: editCapable
        ? sessionManager
        : ({
            getBranch: () => branch,
          } as unknown as ExtensionContext["sessionManager"]),
    } as unknown as ExtensionContext;
    handlers.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
    await handlers.onAgentSettled({ type: "agent_settled" }, ctx);
    await handlers.onBeforeAgentStart(beforeStartEvent("next turn"), ctx);
    const result = handlers.onContext(contextEvent(conversation));
    if (editCapable) {
      // The context handler does not filter in edit mode — the session
      // projection (here: the test-side mirror) owns pruning.
      assert.equal(result.messages, undefined);
      return { visible: projectWithEdits(branch, edits), lines };
    }
    const filtered = result.messages;
    assert.ok(filtered !== undefined);
    return { visible: filtered, lines };
  };
  const filterMode = await run(false);
  const editMode = await run(true);
  // Identical model-visible results in both modes.
  assert.deepEqual(editMode.visible, filterMode.visible);
  // The pruned pair is gone; thinking and the kept pair survive.
  assert.ok(
    !filterMode.visible.some(
      (m) => m.role === "toolResult" && m.toolCallId === "tc-1",
    ),
  );
  assert.ok(
    filterMode.visible.some(
      (m) =>
        m.role === "assistant" &&
        m.content.some(
          (p) => p.type === "thinking" && p.thinking === "THINKING-TRACE",
        ),
    ),
  );
  assert.ok(
    filterMode.visible.some(
      (m) => m.role === "toolResult" && m.toolCallId === "tc-2",
    ),
  );
  // The mode is logged exactly once per session, naming the detected mode.
  assert.deepEqual(
    filterMode.lines.filter((l) => l.startsWith("PRUNE_MODE:")),
    ["PRUNE_MODE: mode=context_filter"],
  );
  assert.deepEqual(
    editMode.lines.filter((l) => l.startsWith("PRUNE_MODE:")),
    ["PRUNE_MODE: mode=context_edit"],
  );
});
