import crypto from "node:crypto";
import { ParmanaHttpClient, type BusinessTransaction, type ParmanaExecutionResult } from "./client.js";
import type { RefundIntent } from "../intent/refund-intent.js";

/**
 * Independent business facts customer-refund@1.0.0 requires and that
 * the Intent itself cannot express (see that policy's own
 * unboundSignalReasons, in the Parmana repository) -- eligibility,
 * manager approval, and a fraud check are all determined by systems
 * outside this agent. Deliberately NOT fabricated with a default here:
 * the caller (the human/system that invoked this agent) must supply
 * them. An AI agent inventing "managerApproved: true" out of nothing
 * would be exactly the self-authorization this system exists to
 * prevent.
 */
export interface RefundAuthorizationSignals {
  readonly refundEligible: boolean;
  readonly managerApproved: boolean;
  readonly fraudCheckPassed: boolean;
}

const REFUND_TRANSACTION_NAMESPACE = "parmana-openai-refund-agent:v1";

/**
 * Deterministic, keyed on the logical refund (orderId, txnId) -- not a
 * fresh crypto.randomUUID() per call. A retried request for the same
 * logical refund reuses the same businessTransactionId, so it lands on
 * Parmana's own existing nonce/trust-record replay protection
 * automatically, rather than this agent needing a parallel dedup store
 * of its own.
 */
export function deterministicBusinessTransactionId(orderId: string, txnId: string): string {
  const seed = `${REFUND_TRANSACTION_NAMESPACE}:${orderId}:${txnId}`;
  const digest = crypto.createHash("sha256").update(seed, "utf8").digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  const byte6 = bytes[6];
  const byte8 = bytes[8];
  if (byte6 === undefined || byte8 === undefined) throw new Error("unable to construct deterministic transaction id");
  bytes[6] = (byte6 & 0x0f) | 0x40;
  bytes[8] = (byte8 & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function deterministicUuid(seed: string): string {
  const digest = crypto.createHash("sha256").update(seed, "utf8").digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  const byte6 = bytes[6];
  const byte8 = bytes[8];
  if (byte6 === undefined || byte8 === undefined) throw new Error("unable to construct deterministic id");
  bytes[6] = (byte6 & 0x0f) | 0x40;
  bytes[8] = (byte8 & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Seam RefundAgent depends on, so agent-level tests can substitute an
 * in-memory fake instead of mocking fetch through the full HTTP
 * client. ParmanaRefundAuthorizer (below) is the only production
 * implementation.
 */
export interface RefundAuthorizer {
  authorize(intent: RefundIntent, signals: RefundAuthorizationSignals): Promise<ParmanaExecutionResult>;
}

/**
 * The only class in this codebase that talks to Parmana. It never
 * decides anything -- it builds exactly the Business Transaction the
 * real /execute contract requires from an already-validated
 * RefundIntent, submits it, and returns whatever Parmana decided,
 * unmodified.
 */
export class ParmanaRefundAuthorizer implements RefundAuthorizer {
  constructor(
    private readonly client: ParmanaHttpClient,
    private readonly principalId: string,
  ) {
    if (!principalId.trim()) throw new Error("Parmana principalId is required");
  }

  async authorize(intent: RefundIntent, signals: RefundAuthorizationSignals): Promise<ParmanaExecutionResult> {
    const businessTransactionId = deterministicBusinessTransactionId(intent.orderId, intent.txnId);
    const authorityId = deterministicUuid(`${businessTransactionId}:authority`);
    const authorizationId = deterministicUuid(`${businessTransactionId}:authorization`);
    const intentId = deterministicUuid(`${businessTransactionId}:intent`);
    const issuedAt = new Date().toISOString();

    const transaction: BusinessTransaction = {
      businessTransactionId,
      metadata: {
        businessTransactionId,
        integration: "parmana-openai-refund-agent",
      },
      authority: {
        authorityId,
        authorityType: "SERVICE",
        principalId: this.principalId,
        issuedAt,
      },
      authorization: {
        authorizationId,
        authorityId,
        purpose: "Authorize Paytm customer refund (OpenAI-proposed intent)",
        issuedAt,
      },
      intent: {
        intentId,
        authorizationId,
        action: intent.action,
        target: intent.orderId,
        // Exactly the real paytm:refund capability's allowlist --
        // {orderId, transactionId, amount}. No refId (Parmana's own
        // GatewayPaytmAdapter derives it), no txnId key (Parmana's
        // parameter name is transactionId).
        parameters: {
          orderId: intent.orderId,
          transactionId: intent.txnId,
          amount: intent.amount,
        },
        createdAt: issuedAt,
      },
      policy: { name: "customer-refund", version: "1.0.0", schemaVersion: "1.0.0" },
      signals: {
        refundEligible: signals.refundEligible,
        managerApproved: signals.managerApproved,
        fraudCheckPassed: signals.fraudCheckPassed,
        // Bound signal (policy.json's boundSignals: refundAmount ->
        // parameters.amount) -- always derived from the same
        // validated intent.amount that will actually execute, never a
        // second, independently-suppliable value. This is what makes
        // an "authorize 500, execute 50000" tamper impossible: there
        // is only ever one amount in this code.
        refundAmount: intent.amount,
      },
      status: "RECEIVED",
      createdAt: issuedAt,
    };

    return this.client.execute(transaction);
  }
}
