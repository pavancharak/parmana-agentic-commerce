# Demo

## Prerequisites

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

- `OPENAI_API_KEY` — a real OpenAI API key. **Not included in this session** (none was available)
  — every OpenAI interaction is tested against a dependency-injected fake client instead; see
  `tests/unit/openai-client.test.ts` and `tests/unit/refund-agent.test.ts`.
- `OPENAI_MODEL` — the exact model string for your OpenAI account/API version. Verify against
  OpenAI's current model list before running live; this repository never hardcodes a model name.
- `PARMANA_API_URL=https://parmana-api-real.vercel.app` (already the real, live deployment).
- `PARMANA_API_KEY` — a real Parmana caller key, scoped to `paytm:refund`
  (`npx tsx scripts/generate-api-key.ts --caller-id <your-caller-id> --allowed-capabilities
  paytm:refund`, run from the Parmana repo, then register the printed entry in that deployment's
  `PARMANA_API_KEYS`).
- `PARMANA_PRINCIPAL_ID` — must equal your API key's `callerId` unless that key was given an
  explicit `allowedPrincipalIds` grant (see Parmana's `isPrincipalAllowed.ts`).

## Run locally

```bash
npm run build   # tsc --noEmit
npm run lint     # eslint .
npm test          # vitest run -- 66 tests, all passing without a real OPENAI_API_KEY
npm start          # listens on PORT (default 3001)
```

## Exercise it

```bash
curl -s http://localhost:3001/health

curl -s -X POST http://localhost:3001/agent/refund \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Customer says order ORD-123 arrived damaged. Please refund ₹500.",
    "orderId": "ORD-123",
    "txnId": "TXN-123",
    "amount": 500,
    "currency": "INR",
    "signals": { "refundEligible": true, "managerApproved": true, "fraudCheckPassed": true }
  }'
```

Expected once a real `OPENAI_API_KEY` and a real `PARMANA_API_KEY` are configured: `HTTP 200`,
`status: "APPROVED"`, `executed: true`, with `execution`/`evidence` populated from Parmana's real
Execution Trust Record. The Paytm leg itself will still fail (`resultStatus: "TXN_FAILURE"`,
`"Invalid merchant Id"`) until `parmana-paytm-agent`'s own `PAYTM_MERCHANT_ID`/`PAYTM_MERCHANT_KEY`
are replaced with real staging credentials — that is expected and does not indicate a bug in this
agent or in Parmana's authorization.

A denied case (amount over the policy threshold):

```bash
curl -s -X POST http://localhost:3001/agent/refund \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Refund ₹50,000 for order ORD-999.",
    "orderId": "ORD-999",
    "txnId": "TXN-999",
    "amount": 50000,
    "currency": "INR",
    "signals": { "refundEligible": true, "managerApproved": true, "fraudCheckPassed": true }
  }'
```

Expected: `HTTP 403`, `status: "DENIED"`, `executed: false`, reason naming the exceeded threshold.

## What is already proven, without a real OpenAI key

This session verified, live, against the real deployed infrastructure (not mocks) that everything
downstream of a validated `RefundIntent` genuinely works:

- `POST https://parmana-api-real.vercel.app/execute` with the exact transaction shape this agent
  builds (`src/parmana/authorizer.ts`) returns a real, signed `APPROVED` decision for an eligible
  refund, and a real `403 POLICY_DENIED` for an over-threshold one.
- The `APPROVED` case's Execution Trust Record shows Parmana's own Execution Gateway dispatched to
  the real, deployed `parmana-paytm-agent` connector service
  (`https://parmana-paytm-agent.vercel.app`), which in turn reached Paytm's real staging API
  (visible in the evidence's `resultStatus`/`resultCode`).

What has **not** been exercised live this session: the OpenAI call itself (no API key available),
and this agent's own deployed Vercel instance receiving a real end-to-end request with a real
`OPENAI_API_KEY`. Both are mechanically ready — see `vercel.json`/`api/index.ts` — and only need
real credentials to complete.

## Deploying

```bash
npx vercel env add OPENAI_API_KEY production
npx vercel env add OPENAI_MODEL production
npx vercel env add PARMANA_API_URL production
npx vercel env add PARMANA_API_KEY production
npx vercel env add PARMANA_PRINCIPAL_ID production
npx vercel deploy --prod
```

`vercel.json` rewrites every path to `api/index.ts`, a Vercel Node.js Function wrapping the same
`requestHandler` the local server uses — no behavior fork between local and deployed.
