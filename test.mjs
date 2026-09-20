// Offline checks for the only logic here: auth and the model pin. Upstream is stubbed.
import { strict as assert } from "node:assert";
import test from "node:test";

process.env.JEV_API_KEY = "client-token";
process.env.VERCEL_AI_GATEWAY_API_KEY_JEV = "vck_test";

const { default: handler } = await import("./api/index.js");

const BASE = "https://proxy.test";
const QUESTIONS = { refund: { type: "noul", instructions: "Asking for money back?" } };

/** Replace global fetch with a recorder returning `response`; returns the captured calls. */
function stubFetch(response = new Response("{}", { status: 200 })) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return response;
  };
  return calls;
}

const post = (body, headers = { authorization: "Bearer client-token" }) =>
  handler(
    new Request(`${BASE}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

test("rejects a bad token without ever reaching upstream", async () => {
  const calls = stubFetch();
  for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "Bearer " }]) {
    const res = await post({ state: "s", questions: QUESTIONS }, headers);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error_type, "authentication_error");
  }
  assert.equal(calls.length, 0, "upstream must not be called for unauthenticated requests");
});

test("pins the model regardless of what the client asks for", async () => {
  const calls = stubFetch();
  await post({ model: "openai/gpt-5", state: "s", questions: QUESTIONS });
  assert.equal(calls[0].body.model, "typesafe-ai/jev");
  assert.equal(calls[0].body.state, "s", "the rest of the body passes through");
  assert.equal(calls[0].init.headers.authorization, "Bearer vck_test", "server-side key is used");
});

test("passes the upstream response through verbatim", async () => {
  const payload = { model: "typesafe-ai/jev", answers: { refund: { type: "noul", noul: 0.76 } } };
  stubFetch(new Response(JSON.stringify(payload), { status: 200 }));
  const res = await post({ state: "s", questions: QUESTIONS });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), payload);
});

test("passes upstream 429 through so the client SDK can back off", async () => {
  stubFetch(new Response('{"message":"rate limited"}', { status: 429 }));
  const res = await post({ state: "s", questions: QUESTIONS });
  assert.equal(res.status, 429);
});

test("rejects a malformed body before calling upstream", async () => {
  const calls = stubFetch();
  const res = await handler(
    new Request(`${BASE}/v1/systemone`, {
      method: "POST",
      headers: { authorization: "Bearer client-token", "content-type": "application/json" },
      body: "not json",
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test("serves only jev on /v1/models and 404s everything else", async () => {
  const models = await handler(new Request(`${BASE}/v1/models`));
  assert.deepEqual(await models.json(), { models: [{ id: "jev-latest" }] });

  const health = await handler(new Request(`${BASE}/healthz`));
  assert.equal((await health.json()).model, "typesafe-ai/jev");

  for (const path of ["/v1/chat/completions", "/v1/systemone", "/"]) {
    const res = await handler(new Request(`${BASE}${path}`));
    assert.equal(res.status, 404, `GET ${path} must 404`);
  }
});
