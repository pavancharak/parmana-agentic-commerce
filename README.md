# Parmana OpenAI Refund Agent

A real, OpenAI-powered agent that proposes customer refunds from natural language — but never
authorizes them. **Parmana is the authority.** This agent can be intelligent without being in
charge.

```text
Customer
   ↓
OpenAI Refund Agent   (this repository)
   ↓
Refund Intent
   ↓
Parmana Authorization
  /       \
DENIED    APPROVED
  ↓          ↓
STOP    Execution Gateway → Paytm Connector → Paytm API → Evidence
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full flow, [SECURITY.md](./SECURITY.md) for the
credential/trust boundaries and prompt-injection posture, and [DEMO.md](./DEMO.md) for exact
commands to run it.

## What this is not

This is not a second authorization system. It does not evaluate policy, does not decide APPROVED
or DENIED, and does not call Paytm or the Paytm connector directly — it calls Parmana's real
`POST /execute`, the same endpoint any other caller uses, and returns exactly what Parmana decided.

## Quickstart

```bash
npm install
cp .env.example .env   # fill in OPENAI_API_KEY, OPENAI_MODEL, PARMANA_API_KEY
npm run build          # tsc --noEmit
npm run lint            # eslint .
npm test                 # vitest run
npm start                # local server on PORT (default 3001)
```

## API

```
POST /agent/refund
{
  "message": "Refund ₹500 for order ORD-123 because it arrived damaged.",
  "orderId": "ORD-123",
  "txnId": "TXN-123",
  "amount": 500,
  "currency": "INR",
  "signals": { "refundEligible": true, "managerApproved": true, "fraudCheckPassed": true }
}
```

`orderId`/`txnId`/`amount`/`currency` are optional hints — when present they are **authoritative**
over whatever the model proposes (see SECURITY.md's prompt-injection section for why). `message`
and `signals` are required; `signals` are independent business facts (eligibility, manager
approval, fraud check) that only your own systems can attest to — this agent never fabricates them.

```
GET /health
```

## Response shapes

**Approved** (`HTTP 200`):

```json
{
  "status": "APPROVED",
  "executed": true,
  "state": "COMPLETED",
  "authorization": { "authorizationId": "...", "businessTransactionId": "..." },
  "execution": { "...": "Parmana's real execution record, unmodified" },
  "evidence": { "...": "the connector's own evidence, unmodified" }
}
```

**Denied** (`HTTP 403`):

```json
{
  "status": "DENIED",
  "executed": false,
  "state": "DENIED",
  "authorization": { "businessTransactionId": "...", "reason": "..." }
}
```

`execution`/`evidence` fields are the **real** fields from Parmana's Execution Trust Record — never
fabricated by this agent. See ARCHITECTURE.md for exactly what each field means.

## Environment variables

See [`.env.example`](./.env.example) for the full, commented list. In short:

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Your OpenAI credential. Never committed. |
| `OPENAI_MODEL` | The model used for structured-output intent extraction. |
| `PARMANA_API_URL` | The real Parmana API this agent calls. |
| `PARMANA_API_KEY` | This agent's own caller credential for Parmana — **not** a Paytm credential. |
| `PARMANA_PRINCIPAL_ID` | The principal this agent asserts to Parmana; must match what your `PARMANA_API_KEYS` entry allows. |
| `AGENT_API_KEY` | Optional. Inbound auth for `POST /agent/refund`. Strongly recommended for any real deployment. |

**Never present here:** `PAYTM_MERCHANT_ID`, `PAYTM_MERCHANT_KEY`, `PAYTM_CONNECTOR_SHARED_SECRET`.
Those belong exclusively to [`parmana-paytm-agent`](https://github.com/pavancharak/parmana-paytm-agent).

## Status

Build, lint, and the full test suite (66 tests) are green as of this writing — see
`docs`/this README's own DEMO.md for the exact commands run and their output. The agent has **not**
been exercised against a real OpenAI API key in this session (none was available); every OpenAI
interaction is tested against a dependency-injected fake client. It **has** been proven, live, that
Parmana authorization and the downstream Execution Gateway → Paytm Connector → Paytm staging API
chain all work correctly for the exact request shape this agent sends (verified directly against
`https://parmana-api-real.vercel.app` and `https://parmana-paytm-agent.vercel.app`).
