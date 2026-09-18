/**
 * jev-context — Jev-routed skill loading for Pi (GOAL 2026-09-18-001, Nozzle 1).
 *
 * What: at each user-turn boundary, scores the skill catalog against a digest
 *   of the session via the Jev (TypeSafe System One) API and injects the
 *   winning skill bodies into the deep-copied message list of the `context`
 *   event. M1 is the injection-seam spike: one hardcoded skill body, fixed
 *   position, byte-stable within an epoch. No Jev wiring yet.
 * Events used: `context` (inject into the message copy), `agent_settled`
 *   (close the epoch; the next `context` event opens a new one).
 * State owned: per-epoch frozen injection message plus an epoch counter,
 *   created per extension load and held by the router closure.
 * Invariants (VERIFYING.md): the on-disk transcript is never written (§3.3);
 *   injection is byte-stable until `agent_settled` (§3.4); boundary events
 *   emit structured logs (§3.9).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import type {
  ContextEvent,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

/** A skill selected for injection: catalog name plus full SKILL.md body. */
export interface SkillPayload {
  name: string;
  body: string;
}

/**
 * Return shape for the `context` seam (structurally identical to Pi's
 * ContextEventResult, which the package root does not export).
 */
export interface SkillInjectionResult {
  messages?: AgentMessage[];
}

/** The two event behaviors the router owns. Tests drive this seam directly. */
export interface SkillRouter {
  onContext(event: ContextEvent): SkillInjectionResult;
  onAgentSettled(): void;
}

/** M1 spike payload — replaced by the Jev-scored catalog in M2. */
export const SPIKE_SKILL: SkillPayload = {
  name: "jev-context-spike",
  body: [
    "# jev-context-spike",
    "",
    "M1 injection-seam proof for the jev-context extension.",
    "This body is hardcoded; Jev routing replaces it in M2.",
    "",
    "## Purpose",
    "Prove that a Pi extension can inject a skill body into the LLM",
    "context copy at a fixed position (immediately after the system",
    "prompt), byte-stable across every LLM call within an epoch.",
  ].join("\n"),
};

/**
 * Render the frozen injection message for an epoch: one synthetic user
 * message placed at messages[0], the position immediately after the system
 * prompt in the provider payload. `now` is the epoch build time; the returned
 * object is reused unchanged for the whole epoch.
 */
export function buildSkillInjection(
  skills: readonly SkillPayload[],
  now: number,
): UserMessage {
  const blocks = skills.map(
    (s) => `<skill name="${s.name}">\n${s.body}\n</skill>`,
  );
  const content = [
    "The following skills were routed into this conversation by",
    "jev-context. Their documentation below is active guidance for",
    "the work at hand.",
    "",
    ...blocks,
  ].join("\n");
  return { role: "user", content, timestamp: now };
}

/**
 * Create the M1 spike router: injects SPIKE_SKILL at a fixed position on
 * every `context` event, frozen until `agent_settled` closes the epoch.
 */
export function createSkillRouter(): SkillRouter {
  let epoch = 0;
  let injection: UserMessage | null = null;
  return {
    onContext(event: ContextEvent): SkillInjectionResult {
      if (injection === null) {
        epoch += 1;
        injection = buildSkillInjection([SPIKE_SKILL], Date.now());
        console.error(
          `ROUTE_DECISION: epoch=${epoch} scores={} loaded=[${SPIKE_SKILL.name}] skipped_active=[] evicted=[] latency_ms=0 input_tokens=0`,
        );
      }
      return { messages: [injection, ...event.messages] };
    },
    onAgentSettled(): void {
      injection = null;
    },
  };
}

/** Pi extension factory: wires the router to the event seam. */
export default function jevContext(pi: ExtensionAPI): void {
  const router = createSkillRouter();
  pi.on("context", (event) => router.onContext(event));
  pi.on("agent_settled", () => router.onAgentSettled());
}
