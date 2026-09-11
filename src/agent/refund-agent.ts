import { AgentStateMachine, type AgentState } from "./state-machine.js";
import { validateRefundIntent, type RefundIntent } from "../intent/refund-intent.js";
import type { RefundIntentHints, RefundIntentInterpreter } from "../openai/client.js";
import { ParmanaAmbiguousError, type ParmanaExecutionResult } from "../parmana/client.js";
import type { RefundAuthorizationSignals, RefundAuthorizer } from "../parmana/authorizer.js";

export interface RefundAgentRequest {
  readonly message: string;
  readonly orderId?: string;
  readonly txnId?: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly signals: RefundAuthorizationSignals;
}

export interface ApprovedAgentResponse {
  readonly status: "APPROVED";
  readonly executed: true;
  readonly state: AgentState;
  readonly authorization: { readonly authorizationId: string; readonly businessTransactionId: string };
  readonly execution: Record<string, unknown>;
  readonly evidence: Record<string, unknown>;
}

export interface DeniedAgentResponse {
  readonly status: "DENIED";
  readonly executed: false;
  readonly state: AgentState;
  readonly authorization: { readonly businessTransactionId: string; readonly reason: string };
}

export interface FailedAgentResponse {
  readonly status: "FAILED" | "UNKNOWN";
  readonly executed: false;
  readonly state: AgentState;
  readonly error: string;
}

export type AgentResponse = ApprovedAgentResponse | DeniedAgentResponse | FailedAgentResponse;

/**
 * Orchestrates exactly the flow the spec requires and nothing else:
 *
 *   RECEIVED -> UNDERSTANDING -> (OpenAI) -> INTENT_PROPOSED
 *     -> AUTHORIZATION_REQUESTED -> (Parmana /execute)
 *       -> DENIED -> STOP
 *       -> AUTHORIZED -> EXECUTING -> EXECUTED -> COMPLETED
 *
 * "EXECUTING"/"EXECUTED" are NOT a second network call this class
 * makes -- Parmana's own /execute already dispatched to the real
 * execution gateway and connector synchronously, inside the same HTTP
 * response, before this class ever sees the result (verified live:
 * a single POST /execute call returns the full signed Execution Trust
 * Record, including the connector's own evidence). Those two states
 * exist to make that already-completed work visible in this agent's
 * own state trace, not to trigger it.
 *
 * This class never calls /connector/paytm-refund, never imports
 * anything that could, and never holds a Paytm credential of any
 * kind -- see docs/SECURITY.md and tests/unit/credential-boundary.test.ts.
 */
export class RefundAgent {
  constructor(
    private readonly interpreter: RefundIntentInterpreter,
    private readonly authorizer: RefundAuthorizer,
  ) {}

  async handleRequest(request: RefundAgentRequest): Promise<AgentResponse> {
    const machine = new AgentStateMachine();
    machine.transition("UNDERSTANDING");

    const hints: RefundIntentHints = {
      ...(request.orderId !== undefined ? { orderId: request.orderId } : {}),
      ...(request.txnId !== undefined ? { txnId: request.txnId } : {}),
      ...(request.amount !== undefined ? { amount: request.amount } : {}),
      ...(request.currency !== undefined ? { currency: request.currency } : {}),
    };

    let candidate: unknown;
    try {
      candidate = await this.interpreter.interpret(request.message, hints);
    } catch (error) {
      machine.transition("FAILED");
      return { status: "FAILED", executed: false, state: machine.state, error: `OpenAI interpretation failed: ${errorMessage(error)}` };
    }

    let intent: RefundIntent;
    try {
      intent = validateRefundIntent(candidate);
      // Caller-supplied fields, when present, are authoritative over
      // whatever the model proposed -- this is what stops "change the
      // amount until Parmana approves it": the model can propose, but
      // it cannot override a value the caller (a real system, not the
      // model) explicitly supplied. Re-validated after merging so an
      // override can never produce something validateRefundIntent
      // would have rejected on its own (e.g. a non-positive amount).
      intent = validateRefundIntent({
        ...intent,
        ...(request.orderId !== undefined ? { orderId: request.orderId } : {}),
        ...(request.txnId !== undefined ? { txnId: request.txnId } : {}),
        ...(request.amount !== undefined ? { amount: request.amount } : {}),
        ...(request.currency !== undefined ? { currency: request.currency } : {}),
      });
    } catch (error) {
      machine.transition("FAILED");
      return { status: "FAILED", executed: false, state: machine.state, error: `Invalid structured refund intent: ${errorMessage(error)}` };
    }
    machine.transition("INTENT_PROPOSED");

    machine.transition("AUTHORIZATION_REQUESTED");
    let result: ParmanaExecutionResult;
    try {
      result = await this.authorizer.authorize(intent, request.signals);
    } catch (error) {
      if (error instanceof ParmanaAmbiguousError) {
        machine.transition("UNKNOWN");
        return { status: "UNKNOWN", executed: false, state: machine.state, error: errorMessage(error) };
      }
      machine.transition("FAILED");
      return { status: "FAILED", executed: false, state: machine.state, error: `Parmana unavailable or returned a malformed response: ${errorMessage(error)}` };
    }

    if (result.outcome === "DENIED") {
      machine.transition("DENIED");
      return {
        status: "DENIED",
        executed: false,
        state: machine.state,
        authorization: { businessTransactionId: result.businessTransactionId, reason: result.reason },
      };
    }

    machine.transition("AUTHORIZED");
    machine.transition("EXECUTING");
    machine.transition("EXECUTED");
    machine.transition("COMPLETED");

    const lastExecution = extractLastExecution(result.trustRecord);

    return {
      status: "APPROVED",
      executed: true,
      state: machine.state,
      authorization: { authorizationId: result.authorizationId, businessTransactionId: result.businessTransactionId },
      execution: lastExecution ?? {},
      evidence: isRecord(lastExecution?.["evidence"]) ? (lastExecution["evidence"] as Record<string, unknown>) : {},
    };
  }
}

function extractLastExecution(trustRecord: Record<string, unknown>): Record<string, unknown> | undefined {
  const executions = trustRecord["executions"];
  if (!Array.isArray(executions)) return undefined;
  const last = executions.at(-1);
  return isRecord(last) ? last : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
