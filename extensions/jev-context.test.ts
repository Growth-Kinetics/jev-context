/**
 * Tests for the jev-context extension (M1-M3). §5 scenario titles are mirrored
 * verbatim from VERIFYING.md so "scenario exists ⇔ test exists" is diffable.
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
  BuildSystemPromptOptions,
  ContextEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import jevContext, {
  buildSessionDigest,
  buildSkillInjection,
  createJevContextExtension,
  createJevScorer,
  createSkillRouter,
  type DigestEntry,
  defaultSkillRoots,
  type JevScoreFn,
  type JevScoreRequest,
  loadConfig,
  renderSkillStats,
  resolveApiKey,
  type SkillEntry,
  type SkillInjectionResult,
  type SkillRouterDeps,
  scanSkillCatalog,
  selectSkillsToLoad,
  type TelemetryEvent,
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

function messageEntry(message: AgentMessage): DigestEntry {
  return { type: "message", message };
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
    "session_start",
  ]);
  assert.ok(commands.has("skill_stats"));
});

test("Given a catalog of N skills and a new user message, when `before_agent_start` fires, then exactly one Jev request per not-yet-active skill is issued, in parallel, with the full skill body in the question and the digest as state", async () => {
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
    assert.equal(req.state, expectedDigest);
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
      systemPromptOptions: {} as unknown as BuildSystemPromptOptions,
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
    systemPromptOptions: {} as unknown as BuildSystemPromptOptions,
  });
  handlers.onSessionStart({ type: "session_start", reason: "startup" }, ctx);
  await handlers.onBeforeAgentStart(turn("one"), ctx);
  assert.equal(scorerCalls, 1); // catalog scan found demo; scored once
  handlers.onAgentSettled();
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
    state: "DIGEST-STATE",
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
  assert.equal(payload.state, "DIGEST-STATE");
  assert.equal(payload.model, "jev-latest");
  const shouldLoad = asRec(asRec(payload.questions).should_load);
  assert.equal(shouldLoad.type, "noul");
  const instructions = shouldLoad.instructions;
  assert.ok(typeof instructions === "string");
  assert.ok(instructions.includes("FULL-SKILL-BODY"));
  assert.ok(instructions.includes("'demo'"));
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
  const req: JevScoreRequest = { state: "", skillName: "s", skillBody: "b" };
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
    systemPromptOptions: {} as unknown as BuildSystemPromptOptions,
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
