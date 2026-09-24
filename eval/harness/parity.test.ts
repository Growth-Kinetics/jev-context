// PARITY: optional test that our context_edit projection in harness/session.ts
// reproduces Pi's own buildSessionProjection() on the mini-edited fixture.
// Pi exported buildSessionProjection at the package root only from 0.87; this repo
// pins 0.85.1 in devDependencies, so the export is probed at runtime and the test
// SKIPS LOUDLY (t.skip + PARITY_SKIP marker) when the installed package predates it.
// No network, no fixtures beyond eval/fixtures/mini-edited.jsonl.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as pi from "@earendil-works/pi-coding-agent";
import { parseSessionLines, projectEntries } from "./session.ts";
import type { SessionEntry } from "./types.ts";

const MINI_EDITED = new URL("../fixtures/mini-edited.jsonl", import.meta.url)
  .pathname;

// narrow typed view of the Pi root export (absent before 0.87)
const piBuildSessionProjection = (
  pi as unknown as {
    buildSessionProjection?: (
      entries: unknown[],
      leafId?: string | null,
    ) => { messages: Array<Record<string, unknown>> };
  }
).buildSessionProjection;

// our projection flattened to Pi's message list shape: {role, content} per message
function ourMessages(entries: SessionEntry[]): Array<Record<string, unknown>> {
  return projectEntries(entries).flatMap((e) =>
    e.message === undefined
      ? []
      : [{ role: e.message.role, content: e.message.content }],
  );
}

test("parity: projectEntries matches Pi buildSessionProjection on the edited fixture (skips loudly below Pi 0.87)", (t) => {
  if (typeof piBuildSessionProjection !== "function") {
    console.log(
      "PARITY_SKIP: @earendil-works/pi-coding-agent does not export buildSessionProjection (installed < 0.87); projection parity not checked",
    );
    t.skip("PARITY_SKIP: buildSessionProjection absent (Pi < 0.87)");
    return;
  }
  const entries = parseSessionLines(
    readFileSync(MINI_EDITED, "utf8").split("\n"),
  );
  const theirs = piBuildSessionProjection(entries);
  assert.deepEqual(ourMessages(entries), theirs.messages);
});
