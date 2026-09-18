// SIMULATE: counterfactual replay of one session under three arms.
//   baseline — native Pi: every catalog skill body and every namespace schema in every
//              epoch's context, full history accumulates.
//   routed   — nozzles 1+2: only the active skill set and active namespaces injected.
//   pruned   — nozzle 3 added: judged-dead tool call/result pairs leave the history at
//              epoch boundaries (thinking/text of those messages remain).
// Skill scores come from an injectable per-epoch provider (recorded table in fixture mode,
// Jev client in live mode). Namespace activity and prune verdicts are derived from
// transcript ground truth (documented proxies; see eval/README.md "Simulation policies").

import type { Catalog } from "./catalog.ts";
import { namespaceBytes, namespaceOf, routedNamespaces } from "./catalog.ts";
import {
  decayDue,
  selectSkills,
  shouldEvict,
  type ThresholdPolicy,
} from "./policy.ts";
import {
  buildDigest,
  chatMessageBytes,
  isToolResultMessage,
  pairsInEpoch,
  toolResultBytes,
} from "./session.ts";
import { estimateTokens } from "./tokens.ts";
import type { ParsedSession, ToolPair } from "./types.ts";

export interface ScoresContext {
  proj: string;
  epoch: number;
  digest: string;
}

export type ScoresProvider = (
  ctx: ScoresContext,
) => Promise<Record<string, number>>;

export interface SpendLine {
  kind: "skill-load" | "skill-decay" | "namespace-batch" | "prune-batch";
  epoch: number;
  stateBytes: number;
  questionBytes: number;
  tokensEstimated: number;
}

export interface SessionResult {
  proj: string;
  path: string;
  epochs: number;
  calls: number;
  degradedSkills: boolean;
  /** skills active at any point under the governed arms */
  loadedSkills: string[];
  /** namespace misses: calls to namespaces not active in that epoch */
  namespaceMisses: number;
  activeNamespacesEver: string[];
  baseline: ArmTotals;
  routed: ArmTotals;
  pruned: ArmTotals;
  prunedPairs: number;
  prunedTokens: number;
  /** ground-truth recurrence violations among pruned pairs (0 by construction in fixture) */
  falsePrune: number;
  /** kept pairs whose tool never recurred: missed savings, informational */
  falseKeep: number;
  spend: SpendLine[];
}

export interface ArmTotals {
  /** sum over epochs of (epoch-start context bytes x calls in epoch) */
  textBytes: number;
  imageBytes: number;
  skillsBytes: number;
  toolsBytes: number;
  historyBytes: number;
}

function emptyArm(): ArmTotals {
  return {
    textBytes: 0,
    imageBytes: 0,
    skillsBytes: 0,
    toolsBytes: 0,
    historyBytes: 0,
  };
}

/** tool names called per epoch (ground truth from the transcript) */
function toolsCalledPerEpoch(session: ParsedSession): Set<string>[] {
  return session.epochs.map((epoch) => {
    const names = new Set<string>();
    for (const pair of pairsInEpoch(epoch)) names.add(pair.call.name);
    return names;
  });
}

/** namespace active in epoch e iff one of its tools was called in any earlier epoch */
function activeNamespacesAt(
  e: number,
  perEpoch: Set<string>[],
  catalog: Catalog,
): Set<string> {
  const active = new Set<string>();
  for (let f = 0; f < e; f++) {
    for (const tool of perEpoch[f]) active.add(namespaceOf(tool, catalog));
  }
  return active;
}

/** recurrence proxy verdict: prune iff the tool is never called in any later epoch */
export function recurrencePruneVerdict(
  pair: ToolPair,
  perEpoch: Set<string>[],
): boolean {
  for (let f = pair.epochIndex + 1; f < perEpoch.length; f++) {
    if (perEpoch[f].has(pair.call.name)) return false;
  }
  return true;
}

/** verdict source: recurrence proxy by default; a live override (callId -> prune?) wins */
export type PruneVerdictSource = (
  pair: ToolPair,
  perEpoch: Set<string>[],
) => boolean;

export interface SimulateOptions {
  proj: string;
  catalog: Catalog;
  policy: ThresholdPolicy;
  scores: ScoresProvider;
  /** false when no recorded scores exist for this session: skills arm degrades fail-static */
  skillsAvailable: boolean;
  /** live verdicts go here; fixture mode uses the recurrence proxy */
  pruneVerdicts?: PruneVerdictSource;
}

