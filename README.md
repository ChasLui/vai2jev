# vai2jev

A Jev-only front for the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway), deployed on
Vercel. It speaks the `@typesafe-ai/sdk` protocol, so a client only needs a base URL and a key.

Why it exists: a Vercel AI Gateway key (`vck_...`) can call **every** model Vercel fronts. This
proxy holds that key server-side and pins every request to `typesafe-ai/jev`, so the credential
you hand out can only ever spend on Jev.

No protocol translation is involved — the gateway already serves TypeSafe's own request and
response shapes at `/typesafe/v1/systemone`.

Yes/no questions are `type: "noul"` here, as in the TypeSafe SDK. The gateway's other Jev endpoint,
`/v4/ai/evaluation-model`, calls the same thing `type: "boolean"` and rejects `noul` with a 400 —
don't copy request bodies between the two.

## Use it

```ts
import { TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient({
  apiKey: process.env.JEV_API_KEY, // the self-issued token, not the vck_ key
  baseURL: process.env.JEV_BASE_URL, // https://<deployment>.vercel.app
});

const result = await client.systemOne({
  state: "I was charged twice for my subscription.",
  questions: {
    refund: { type: "noul", instructions: "Is the customer asking for money back?" },
  },
});

console.log(result.answers.refund.noul); // 0.76
```

The SDK reads `TYPESAFE_API_KEY` / `TYPESAFE_BASE_URL` from the environment, not `JEV_*`. To skip
the constructor arguments, alias them:

```sh
export TYPESAFE_API_KEY=$JEV_API_KEY
export TYPESAFE_BASE_URL=$JEV_BASE_URL
```

## Routes

| Route                 | Behaviour                                                      |
| --------------------- | -------------------------------------------------------------- |
| `POST /v1/systemone`  | Authenticates, pins `model` to `typesafe-ai/jev`, forwards      |
| `GET /v1/models`      | Lists the one model served (`jev-latest`)                       |
| `GET /healthz`        | Liveness                                                        |
| anything else         | `404`                                                           |

Upstream status codes pass through untouched, so the SDK's own 429/5xx backoff still applies.

## Deploy

```sh
vercel link
openssl rand -hex 32                                    # your JEV_API_KEY
vercel env add JEV_API_KEY production                   # the token clients will use
vercel env add VERCEL_AI_GATEWAY_API_KEY_JEV production # the vck_... gateway key
vercel deploy --prod
```

The gateway key is deliberately **not** named `AI_GATEWAY_API_KEY`: the AI SDK's gateway provider
picks that name up automatically, and any code in the project could then bill any model with it.

## Test

```sh
node --test
```
