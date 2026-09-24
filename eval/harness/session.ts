// SESSION: parse Pi session JSONL into typed entries, apply context_edit projection
// (Pi >= 0.87 semantics), segment epochs at user turns, pair toolCall parts with
// toolResult messages, and build the Nozzle-1 digest.
// Digest spec (SESSION_SPEC_2026-09-18-001): newest-first walk, user turns + assistant
// text/thinking only, tool calls and results excluded, 80KB budget.

import { readFileSync } from "node:fs";
import type {
  ChatMessage,
  Epoch,
  MessagePart,
  ParsedSession,
  SessionEntry,
  ToolPair,
  ToolResultMessage,
} from "./types.ts";

export const DIGEST_CAP_BYTES = 80 * 1024;

export function parseSessionLines(lines: string[]): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as SessionEntry).type === "string"
      ) {
        entries.push(parsed as SessionEntry);
      }
    } catch {
      // malformed line: Pi never wrote one, but the corpus is append-only JSONL; skip loudly-free
    }
  }
  return entries;
}

export function parseSession(path: string): ParsedSession {
  const entries = parseSessionLines(readFileSync(path, "utf8").split("\n"));
  const projected = projectEntries(entries);
  return { path, entries, projected, epochs: segmentEpochs(projected) };
}

// ---------------------------------------------------------------------------
// context_edit projection, reimplemented per Pi 0.87's documented algorithm
// (dist/core/session-manager.js buildSessionProjection): apply the LATEST edit per
// target; omitted targets produce no message; replacements retain the source entry's
// role and metadata while changing only content. Compaction/branch entries are not
// modeled by this harness; edits target message entries in practice (nozzle 3).

/** ids targeted by any context_edit entry in file order (latest edit wins downstream) */
export function contextEdits(
  entries: SessionEntry[],
): Map<string, SessionEntry> {
  const edits = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (entry.type === "context_edit" && entry.targetId !== undefined) {
      edits.set(entry.targetId, entry);
    }
  }
  return edits;
}

/** Model-visible entries: context_edit entries applied, the edit entries themselves dropped. */
export function projectEntries(entries: SessionEntry[]): SessionEntry[] {
  const edits = contextEdits(entries);
  const out: SessionEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "context_edit") continue; // edits carry no message of their own
    const edit = entry.id !== undefined ? edits.get(entry.id) : undefined;
    if (edit === undefined) {
      out.push(entry);
      continue;
    }
    if (edit.replacement === null || edit.replacement === undefined) {
      continue; // omit: the target produces no message
    }
    if (entry.message === undefined) {
      // harness models message entries only; a content replacement on a non-message
      // entry (custom_message & co.) keeps it visible unchanged
      out.push(entry);
      continue;
    }
    const replacement = edit.replacement;
    // Pi: a plain-string replacement becomes one text part for assistant/toolResult;
    // user-message string replacements cannot occur (ContextEditableContent is parts)
    // but are normalized the same way rather than trusted
    const content: MessagePart[] =
      typeof replacement.content === "string"
        ? [{ type: "text" as const, text: replacement.content }]
        : replacement.content;
    out.push({
      ...entry,
      message: { ...entry.message, content },
    });
  }
  return out;
}

export function segmentEpochs(entries: SessionEntry[]): Epoch[] {
  const epochs: Epoch[] = [];
  let current: Epoch | null = null;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message === undefined) continue;
    const role = entry.message.role;
    if (role === "user") {
      if (current !== null) epochs.push(current);
      current = { index: epochs.length, entries: [entry], callCount: 0 };
    } else if (current !== null) {
      current.entries.push(entry);
      if (role === "assistant") current.callCount += 1;
    }
    // messages before the first user turn (if any) belong to no epoch and are ignored
  }
  if (current !== null) epochs.push(current);
  return epochs;
}

export function isToolResultMessage(m: {
  role: string;
}): m is ToolResultMessage {
  return m.role === "toolResult";
}

