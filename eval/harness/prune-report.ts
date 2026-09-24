// PRUNE-REPORT: live pruning accuracy measured from a governed session's own
// context_edit entries — each edit IS a live prune verdict by the extension.
// Ground truth is a NAMED PROXY (it bounds, it does not measure):
//   - a pruned pair is a "proxy false prune" iff a distinctive token of its output
//     appears in any later user/assistant message (the model still needed it);
//   - a kept closed-epoch pair is a "proxy missed saving" iff its (projected) output
//     is never referenced later;
//   - whether the same tool was called again later is reported alongside, never
//     folded into the false-prune count.
// Deterministic by construction: fixed ordering, no timestamps, no network.

import { contextEdits, pairsInEpoch, segmentEpochs } from "./session.ts";
import type { MessagePart, ParsedSession, SessionEntry } from "./types.ts";

export const PROXY_NAME = "later-reference";

/** text + thinking content of a message, joined (reference-detection input) */
function partsText(content: MessagePart[]): string {
  const out: string[] = [];
  for (const part of content) {
    if (part.type === "text") out.push(part.text);
    else if (part.type === "thinking") out.push(part.thinking);
  }
  return out.join("\n");
}

/**
 * Distinctive tokens: longest words (>= minLength) of a text, lowercased, deduped,
 * longest-first with lexicographic tie-break. No stopword list (zero deps): short
 * words are excluded by length, and the proxy is a bound, not a measurement.
 */
export function distinctiveTokens(
  text: string,
  maxTokens = 6,
  minLength = 6,
): string[] {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? [];
  const uniq = [...new Set(words)].filter((w) => w.length >= minLength);
  uniq.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return uniq.slice(0, maxTokens);
}

interface RawScan {
  /** file-order ordinal per entry id */
  position: Map<string, number>;
  /** toolResult entry ids per toolCall id (a result entry owns its pair) */
  resultEntryOfCall: Map<string, string>;
}

function scanRaw(entries: SessionEntry[]): RawScan {
  const position = new Map<string, number>();
  const resultEntryOfCall = new Map<string, string>();
  entries.forEach((entry, i) => {
    if (entry.id !== undefined) position.set(entry.id, i);
    const msg = entry.message;
    if (
      entry.id !== undefined &&
      msg !== undefined &&
      msg.role === "toolResult" &&
      msg.toolCallId !== undefined
    ) {
      resultEntryOfCall.set(msg.toolCallId, entry.id);
    }
  });
  return { position, resultEntryOfCall };
}

/** user/assistant message texts strictly after `id` in file order */
function laterTexts(
  session: ParsedSession,
  scan: RawScan,
  id: string,
): string[] {
  const from = scan.position.get(id);
  if (from === undefined) return [];
  const out: string[] = [];
  for (const entry of session.entries) {
    if (entry.id === undefined) continue;
    if ((scan.position.get(entry.id) ?? -1) <= from) continue;
    const msg = entry.message;
    if (msg === undefined) continue;
    if (msg.role === "user" || msg.role === "assistant") {
      out.push(partsText(msg.content));
    }
  }
  return out;
}

/** tool names called strictly after `id` in file order */
function laterToolCalls(
  session: ParsedSession,
  scan: RawScan,
  id: string,
): string[] {
  const from = scan.position.get(id);
  if (from === undefined) return [];
  const out: string[] = [];
  for (const entry of session.entries) {
    if (entry.id === undefined) continue;
    if ((scan.position.get(entry.id) ?? -1) <= from) continue;
    const msg = entry.message;
    if (msg === undefined || msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type === "toolCall") out.push(part.name ?? "");
    }
  }
  return out;
}

export interface PrunedPairStat {
  /** toolResult entry id the omit edit targeted */
  targetId: string;
  toolCallId: string;
  toolName: string;
  /** epoch (user-turn index, raw segmentation) the pair lived in */
  epochIndex: number;
  /** proxy false prune: a distinctive token of the raw output appears later */
  laterReferenced: boolean;
  /** entry ids of later messages that referenced it (audit trail) */
  referencedBy: string[];
  /** same tool name called again after the pruned result */
  reCalledLater: boolean;
}

