// Tests: session parsing, epoch segmentation, tool pairing, digest construction.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDigest,
  contextEdits,
  pairsInSession,
  parseSession,
  parseSessionLines,
  segmentEpochs,
} from "./session.ts";

const MINI = new URL("../fixtures/mini.jsonl", import.meta.url).pathname;
const MINI_EDITED = new URL("../fixtures/mini-edited.jsonl", import.meta.url)
  .pathname;

test("parser skips malformed lines and non-message entries without failing", () => {
  const session = parseSession(MINI);
  // 11 valid entries + 1 malformed line; session has 3 user turns
  assert.equal(session.epochs.length, 3);
  assert.equal(
    session.entries.filter((e) => e.type === "model_change").length,
    1,
  );
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
        message: {
          role: "user",
          content: [{ type: "text", text: `turn-${i} `.repeat(20) }],
        },
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

// ---- context_edit projection (Pi >= 0.87 semantics; fixture mini-edited.jsonl)

test("projection: null replacement omits the target entry from model context", () => {
  const session = parseSession(MINI_EDITED);
  // e6 (tavily toolResult) omitted by ce1
  assert.ok(!session.projected.some((e) => e.id === "e6"));
  // the raw append-only transcript still carries it
  assert.ok(session.entries.some((e) => e.id === "e6"));
});

test("projection: { content } replacement swaps only content, role and metadata retained", () => {
  const session = parseSession(MINI_EDITED);
  const e3 = session.projected.find((e) => e.id === "e3");
  assert.notEqual(e3, undefined);
  // string replacement becomes one text part (Pi: assistant/toolResult string rule)
  assert.deepEqual(e3?.message?.content, [
    { type: "text", text: "cv.pdf found (output pruned to summary)" },
  ]);
  assert.equal(e3?.message?.role, "toolResult");
  // metadata survives a content replacement (Pi: role and metadata retained)
  assert.equal(e3?.message?.toolCallId, "tc1");
  assert.equal(e3?.message?.toolName, "bash");
  assert.equal(e3?.message?.isError, false);
});

test("projection: an assistant entry with two toolCalls keeps the un-pruned call only", () => {
  const session = parseSession(MINI_EDITED);
  const e5 = session.projected.find((e) => e.id === "e5");
  const calls = e5?.message?.content.filter((p) => p.type === "toolCall") ?? [];
  assert.deepEqual(
    calls.map((c) => (c.type === "toolCall" ? c.id : "")),
    ["tc3"], // tc2 pruned with its result (e6); tc3 survives
  );
  assert.ok(
    e5?.message?.content.some((p) => p.type === "text" && p.text === "done"),
  );
});

test("projection: the latest context_edit for a target wins", () => {
  const edits = contextEdits(parseSession(MINI_EDITED).entries);
  assert.equal(edits.get("e7")?.id, "ce5"); // ce4 (replace) superseded by ce5 (omit)
  assert.ok(!parseSession(MINI_EDITED).projected.some((e) => e.id === "e7"));
});

test("projection: already-pruned pairs vanish from projected epochs (never re-judged)", () => {
  // governed session: the extension pruned tc2 (result e6 omitted, call part removed
  // from e5) — the projected session no longer contains that pair at all
  const pairs = pairsInSession(parseSession(MINI_EDITED));
  assert.deepEqual(
    pairs.map((p) => p.call.id),
    ["tc1", "tc3", "tc5", "tc4"],
  );
});

test("projection without edits is identity (raw == projected, byte-stable reports hold)", () => {
  const plain = parseSession(MINI);
  assert.deepEqual(plain.projected, plain.entries);
});
