/**
 * HTTP client for the real, deployed Parmana API. Same verified
 * contract as pavancharak/parmana-paytm-agent's (fixed) client this
 * session: POST /execute returns either the full signed Execution
 * Trust Record (HTTP 200) or {error, code: "POLICY_DENIED"} (HTTP
 * 403) -- never the {transaction, context, trustRecord} envelope an
 * earlier, unverified draft of that other repository's client
 * assumed. This file is a fresh implementation of the same, now
 * cross-repo-proven contract, not a copy of unverified code.
 */

export interface ParmanaClientConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
}

export interface BusinessTransaction {
  readonly businessTransactionId: string;
  readonly metadata: Record<string, unknown>;
  readonly authority: Record<string, unknown>;
  readonly authorization: Record<string, unknown>;
  readonly intent: Record<string, unknown>;
  readonly policy: Record<string, unknown>;
  readonly signals: Record<string, unknown>;
  readonly status: "RECEIVED";
  readonly createdAt: string;
}

export type ParmanaExecutionResult =
  | {
      readonly outcome: "APPROVED";
      readonly businessTransactionId: string;
      readonly authorizationId: string;
      readonly trustRecord: Record<string, unknown>;
    }
  | {
      readonly outcome: "DENIED";
      readonly businessTransactionId: string;
      readonly reason: string;
    };

/** HTTP 409/5xx: the real Parmana outcome could not be determined from this response alone. */
export class ParmanaAmbiguousError extends Error {
  constructor(
    public readonly status: number,
    public readonly businessTransactionId: string,
    body: unknown,
  ) {
    super(`Parmana execution outcome is ambiguous (HTTP ${status}) for ${businessTransactionId}: ${safeJson(body)}`);
    this.name = "ParmanaAmbiguousError";
  }
}

export class ParmanaHttpClient {
  private readonly baseUrl: string;

  constructor(private readonly config: ParmanaClientConfig) {
    if (!config.baseUrl.trim()) throw new Error("PARMANA_API_URL is required");
    if (!config.apiKey.trim()) throw new Error("PARMANA_API_KEY is required");
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) {
      throw new Error("Parmana timeoutMs must be a positive integer");
    }
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
  }

  async execute(transaction: BusinessTransaction): Promise<ParmanaExecutionResult> {
    const response = await this.request("/execute", transaction);

    if (response.ok) {
      return parseApprovedResult(response.status, response.body, transaction.businessTransactionId);
    }

    if (response.status === 403 && isRecord(response.body) && response.body["code"] === "POLICY_DENIED") {
      return {
        outcome: "DENIED",
        businessTransactionId: transaction.businessTransactionId,
        reason: typeof response.body["error"] === "string" ? response.body["error"] : "Parmana policy rejected the refund",
      };
    }

    if (response.status === 409 || response.status >= 500) {
      throw new ParmanaAmbiguousError(response.status, transaction.businessTransactionId, response.body);
    }

    throw new Error(`Parmana API HTTP ${response.status}: ${safeJson(response.body)}`);
  }

  private async request(path: string, body: unknown): Promise<{ status: number; ok: boolean; body: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`Parmana returned non-JSON response (HTTP ${response.status})`);
      }
      return { status: response.status, ok: response.ok, body: parsed };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseApprovedResult(status: number, value: unknown, expectedTransactionId: string): ParmanaExecutionResult {
  if (!isRecord(value)) throw new Error(`Parmana returned an invalid execution response (HTTP ${status})`);

  const transaction = value["transaction"];
  if (!isRecord(transaction) || transaction["businessTransactionId"] !== expectedTransactionId) {
    throw new Error("Parmana returned an execution response for a different business transaction");
  }

  const executions = Array.isArray(value["executions"]) ? value["executions"].filter(isRecord) : [];
  const lastExecution = executions.at(-1);
  const decision = lastExecution && isRecord(lastExecution["decision"]) ? lastExecution["decision"] : undefined;
  const outcome = decision ? String(decision["outcome"] ?? "") : "";

  if (outcome !== "APPROVED") {
    throw new Error(`Parmana returned HTTP ${status} with no APPROVED execution decision -- malformed response`);
  }

  const authorizationEnvelope = value["authorization"];
  const payload = isRecord(authorizationEnvelope) ? authorizationEnvelope["payload"] : undefined;
  const executionMetadata = lastExecution && isRecord(lastExecution["metadata"]) ? lastExecution["metadata"] : undefined;

  const authorizationId =
    (isRecord(payload) && typeof payload["authorizationId"] === "string" ? payload["authorizationId"] : undefined) ??
    (executionMetadata && typeof executionMetadata["authorizationId"] === "string" ? executionMetadata["authorizationId"] : undefined);

  if (!authorizationId) throw new Error("Parmana APPROVED response did not contain an authorizationId");

  return { outcome: "APPROVED", businessTransactionId: expectedTransactionId, authorizationId, trustRecord: value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return "<unserializable>"; }
}
