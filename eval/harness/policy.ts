// POLICY: threshold policy for skill routing, read from eval/expected.json.
// Frozen design (SESSION_SPEC_2026-09-18-001): load threshold 0.6, top-K cap 3 by score,
// decay re-check every 5th user turn at 0.25.

export interface ThresholdPolicy {
  load: number;
  top_k: number;
  decay: number;
}

export const DECAY_INTERVAL_TURNS = 5;

export interface SkillState {
  name: string;
  score: number;
  activeSinceTurn: number;
}

/** which skills enter the active set this turn: >= load threshold, top-K by score */
export function selectSkills(
  scores: Record<string, number>,
  policy: ThresholdPolicy,
): string[] {
  return Object.entries(scores)
    .filter(([name, score]) => name !== "" && score >= policy.load)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, policy.top_k)
    .map(([name]) => name);
}

/** true when a decay re-check is due for a skill loaded at `loadedSinceTurn` */
export function decayDue(
  loadedSinceTurn: number,
  currentTurn: number,
): boolean {
  return currentTurn - loadedSinceTurn >= DECAY_INTERVAL_TURNS;
}

/** an active skill leaves the set when its re-check score falls below the decay floor */
export function shouldEvict(
  recheckScore: number,
  policy: ThresholdPolicy,
): boolean {
  return recheckScore < policy.decay;
}
