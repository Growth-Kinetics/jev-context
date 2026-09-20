// Tests: the injectable Jev client boundary. No network: the live client is exercised
// only through an injected fetch stub (VERIFYING.md section 4: no real API calls in tests).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalRequest,
  createCacheClient,
  createLiveClient,
  requestKey,
} from "./client.ts";
import type { JevRequest, JevResponse } from "./types.ts";

const req: JevRequest = {
  state: "the user is doing a browser task",
  model: "jev-latest",
  questions: {
    should_load: {
      type: "noul",
      instructions: "Is a browser skill relevant?",
      criteria: { true: "directly involved", false: "unrelated" },
    },
  },
};

test("request key is stable under question-map insertion order", () => {
  const reordered: JevRequest = {
    model: "jev-latest",
    state: "the user is doing a browser task",
    questions: Object.fromEntries(Object.entries(req.questions).reverse()),
  };
  assert.equal(requestKey(req), requestKey(reordered));
});

test("cache client returns recorded responses deterministically", async () => {
  const response: JevResponse = {
    answers: { should_load: 0.92 },
    usage: { input_tokens: 1234 },
  };
  const client = createCacheClient({ [requestKey(req)]: response });
  const a = await client(req);
  const b = await client(req);
  assert.deepEqual(a, b);
  assert.equal(a.answers.should_load, 0.92);
});

test("cache client fails loud on a key miss, never silently no-ops", async () => {
  const client = createCacheClient({});
  await assert.rejects(() => client(req), /CACHE_KEY_MISS/);
});

test("live client hits the endpoint once, records into the cache, then serves from it", async () => {
  const cache: Record<string, JevResponse> = {};
  let calls = 0;
  const stub: typeof fetch = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as JevRequest;
    assert.equal(body.model, "jev-latest");
    return new Response(
      JSON.stringify({
        answers: { should_load: { noul: 0.88 } },
        usage: { input_tokens: 42 },
      }),
      {
        status: 200,
      },
    );
  };
  const client = createLiveClient({
    endpoint: "https://example.invalid/api",
    apiKey: "test-key",
    cache,
    fetchImpl: stub,
  });
  const first = await client(req);
  assert.equal(first.answers.should_load, 0.88);
  assert.equal(first.usage?.input_tokens, 42);
  const second = await client(req);
  assert.equal(second.answers.should_load, 0.88);
  assert.equal(calls, 1); // second call served from the write-through cache
  assert.ok(requestKey(req) in cache);
});

test("live client surfaces HTTP errors as JEV_HTTP_<code>", async () => {
  const stub: typeof fetch = async () => new Response("nope", { status: 429 });
  const client = createLiveClient({
    endpoint: "https://example.invalid/api",
    apiKey: "k",
    cache: {},
    fetchImpl: stub,
  });
  await assert.rejects(() => client(req), /JEV_HTTP_429/);
});

test("canonical request embeds state, model and sorted questions", () => {
  const canon = JSON.parse(canonicalRequest(req));
  assert.equal(canon.state, req.state);
  assert.deepEqual(Object.keys(canon.questions), ["should_load"]);
});