export async function simulate(
  session: ParsedSession,
  opts: SimulateOptions,
): Promise<SessionResult> {
  const { catalog, policy } = opts;
  const perEpoch = toolsCalledPerEpoch(session);
  const allSkillBytes = Object.values(catalog.skills).reduce(
    (a, b) => a + b,
    0,
  );
  const allNamespaceNames = routedNamespaces(catalog);
  const allToolsBytes =
    namespaceBytes("core", catalog).bytes +
    allNamespaceNames.reduce(
      (acc, ns) => acc + namespaceBytes(ns, catalog).bytes,
      0,
    );

  // ---- prune verdicts (nozzle 3): judged once per pair at its epoch's close; the final
  // epoch is never judged (no subsequent turn exists to need the output).
  const prunedCallIds = new Set<string>();
  let falsePrune = 0;
  let falseKeep = 0;
  let prunedResultBytes = 0;
  const verdictSource: PruneVerdictSource =
    opts.pruneVerdicts ?? recurrencePruneVerdict;
  for (let e = 0; e < session.epochs.length; e++) {
    for (const pair of pairsInEpoch(session.epochs[e])) {
      const isLastEpoch = e === session.epochs.length - 1;
      if (isLastEpoch) continue; // unjudged tail: no subsequent turn could need the output
      if (verdictSource(pair, perEpoch)) {
        prunedCallIds.add(pair.call.id);
        if (pair.result !== null) {
          const b = toolResultBytes(pair.result);
          prunedResultBytes += b.textBytes + b.imageBytes;
        }
        // ground-truth check: a pruned pair whose tool recurs later is a false prune.
        // The recurrence proxy cannot produce one; live verdicts can.
        if (!recurrencePruneVerdict(pair, perEpoch)) falsePrune += 1;
      } else {
        // ground-truth check: a kept pair whose tool never recurred is a missed saving.
        // The recurrence proxy never keeps a non-recurring pair; live verdicts can.
        if (recurrencePruneVerdict(pair, perEpoch)) falseKeep += 1;
      }
    }
  }

  // ---- skill lifecycle (nozzle 1)
  const active = new Map<string, number>(); // name -> activeSinceTurn
  const loadedEver = new Set<string>();
  const spend: SpendLine[] = [];
  const baseline = emptyArm();
  const routed = emptyArm();
  const pruned = emptyArm();
  let calls = 0;
  let namespaceMisses = 0;
  const namespacesEver = new Set<string>();
  const degraded = !opts.skillsAvailable;

  for (let e = 0; e < session.epochs.length; e++) {
    const epoch = session.epochs[e];
    const digest = buildDigest(session.epochs, e);
    const digestBytes = Buffer.byteLength(digest);
    calls += epoch.callCount;

    // skill routing at this boundary
    if (!degraded) {
      const scores = await opts.scores({ proj: opts.proj, epoch: e, digest });
      // spend: one full-body request per not-yet-active skill
      for (const [name, bodyBytes] of Object.entries(catalog.skills)) {
        if (!active.has(name)) {
          spend.push({
            kind: "skill-load",
            epoch: e,
            stateBytes: digestBytes,
            questionBytes: bodyBytes + 64,
            tokensEstimated: estimateTokens(digestBytes + bodyBytes + 64),
          });
        }
      }
      // decay re-checks
      for (const [name, since] of [...active.entries()]) {
        if (decayDue(since, e)) {
          const score = scores[name] ?? 0;
          spend.push({
            kind: "skill-decay",
            epoch: e,
            stateBytes: digestBytes,
            questionBytes: (catalog.skills[name] ?? 0) + 64,
            tokensEstimated: estimateTokens(
              digestBytes + (catalog.skills[name] ?? 0) + 64,
            ),
          });
          if (shouldEvict(score, policy)) active.delete(name);
        }
      }
      // entrants: >= threshold, top-K overall set cap
      const free = policy.top_k - active.size;
      if (free > 0) {
        const inactiveScores: Record<string, number> = {};
        for (const name of Object.keys(catalog.skills)) {
          if (!active.has(name)) inactiveScores[name] = scores[name] ?? 0;
        }
        for (const name of selectSkills(inactiveScores, policy).slice(
          0,
          free,
        )) {
          active.set(name, e);
          loadedEver.add(name);
        }
      }
    } else {
      for (const name of Object.keys(catalog.skills)) loadedEver.add(name);
    }

    // namespace surfacing (nozzle 2) at this boundary
    const activeNs = activeNamespacesAt(e, perEpoch, catalog);
    for (const tool of perEpoch[e]) {
      const ns = namespaceOf(tool, catalog);
      namespacesEver.add(ns);
      if (ns !== "core" && !activeNs.has(ns)) namespaceMisses += 1;
    }
    // spend: one batched namespace request per epoch (descriptions only, small payload)
    const nsQuestionBytes = 64 + allNamespaceNames.length * 128;
    spend.push({
      kind: "namespace-batch",
      epoch: e,
      stateBytes: digestBytes,
      questionBytes: nsQuestionBytes,
      tokensEstimated: estimateTokens(digestBytes + nsQuestionBytes),
    });
    // spend: one batched prune-judge request per closed epoch; state = the epoch itself
    if (e > 0) {
      let epochBytes = 0;
      for (const entry of session.epochs[e - 1].entries) {
        const msg = entry.message;
        if (msg === undefined) continue;
        epochBytes += isToolResultMessage(msg)
          ? toolResultBytes(msg).textBytes + toolResultBytes(msg).imageBytes
          : chatMessageBytes(msg).textBytes + chatMessageBytes(msg).imageBytes;
      }
      const pairs = pairsInEpoch(session.epochs[e - 1]).length;
      spend.push({
        kind: "prune-batch",
        epoch: e - 1,
        stateBytes: Math.min(epochBytes, 64 * 1024),
        questionBytes: 96 * Math.max(pairs, 1),
        tokensEstimated: estimateTokens(
          Math.min(epochBytes, 64 * 1024) + 96 * Math.max(pairs, 1),
        ),
      });
    }

    // ---- context accounting at this epoch's start
    const governedSkillsBytes = degraded
      ? allSkillBytes
      : [...active.keys()].reduce(
          (acc, name) => acc + (catalog.skills[name] ?? 0),
          0,
        );
    const governedToolsBytes =
      namespaceBytes("core", catalog).bytes +
      [...activeNs].reduce(
        (acc, ns) => acc + namespaceBytes(ns, catalog).bytes,
        0,
      );

    // history through epoch e-1: full vs pruned-pair-surgery
    let fullHistory = 0;
    let prunedHistory = 0;
    let fullImages = 0;
    let prunedImages = 0;
    for (let f = 0; f < e; f++) {
      for (const entry of session.epochs[f].entries) {
        const msg = entry.message;
        if (msg === undefined) continue;
        if (isToolResultMessage(msg)) {
          const pairPruned =
            msg.toolCallId !== undefined && prunedCallIds.has(msg.toolCallId);
          const b = toolResultBytes(msg);
          fullHistory += b.textBytes;
          fullImages += b.imageBytes;
          if (!pairPruned) {
            prunedHistory += b.textBytes;
            prunedImages += b.imageBytes;
          }
          continue;
        }
        const b = chatMessageBytes(msg);
        fullHistory += b.textBytes;
        fullImages += b.imageBytes;
        // assistant messages keep text/thinking; pruned toolCall parts drop
        let drop = 0;
        for (const part of msg.content) {
          if (part.type === "toolCall" && prunedCallIds.has(part.id)) {
            drop += Buffer.byteLength(
              JSON.stringify({
                id: part.id,
                name: part.name,
                arguments: part.arguments,
              }),
            );
          }
        }
        prunedHistory += b.textBytes - drop;
        prunedImages += b.imageBytes;
      }
    }

    const n = Math.max(epoch.callCount, 1); // a turn with zero assistant turns still bills once
    for (const [arm, armSkills, armTools, armHistory, armImages] of [
      [baseline, allSkillBytes, allToolsBytes, fullHistory, fullImages],
      [
        routed,
        governedSkillsBytes,
        governedToolsBytes,
        fullHistory,
        fullImages,
      ],
      [
        pruned,
        governedSkillsBytes,
        governedToolsBytes,
        prunedHistory,
        prunedImages,
      ],
    ] as Array<[ArmTotals, number, number, number, number]>) {
      arm.textBytes += (armSkills + armTools + armHistory) * n;
      arm.imageBytes += armImages * n;
      arm.skillsBytes += armSkills * n;
      arm.toolsBytes += armTools * n;
      arm.historyBytes += armHistory * n;
    }
  }

  return {
    proj: opts.proj,
    path: session.path,
    epochs: session.epochs.length,
    calls,
    degradedSkills: degraded,
    loadedSkills: [...loadedEver].sort(),
    namespaceMisses,
    activeNamespacesEver: [...namespacesEver].sort(),
    baseline,
    routed,
    pruned,
    prunedPairs: prunedCallIds.size,
    prunedTokens: estimateTokens(prunedResultBytes),
    falsePrune,
    falseKeep,
    spend,
  };
}
