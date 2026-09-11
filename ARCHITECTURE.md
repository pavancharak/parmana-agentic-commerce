# Architecture

## The five layers, and who owns what

```
AI            = intelligence / proposal            (this repository)
Parmana       = authority / authorization           (pavancharak/AgentLabsBuildathon)
Execution Gateway = governed execution               (inside Parmana, GatewayPaytmAdapter)
Paytm Connector    = deterministic external execution (pavancharak/parmana-paytm-agent)
Paytm              = financial consequence            (Paytm's own API)
```

**Core statement:** AI can be intelligent without being in charge. Your business rules still decide
what it is allowed to do.

## Full request flow

```
1. Customer sends a natural-language refund request (+ optional structured hints, + required
   independent signals) to POST /agent/refund on this service.

2. This agent calls OpenAI (Structured Outputs, strict JSON schema) to interpret the message into
   a RefundIntent candidate: {action, orderId, txnId, amount, currency, reason}.

3. The candidate is strictly re-validated (src/intent/refund-intent.ts) regardless of OpenAI's own
   schema guarantee -- unknown fields are silently dropped, every field is re-checked. Any
   caller-supplied orderId/txnId/amount/currency hints OVERRIDE whatever the model proposed for
   those fields (see SECURITY.md's prompt-injection section for why).

4. This agent builds a real Parmana Business Transaction from the validated RefundIntent + the
   caller-supplied signals, and submits it via POST /execute to the real Parmana API
   (PARMANA_API_URL). businessTransactionId is deterministic, derived from (orderId, txnId) --
   never crypto.randomUUID() -- so a retried request for the same logical refund lands on
   Parmana's own existing nonce/trust-record replay protection automatically.

5. Parmana evaluates customer-refund@1.0.0 against the submitted signals. This agent does not,
   and must never, duplicate that policy logic locally.

   - DENIED (HTTP 403, {error, code: "POLICY_DENIED"}): this agent returns
     {status: "DENIED", executed: false, ...} immediately. It never calls Paytm, never calls the
     Paytm connector, never retries with different parameters, and never reinterprets DENIED as
     APPROVED. There is no code path in this repository that could do any of those things --  see
     tests/unit/credential-boundary.test.ts and tests/unit/refund-agent.test.ts's prompt-injection
     suite.

   - APPROVED (HTTP 200): Parmana's own Execution Gateway has ALREADY dispatched to
     GatewayPaytmAdapter, which has ALREADY called the real, out-of-process Paytm connector
     service (parmana-paytm-agent) over HTTPS, which has ALREADY called Paytm's real API --  all
     of this happens synchronously, inside Parmana's own /execute call, before this agent ever
     sees a response. The full signed Execution Trust Record (including the connector's own
     evidence) comes back in that one response. This agent surfaces it; it does not, and cannot,
     trigger it a second time.

6. This agent returns the real decision, real authorization id, real execution record, and real
   evidence -- verbatim, never fabricated.
```

## Why this agent never calls the Paytm connector directly

`POST /connector/paytm-refund` (on parmana-paytm-agent) is authenticated by
`PAYTM_CONNECTOR_SHARED_SECRET`, a credential this agent never holds and is structurally
prevented from ever holding (see SECURITY.md and `tests/unit/credential-boundary.test.ts`, which
fails the build if this repository's own source ever references that variable name, a Paytm
merchant credential, or that connector path). The only path from this agent to Paytm is:

```
this agent -> Parmana POST /execute -> (Parmana's own internal dispatch) -> Paytm
```

There is no second path. Building one — even for a "faster" demo — would be exactly the
authorization bypass this whole system exists to prevent.

## The real wire contract (verified, not assumed)

Before writing a single line of this agent, the existing Parmana and Paytm connector repositories
were inspected directly, live:

- `paytm:refund` is the real, namespaced capability id bound to `customer-refund@1.0.0`
  (`CANONICAL_CAPABILITY_POLICY_BINDINGS` in the Parmana repo) — not `paytm-refund`, the
  hyphenated string the connector service's own internal wire format happens to use for a
  *different* purpose (the request Parmana's Execution Gateway sends the connector service, which
  this agent never constructs).
- The real `paytm:refund` capability's deny-by-default parameter allowlist is exactly `{orderId,
  transactionId, amount, refundReason}`. There is no caller-supplied `refId` — Parmana's own
  `GatewayPaytmAdapter` derives it itself, deterministically, from `orderId` + `transactionId`.
  An earlier draft of the *other* repository's own Parmana-calling code sent `refId`/`txnId` as
  parameters and was refused outright by the real API (`HTTP 500`, confirmed live) — fixed in that
  repository this same session, and never repeated here.
- Parmana's real `POST /execute` response is the full signed Execution Trust Record
  (`{trustRecordId, businessTransactionId, transaction, executions, authorization, ...}`), not an
  invented `{transaction, context, trustRecord}` envelope. A clean policy denial is `HTTP 403`
  `{error, code: "POLICY_DENIED"}` — a normal, expected result, never an exception.

`src/parmana/client.ts` and `src/parmana/authorizer.ts` implement exactly this, verified contract.

## Idempotency / duplicate refunds

`deterministicBusinessTransactionId(orderId, txnId)` (`src/parmana/authorizer.ts`) is a pure
SHA-256-based hash — no `Date.now()`, no `Math.random()`. A retried request for the same logical
refund (same `orderId`/`txnId`) always derives the same `businessTransactionId`, which Parmana's
own existing nonce/replay-protection machinery already governs. This agent introduces no second,
parallel transaction store.
