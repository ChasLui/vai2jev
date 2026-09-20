// vai2jev — a Jev-only front for the Vercel AI Gateway.
//
// The gateway already serves TypeSafe's own request/response shapes at
// `/typesafe/v1/systemone`, so no protocol translation is needed: this proxy exists only to
// keep the gateway key server-side and to pin the model. A gateway key can call every model
// Vercel fronts; the self-issued JEV_API_KEY handed to clients can only reach typesafe-ai/jev.
//
// Env: JEV_API_KEY (client credential), VERCEL_AI_GATEWAY_API_KEY_JEV (the real vck_ key).
// The gateway key is deliberately NOT named AI_GATEWAY_API_KEY — the AI SDK's gateway
// provider auto-picks that name up and would bill any model with it.

export const config = { runtime: "edge" };

const UPSTREAM = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";
const MODEL_ID = "typesafe-ai/jev";
const MAX_BODY_BYTES = 1 << 20;
const UPSTREAM_TIMEOUT_MS = 30_000;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** TypeSafe's error shape, so a client that already handles TypeSafe errors keeps working. */
const err = (status, message, errorType = "invalid_request") =>
  json(status, { message, error_type: errorType });

/**
 * Constant-time compare; length differences leak but the secret's length is not the secret.
 * An empty `b` never matches: a missing JEV_API_KEY must fail closed, not authenticate
 * every caller and turn this into an open relay for the gateway key.
 */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
    return false;
  if (b.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Read a bounded JSON body. Returns undefined on oversize or malformed input. */
async function readJson(request, maxBytes) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return undefined;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) return undefined;
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body)
      ? body
      : undefined;
  } catch {
    return undefined;
  }
}

export default async function handler(request) {
  const { pathname } = new URL(request.url);

  if (request.method === "GET" && pathname === "/healthz") {
    return json(200, { ok: true, model: MODEL_ID });
  }

  // Some clients probe `{baseURL}/v1/models` during login/validate; answer with the one
  // model served, which doubles as this proxy's statement that jev is all it does.
  if (request.method === "GET" && pathname === "/v1/models") {
    return json(200, { models: [{ id: "jev-latest" }] });
  }

  if (request.method !== "POST" || pathname !== "/v1/systemone") {
    return err(404, `no route for ${request.method} ${pathname}`);
  }

  const token = (request.headers.get("authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (!timingSafeEqual(token, process.env.JEV_API_KEY ?? "")) {
    return err(401, "invalid api key", "authentication_error");
  }

  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body) return err(400, "invalid or oversized json body");

  // Whatever the client asked for, only jev is ever called.
  body.model = MODEL_ID;

  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.VERCEL_AI_GATEWAY_API_KEY_JEV ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return err(502, "upstream unreachable", "api_error");
  }

  // Status passes through untouched so the client SDK's own 429/5xx backoff still applies.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
