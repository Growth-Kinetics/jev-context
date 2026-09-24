// TYPES: shared shapes for the benchmark harness.
// SOURCE OF TRUTH for the on-disk format: ~/.pi/agent/sessions/**/*.jsonl as written by Pi.
// Every field optional except the discriminating ones; the parser guards, never trusts.

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | { type: "image"; data: string; mimeType?: string };

export interface ChatMessage {
  role: "user" | "assistant";
  content: MessagePart[];
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: MessagePart[];
  isError?: boolean;
}

export type PiMessage = ChatMessage | ToolResultMessage;

export interface SessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: PiMessage;
  /** context_edit (Pi >= 0.87): id of the entry this edit targets */
  targetId?: string;
  /** null = omit the target from model context; { content } = replace content only */
  replacement?: ContextEditReplacement | null;
}

export interface ContextEditReplacement {
  /** parts array, or a plain string (assistant/toolResult: projected to one text part) */
  content: MessagePart[] | string;
}

/** One agent epoch: a user turn plus everything Pi did before the next user turn. */
export interface Epoch {
  index: number;
  entries: SessionEntry[];
  /** assistant message count = LLM calls billed against this epoch's context */
  callCount: number;
}

export interface ParsedSession {
  path: string;
  /** raw on-disk entries, append-only truth (context_edit entries included) */
  entries: SessionEntry[];
  /** model-visible entries after context_edit projection (what the LLM was billed) */
  projected: SessionEntry[];
  epochs: Epoch[];
}

/** A toolCall part paired with its toolResult message, both located in one epoch. */
export interface ToolPair {
  call: { id: string; name: string; arguments: Record<string, unknown> };
  result: ToolResultMessage | null;
  epochIndex: number;
}

// ---------------------------------------------------------------------------
// Jev client contract (mirrors the injectable client the extension will use;
// reconciliation pass aligns them once nozzles land).

export interface JevQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface JevRequest {
  state: string;
  model: string;
  questions: Record<string, JevQuestion>;
}

export interface JevResponse {
  answers: Record<string, number>;
  usage?: { input_tokens: number };
  latencyMs?: number;
}

export type JevClient = (req: JevRequest) => Promise<JevResponse>;
