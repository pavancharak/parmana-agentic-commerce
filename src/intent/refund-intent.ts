/**
 * RefundIntent: the strict, structured proposal the OpenAI agent may
 * produce. This is the ENTIRE surface between free-form model output
 * and the rest of the system -- nothing downstream ever reads
 * anything else the model said.
 *
 * Field names and the wire contract this eventually feeds
 * (Parmana's real, deployed paytm:refund capability) were verified
 * directly against:
 *   - pavancharak/parmana-paytm-agent (the Paytm connector service)
 *   - the live Parmana API (https://parmana-api-real.vercel.app)
 * not invented. In particular: Parmana's paytm:refund capability's
 * deny-by-default parameter allowlist is exactly {orderId,
 * transactionId, amount, refundReason} -- there is no caller-supplied
 * refId in the real contract (GatewayPaytmAdapter derives it itself,
 * deterministically, from orderId+transactionId). A caller-supplied
 * refId was in an earlier draft of this integration and confirmed,
 * live, to be refused outright (HTTP 500, "unsupported refund
 * parameters") -- deliberately not reintroduced here.
 */
export interface RefundIntent {
  /** Fixed to Parmana's real, namespaced capability id -- never caller-widened. */
  readonly action: "paytm:refund";
  readonly orderId: string;
  readonly txnId: string;
  readonly amount: number;
  readonly currency: "INR";
  readonly reason: string;
}

/**
 * The JSON Schema handed to the OpenAI Structured Outputs API
 * (response_format: {type: "json_schema", strict: true, ...}). Keeping
 * this in the same file as the TS type and the runtime validator below
 * means the three can never silently drift apart from one another.
 */
export const REFUND_INTENT_JSON_SCHEMA = Object.freeze({
  name: "RefundIntent",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["action", "orderId", "txnId", "amount", "currency", "reason"],
    properties: {
      action: { type: "string", enum: ["paytm:refund"] },
      orderId: { type: "string", minLength: 1, maxLength: 128 },
      txnId: { type: "string", minLength: 1, maxLength: 128 },
      amount: { type: "number", exclusiveMinimum: 0 },
      currency: { type: "string", enum: ["INR"] },
      reason: { type: "string", minLength: 1, maxLength: 500 },
    },
  },
} as const);

export class InvalidRefundIntentError extends Error {
  constructor(
    public readonly violations: readonly string[],
    rawCandidate: unknown,
  ) {
    super(`Invalid RefundIntent: ${violations.join("; ")}. Candidate: ${safeStringify(rawCandidate)}`);
    this.name = "InvalidRefundIntentError";
  }
}

/**
 * Validates a candidate structured-output object against RefundIntent
 * before it is ever used for anything -- OpenAI's Structured Outputs
 * mode is a strong constraint on the model, not a substitute for this
 * check. Never trusts the candidate's shape, never widens or coerces
 * a field beyond what is explicitly allowed here, and never reads any
 * field this interface does not declare (defends against a candidate
 * carrying extra, adversarial fields like a caller-declared "decision"
 * or "bypass" key -- they are silently absent from the return value,
 * not merely unused).
 */
export function validateRefundIntent(candidate: unknown): RefundIntent {
  const violations: string[] = [];

  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new InvalidRefundIntentError(["candidate must be a JSON object"], candidate);
  }

  const value = candidate as Record<string, unknown>;

  if (value["action"] !== "paytm:refund") {
    violations.push('action must be exactly "paytm:refund"');
  }

  const orderId = requireNonEmptyString(value["orderId"], "orderId", violations);
  const txnId = requireNonEmptyString(value["txnId"], "txnId", violations);
  const reason = requireNonEmptyString(value["reason"], "reason", violations);

  const amountRaw = value["amount"];
  let amount = 0;
  if (typeof amountRaw !== "number" || !Number.isFinite(amountRaw) || amountRaw <= 0) {
    violations.push("amount must be a finite positive number");
  } else {
    amount = amountRaw;
  }

  if (value["currency"] !== "INR") {
    violations.push('currency must be exactly "INR" (this integration is Paytm/INR-only)');
  }

  if (violations.length > 0) {
    throw new InvalidRefundIntentError(violations, candidate);
  }

  return Object.freeze({
    action: "paytm:refund",
    orderId,
    txnId,
    amount,
    currency: "INR",
    reason,
  });
}

function requireNonEmptyString(value: unknown, field: string, violations: string[]): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    violations.push(`${field} must be a non-empty string`);
    return "";
  }
  return value;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return "<unserializable>";
  }
}
