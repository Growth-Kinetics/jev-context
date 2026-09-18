// Tests: session parsing, epoch segmentation, tool pairing, digest construction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSession, segmentEpochs, pairsInSession, buildDigest, parseSessionLines } from "./session.ts";

const MINI = new URL("../fixtures/mini.jsonl", import.meta.url).pathname;

test("parser skips malformed lines and non-message entries without failing", () => {
  const session = parseSession(MINI);
  // 11 valid entries + 1 malformed line; session has 3 user turns
  assert.equal(session.epochs.length, 3);
  assert.equal(session.entries.filter((e) => e.type === "model_change").length, 1);
});

test("epoch segmentation: user turns open epochs, assistant turns count as calls", () => {
  const session = parseSession(MINI);
  assert.deepEqual(
    session.epochs.map((e) => e.callCount),
    [1, 1, 1],
  );
  assert.equal(session.epochs[0].entries[0].message?.role, "user");
});

test("tool pairing links toolResult messages to their toolCall by id", () => {
  const pairs = pairsInSession(parseSession(MINI));
  assert.equal(pairs.length, 4);
  assert.deepEqual(
    pairs.map((p) => [p.call.name, p.call.id]),
    [
      ["bash", "tc1"],
      ["tavily_search", "tc2"],
      ["bash", "tc3"],
      ["bash", "tc4"],
    ],
  );
  assert.equal(pairs[0].result?.toolName, "bash");
  assert.equal(pairs[3].result?.content[0].type, "image");
});

test("digest: boundary epoch contributes only its user message (assistant output unseen)", () => {
  const session = parseSession(MINI);
  const d0 = buildDigest(session.epochs, 0);
  assert.ok(d0.includes("[user] find the CV"));
  assert.ok(!d0.includes("[assistant]"));
  const d1 = buildDigest(session.epochs, 1);
  assert.ok(d1.includes("[user] search the web for hopper jobs"));
  assert.ok(d1.includes("[assistant] found it"));
});

test("digest: tool calls and results are excluded", () => {
  const session = parseSession(MINI);
  const d = buildDigest(session.epochs, 3);
  assert.ok(!d.includes("tc1"));
  assert.ok(!d.includes("cv.pdf"));
  assert.ok(!d.includes("tavily_search"));
});

test("digest: cap keeps the newest content and drops the oldest", () => {
  const lines = [];
  for (let i = 0; i < 5; i++) {
    lines.push(
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: `turn-${i} `.repeat(20) }] },
      }),
    );
  }
  const epochs = segmentEpochs(parseSessionLines(lines));
  const capped = buildDigest(epochs, 5, 400);
  assert.ok(capped.includes("turn-4"));
  assert.ok(!capped.includes("turn-0"));
});

test("empty corpus yields no epochs and empty digest", () => {
  assert.equal(segmentEpochs(parseSessionLines(["{bad"])).length, 0);
  assert.equal(buildDigest([], 0), "");
});
