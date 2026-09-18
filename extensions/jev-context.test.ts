/**
 * Tests for the M1 injection seam spike. Titles mirror VERIFYING.md §5
 * scenarios verbatim so "scenario exists ⇔ test exists" is diffable (§6).
 * The router seam is driven with fake `context` event objects; the factory
 * registration test uses a minimal fake ExtensionAPI (double cast: the full
 * API surface is not constructible in a unit test, and no `any` is allowed).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import type {
  ContextEvent,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import jevContext, {
  buildSkillInjection,
  createSkillRouter,
  type SkillInjectionResult,
  SPIKE_SKILL,
} from "./jev-context.ts";

function userMessage(text: string, timestamp = 1): AgentMessage {
  return { role: "user", content: text, timestamp };
}

function contextEvent(messages: AgentMessage[]): ContextEvent {
  return { type: "context", messages };
}

function injectedOf(result: SkillInjectionResult): UserMessage {
  const message = result.messages?.[0];
  assert.ok(
    message !== undefined && message.role === "user",
    "expected an injected user message at index 0",
  );
  return message;
}

test("extension loads and registers on the context and agent_settled events", () => {
  const registered = new Map<string, (...args: never[]) => unknown>();
  const pi = {
    on(event: string, handler: (...args: never[]) => unknown): void {
      registered.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  jevContext(pi);
  assert.deepEqual([...registered.keys()].sort(), ["agent_settled", "context"]);
});

test("Given an active skill set, when the `context` event fires, then skill bodies are injected at a fixed position immediately after the system prompt and prior messages keep their order", () => {
  const router = createSkillRouter();
  const prior = [userMessage("first", 1), userMessage("second", 2)];
  const event = contextEvent(prior);
  const result = router.onContext(event);
  const injected = injectedOf(result);
  const content = injected.content;
  assert.ok(typeof content === "string");
  assert.ok(content.includes(`<skill name="${SPIKE_SKILL.name}">`));
  assert.equal(result.messages?.length, 3);
  assert.deepEqual(result.messages?.slice(1), prior);
  // Non-destructive (VERIFYING.md §3.3): the event's list is never mutated.
  assert.deepEqual(event.messages, [
    userMessage("first", 1),
    userMessage("second", 2),
  ]);
});

test("Given two consecutive `context` events within one epoch, then the injected content is byte-identical between them (cache-stability invariant)", () => {
  const router = createSkillRouter();
  const first = injectedOf(router.onContext(contextEvent([userMessage("a")])));
  const second = injectedOf(
    router.onContext(contextEvent([userMessage("b"), userMessage("c")])),
  );
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.strictEqual(first, second);
});

test("Given an `agent_settled` boundary, when the next epoch's first `context` event fires, then the injection is rebuilt and remains at the fixed position", () => {
  const router = createSkillRouter();
  const epochOne = injectedOf(
    router.onContext(contextEvent([userMessage("a")])),
  );
  router.onAgentSettled();
  const epochTwo = injectedOf(
    router.onContext(contextEvent([userMessage("b")])),
  );
  assert.notStrictEqual(epochOne, epochTwo);
  const content = epochTwo.content;
  assert.ok(typeof content === "string");
  assert.ok(content.includes(SPIKE_SKILL.name));
});

test("buildSkillInjection renders name and body into one user message", () => {
  const message = buildSkillInjection([{ name: "x", body: "BODY" }], 42);
  assert.equal(message.role, "user");
  assert.equal(message.timestamp, 42);
  const content = message.content;
  assert.ok(typeof content === "string");
  assert.ok(content.includes('<skill name="x">\nBODY\n</skill>'));
});
