// CLIENT: the single injectable Jev boundary. Fixture mode = committed recorded-score cache
// keyed by request content hash (deterministic, free, loud on miss). --live mode = real HTTP
// with write-through into the cache so later replays are free. Tests never touch network:
// they construct cache-backed or in-memory clients only.

import { readFileSync, writeFileSync } from "node:fs";
import { sha256 } from "./catalog.ts";
import type { JevClient, JevRequest, JevResponse } from "./types.ts";

export type ScoreCache = Record<string, JevResponse>;

export function loadCache(path: string): ScoreCache {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ScoreCache;
  } catch {
    return {};
  }
}

export function saveCache(path: string, cache: ScoreCache): void {
  // sorted keys => byte-stable file
  const sorted: ScoreCache = {};
  for (const key of Object.keys(cache).sort()) sorted[key] = cache[key];
  writeFileSync(path, `${JSON.stringify(sorted, null, 1)}\n`);
}

/** canonical request serialization: sorted question keys, no whitespace variance */
export function canonicalRequest(req: JevRequest): string {
  const questions: Record<string, JevRequest["questions"][string]> = {};
  for (const id of Object.keys(req.questions).sort()) questions[id] = req.questions[id];
  return JSON.stringify({ model: req.model, questions, state: req.state });
}

export function requestKey(req: JevRequest): string {
  return sha256(canonicalRequest(req));
}

export function createCacheClient(cache: ScoreCache): JevClient {
  return async (req) => {
    const key = requestKey(req);
    const hit = cache[key];
    if (hit === undefined) {
      throw new Error(`CACHE_KEY_MISS: ${key} (run with --live to record, or extend fixtures)`);
    }
    return hit;
  };
}

export interface LiveClientOptions {
  endpoint: string;
  apiKey: string;
  cache: ScoreCache;
  cachePath?: string;
  /** persisted after each response when set; keeps recorded runs crash-safe */
  onRecord?: (cache: ScoreCache) => void;
  /** injectable for tests; defaults to global fetch. Tests MUST pass a stub. */
  fetchImpl?: typeof fetch;
}

export function createLiveClient(opts: LiveClientOptions): JevClient {
  return async (req) => {
    const key = requestKey(req);
    const hit = opts.cache[key];
    if (hit !== undefined) return hit;
    const started = Date.now();
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(opts.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state: req.state, model: req.model, questions: req.questions }),
    });
    if (!res.ok) {
      throw new Error(`JEV_HTTP_${res.status}: key=${key}`);
    }
    const data = (await res.json()) as {
      answers?: Record<string, { noul?: number }>;
      usage?: { input_tokens?: number };
    };
    const answers: Record<string, number> = {};
    for (const [id, a] of Object.entries(data.answers ?? {})) {
      if (typeof a?.noul === "number") answers[id] = a.noul;
    }
    const response: JevResponse = {
      answers,
      usage: { input_tokens: data.usage?.input_tokens ?? 0 },
      latencyMs: Date.now() - started,
    };
    opts.cache[key] = response;
    opts.onRecord?.(opts.cache);
    return response;
  };
}
