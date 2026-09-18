// TOKENS: documented bytes->tokens estimator. No tokenizer dependency (zero runtime deps).
// Calibration: conversation text measures ~3.5 bytes/token against the Jev usage recorded
// during the 2026-09-18 calibration probes (see eval/README.md "Token model").
// Images have no byte-proportional token cost upstream, but are rare in this corpus and
// never arm-differential except under pruning; they ride the same constant and are reported
// in a separate bucket so the caveat stays visible.

export const BYTES_PER_TOKEN = 3.5;
export const USD_PER_MTOK_INPUT = 0.042;

export function estimateTokens(byteLength: number): number {
  return Math.round(byteLength / BYTES_PER_TOKEN);
}

export function usdFromTokens(tokens: number): number {
  return (tokens * USD_PER_MTOK_INPUT) / 1_000_000;
}