/** Tool pairs of one epoch, in transcript order. Unanswered calls keep result=null. */
export function pairsInEpoch(epoch: Epoch): ToolPair[] {
  const results = new Map<string, ToolResultMessage>();
  const calls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }> = [];
  for (const entry of epoch.entries) {
    const msg = entry.message;
    if (msg === undefined) continue;
    if (isToolResultMessage(msg)) {
      if (msg.toolCallId) results.set(msg.toolCallId, msg);
      continue;
    }
    for (const part of msg.content) {
      if (part.type === "toolCall") {
        calls.push({
          id: part.id ?? "",
          name: part.name ?? "",
          arguments: part.arguments ?? {},
        });
      }
    }
  }
  return calls.map((call) => ({
    call,
    result: results.get(call.id) ?? null,
    epochIndex: epoch.index,
  }));
}

export function pairsInSession(session: ParsedSession): ToolPair[] {
  return session.epochs.flatMap(pairsInEpoch);
}

// ---------------------------------------------------------------------------
// Byte accounting. Rules documented per part type; the same rules apply to every arm,
// so reduction ratios depend only on what each arm injects/removes.

export interface PartBytes {
  textBytes: number;
  imageBytes: number;
}

export function partBytes(part: MessagePart): PartBytes {
  switch (part.type) {
    case "text":
      return { textBytes: Buffer.byteLength(part.text ?? ""), imageBytes: 0 };
    case "thinking":
      return {
        textBytes: Buffer.byteLength(part.thinking ?? ""),
        imageBytes: 0,
      };
    case "toolCall":
      return {
        textBytes: Buffer.byteLength(
          JSON.stringify({
            id: part.id,
            name: part.name,
            arguments: part.arguments,
          }),
        ),
        imageBytes: 0,
      };
    case "image":
      return { textBytes: 0, imageBytes: (part.data ?? "").length };
  }
}

export function contentBytes(content: MessagePart[]): PartBytes {
  let textBytes = 0;
  let imageBytes = 0;
  for (const part of content) {
    const b = partBytes(part);
    textBytes += b.textBytes;
    imageBytes += b.imageBytes;
  }
  return { textBytes, imageBytes };
}

export function chatMessageBytes(msg: ChatMessage): PartBytes {
  return contentBytes(msg.content);
}

export function toolResultBytes(msg: ToolResultMessage): PartBytes {
  const inner = contentBytes(msg.content);
  const wrapper = Buffer.byteLength(
    JSON.stringify({
      toolCallId: msg.toolCallId,
      toolName: msg.toolName,
      isError: msg.isError,
    }),
  );
  return { textBytes: inner.textBytes + wrapper, imageBytes: inner.imageBytes };
}

/**
 * Nozzle-1 digest as seen at `before_agent_start` of epoch `epochIndex`:
 * newest-first walk; user turns + assistant text/thinking only; tool content excluded;
 * within the boundary epoch only the user message is visible (assistant output has not
 * run yet); capped at `cap` bytes, newest content winning. Output reads oldest-first.
 */
export function buildDigest(
  epochs: Epoch[],
  epochIndex: number,
  cap = DIGEST_CAP_BYTES,
): string {
  const chunks: string[] = [];
  let total = 0;
  for (let e = Math.min(epochIndex + 1, epochs.length) - 1; e >= 0; e--) {
    const visible =
      e === epochIndex ? epochs[e].entries.slice(0, 1) : epochs[e].entries;
    for (let i = visible.length - 1; i >= 0; i--) {
      const msg = visible[i].message;
      if (msg === undefined || msg.role === "toolResult") continue;
      const chat = msg as ChatMessage;
      for (let p = chat.content.length - 1; p >= 0; p--) {
        const part = chat.content[p];
        if (part.type !== "text" && part.type !== "thinking") continue;
        const text = part.type === "text" ? part.text : part.thinking;
        if (!text) continue;
        const chunk = `[${chat.role}] ${text}\n`;
        const size = Buffer.byteLength(chunk);
        if (total + size > cap) return chunks.join("");
        chunks.unshift(chunk);
        total += size;
      }
    }
  }
  return chunks.join("");
}
