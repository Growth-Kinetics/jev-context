// PARITY: always-on test that our context_edit projection in harness/session.ts
// reproduces Pi's own buildSessionProjection() on the mini-edited fixture.
// @earendil-works/pi-coding-agent is pinned to 0.87.1 in devDependencies, so the
// comparison runs in every `npm test`. Two loud skip paths remain (console marker
// + t.skip) for environments where the dev install is incomplete, and they are
// DISTINCT: ABSENT (package does not resolve at all) vs TOO OLD (resolves but
// predates the 0.87 buildSessionProjection export).
// The comparison is FULL-SHAPE: role and every metadata field (toolCallId,
// toolName, isError, ...) must survive a content replacement. A {role, content}-
// only comparison once hid exactly that regression (orchestrator finding, 2026-09-24).
// The optional-resolution probe must be a top-level await import(): a static value
// import would fail the whole file when the package is genuinely absent, which is
// the loud-skip case the orchestrator directed (VERIFYING §2's static-import rule
// targets shipped extension code; this is a test-only probe).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSessionLines, projectEntries } from "./session.ts";
import type { PiMessage } from "./types.ts";

const MINI_EDITED = new URL("../fixtures/mini-edited.jsonl", import.meta.url)
  .pathname;

/** narrow typed view of the Pi root export (buildSessionProjection: 0.87+) */
type PiExports = {
  buildSessionProjection?: (
    entries: unknown[],
    leafId?: string | null,
  ) => { messages: Array<Record<string, unknown>> };
};

const pi: PiExports | null = await import(
  "@earendil-works/pi-coding-agent"
).then(
  (m) => m as unknown as PiExports,
  () => null,
);

test("parity: projectEntries matches Pi buildSessionProjection on the edited fixture, full message shape", (t) => {
  if (pi === null) {
    console.log(
      "PARITY_SKIP: @earendil-works/pi-coding-agent is not installed / not resolvable (run npm install); projection parity not checked",
    );
    t.skip("PARITY_SKIP: package absent (npm install)");
    return;
  }
  if (typeof pi.buildSessionProjection !== "function") {
    console.log(
      "PARITY_SKIP: @earendil-works/pi-coding-agent resolves but does not export buildSessionProjection (older than the pinned 0.87.1; run npm install)",
    );
    t.skip("PARITY_SKIP: buildSessionProjection absent (package too old)");
    return;
  }
  const entries = parseSessionLines(
    readFileSync(MINI_EDITED, "utf8").split("\n"),
  );
  const ours: PiMessage[] = projectEntries(entries).flatMap((e) =>
    e.message === undefined ? [] : [e.message],
  );
  const theirs = pi.buildSessionProjection(entries).messages;
  assert.deepEqual(ours, theirs);
});