export interface PruneSessionReport {
  proj: string;
  path: string;
  /** context_edit entries in the file */
  editEntries: number;
  /** distinct targets whose latest edit is an omit on a toolResult (pruned pairs) */
  prunedPairs: number;
  /** non-null edits (content replacements, incl. assistant call-part removals) */
  replacedEntries: number;
  pruned: PrunedPairStat[];
  /** closed-epoch pairs with no edit verdict on their result */
  keptClosedPairs: number;
  /** kept pairs whose projected output is never referenced later (proxy missed savings) */
  keptNeverReferenced: number;
}

export interface PruneAggregate {
  governedSessions: number;
  skippedSessions: number;
  editEntries: number;
  prunedPairs: number;
  laterReferencedPruned: number;
  reCalledPruned: number;
  replacedEntries: number;
  keptClosedPairs: number;
  keptNeverReferenced: number;
}

export interface PruneReportDoc {
  corpus: string;
  proxy: string;
  aggregate: PruneAggregate;
  sessions: PruneSessionReport[];
  skipped: Array<{ proj: string; path: string }>;
}

export function buildPruneSession(
  proj: string,
  session: ParsedSession,
): PruneSessionReport | null {
  const edits = contextEdits(session.entries);
  if (edits.size === 0) return null;
  const scan = scanRaw(session.entries);
  const entryById = new Map(
    session.entries
      .filter((e) => e.id !== undefined)
      .map((e) => [e.id as string, e]),
  );
  const rawEpochs = segmentEpochs(session.entries);
  const epochOfEntry = new Map<string, number>();
  rawEpochs.forEach((epoch) => {
    for (const entry of epoch.entries) {
      if (entry.id !== undefined) epochOfEntry.set(entry.id, epoch.index);
    }
  });

  // referencedBy audit needs id -> later referencing texts, computed per pair below
  const pruned: PrunedPairStat[] = [];
  let replacedEntries = 0;
  for (const [targetId, edit] of [...edits.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (edit.replacement !== null && edit.replacement !== undefined) {
      replacedEntries += 1;
      continue;
    }
    const target = entryById.get(targetId);
    const msg = target?.message;
    if (msg === undefined || msg.role !== "toolResult") continue;
    const rawText = partsText(msg.content);
    const tokens = distinctiveTokens(rawText);
    const targetPos = scan.position.get(targetId) ?? 0;
    const referencingEntries: string[] = [];
    if (tokens.length > 0) {
      for (const entry of session.entries) {
        if (entry.id === undefined) continue;
        if ((scan.position.get(entry.id) ?? -1) <= targetPos) continue;
        const m = entry.message;
        if (m === undefined) continue;
        if (m.role !== "user" && m.role !== "assistant") continue;
        const text = partsText(m.content);
        if (tokens.some((t) => text.includes(t)))
          referencingEntries.push(entry.id);
      }
    }
    pruned.push({
      targetId,
      toolCallId: msg.toolCallId ?? "",
      toolName: msg.toolName ?? "",
      epochIndex: epochOfEntry.get(targetId) ?? -1,
      laterReferenced: referencingEntries.length > 0,
      referencedBy: referencingEntries.sort(),
      reCalledLater: laterToolCalls(session, scan, targetId).includes(
        msg.toolName ?? "",
      ),
    });
  }

  // kept pairs: closed epochs (all but the last, matching the harness judge rule),
  // no edit verdict on the result entry; reference-checked against PROJECTED content
  let keptClosedPairs = 0;
  let keptNeverReferenced = 0;
  for (let e = 0; e < rawEpochs.length - 1; e++) {
    for (const pair of pairsInEpoch(rawEpochs[e])) {
      if (pair.result === null) continue;
      const resultEntryId = scan.resultEntryOfCall.get(pair.call.id);
      if (resultEntryId === undefined) continue;
      if (edits.has(resultEntryId)) continue; // governed (omitted or replaced)
      keptClosedPairs += 1;
      const visibleText = partsText(pair.result.content);
      const tokens = distinctiveTokens(visibleText);
      const referenced =
        tokens.length > 0 &&
        laterTexts(session, scan, resultEntryId).some((t) =>
          tokens.some((tok) => t.includes(tok)),
        );
      if (!referenced) keptNeverReferenced += 1;
    }
  }

  return {
    proj,
    path: session.path,
    editEntries: session.entries.filter((e) => e.type === "context_edit")
      .length,
    prunedPairs: pruned.length,
    replacedEntries,
    pruned,
    keptClosedPairs,
    keptNeverReferenced,
  };
}

export function buildPruneReport(
  corpus: string,
  sessions: Array<{ proj: string; session: ParsedSession }>,
): PruneReportDoc {
  const reports: PruneSessionReport[] = [];
  const skipped: Array<{ proj: string; path: string }> = [];
  for (const { proj, session } of sessions) {
    const r = buildPruneSession(proj, session);
    if (r === null) skipped.push({ proj, path: session.path });
    else reports.push(r);
  }
  reports.sort(
    (a, b) => a.proj.localeCompare(b.proj) || a.path.localeCompare(b.path),
  );
  skipped.sort(
    (a, b) => a.proj.localeCompare(b.proj) || a.path.localeCompare(b.path),
  );
  return {
    corpus,
    proxy: PROXY_NAME,
    aggregate: {
      governedSessions: reports.length,
      skippedSessions: skipped.length,
      editEntries: reports.reduce((a, r) => a + r.editEntries, 0),
      prunedPairs: reports.reduce((a, r) => a + r.prunedPairs, 0),
      laterReferencedPruned: reports.reduce(
        (a, r) => a + r.pruned.filter((p) => p.laterReferenced).length,
        0,
      ),
      reCalledPruned: reports.reduce(
        (a, r) => a + r.pruned.filter((p) => p.reCalledLater).length,
        0,
      ),
      replacedEntries: reports.reduce((a, r) => a + r.replacedEntries, 0),
      keptClosedPairs: reports.reduce((a, r) => a + r.keptClosedPairs, 0),
      keptNeverReferenced: reports.reduce(
        (a, r) => a + r.keptNeverReferenced,
        0,
      ),
    },
    sessions: reports,
    skipped,
  };
}

export function pruneReportJson(doc: PruneReportDoc): string {
  return `${JSON.stringify(doc, null, 1)}\n`;
}

export function pruneReportMarkdown(doc: PruneReportDoc): string {
  const a = doc.aggregate;
  const lines: string[] = [];
  lines.push(`# Jev context governor — live pruning accuracy`);
  lines.push("");
  lines.push(
    `- corpus: \`${doc.corpus}\` (${a.governedSessions} governed sessions, ${a.skippedSessions} skipped without context_edit)`,
  );
  lines.push(
    `- proxy: \`${doc.proxy}\` — a pruned output is a proxy false prune iff a distinctive token of it appears in any later user/assistant message; a kept closed-epoch output is a proxy missed saving iff never referenced later. The proxy BOUNDS, it does not measure: references can be indirect or paraphrased, and tool re-calls are reported separately, never folded into the false-prune count.`,
  );
  lines.push("");
  lines.push(`## Aggregate`);
  lines.push("");
  lines.push(`| metric | count |`);
  lines.push(`|---|---|`);
  lines.push(`| pruned pairs (omitted tool results) | ${a.prunedPairs} |`);
  lines.push(
    `| later-referenced pruned pairs (proxy false prunes) | ${a.laterReferencedPruned} |`,
  );
  lines.push(
    `| pruned pairs whose tool was called again later | ${a.reCalledPruned} |`,
  );
  lines.push(`| content edits (replacements) | ${a.replacedEntries} |`);
  lines.push(`| kept closed-epoch pairs | ${a.keptClosedPairs} |`);
  lines.push(
    `| kept pairs never referenced later (proxy missed savings) | ${a.keptNeverReferenced} |`,
  );
  lines.push("");
  lines.push(`## Per-session`);
  lines.push("");
  lines.push(
    `| proj | edits | pruned | false-prune (proxy) | re-called | kept | kept-never-ref (proxy) |`,
  );
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const r of doc.sessions) {
    lines.push(
      `| ${r.proj} | ${r.editEntries} | ${r.prunedPairs} | ${r.pruned.filter((p) => p.laterReferenced).length} | ${r.pruned.filter((p) => p.reCalledLater).length} | ${r.keptClosedPairs} | ${r.keptNeverReferenced} |`,
    );
  }
  lines.push("");
  if (doc.skipped.length > 0) {
    lines.push(`## Skipped (no context_edit entries)`);
    lines.push("");
    for (const s of doc.skipped) lines.push(`- ${s.proj} (${s.path})`);
    lines.push("");
  }
  return lines.join("\n");
}
