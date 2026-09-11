/**
 * Explicit agent state machine.
 *
 * The AI layer never decides authorization; this machine only tracks
 * where a single refund request is in its lifecycle and refuses any
 * transition that would let a denial be reinterpreted as an approval.
 * DENIED is a terminal state -- there is no transition out of it
 * toward execution, by construction (see TRANSITIONS below: DENIED
 * has no outgoing edges at all).
 */
export type AgentState =
  | "RECEIVED"
  | "UNDERSTANDING"
  | "INTENT_PROPOSED"
  | "AUTHORIZATION_REQUESTED"
  | "AUTHORIZED"
  | "DENIED"
  | "EXECUTING"
  | "EXECUTED"
  | "FAILED"
  | "UNKNOWN"
  | "COMPLETED";

/**
 * The only legal transitions. Any transition not listed here --
 * explicitly including DENIED -> EXECUTING and DENIED -> EXECUTED,
 * the two the spec calls out by name -- is forbidden and throws.
 *
 * FAILED and UNKNOWN are reachable from every non-terminal state
 * (fail-closed on invalid OpenAI output, an unavailable Parmana, a
 * malformed Parmana response, or an ambiguous authorization outcome),
 * modeled explicitly below rather than as an implicit catch-all so the
 * allowed sources stay an auditable, closed list.
 */
const TRANSITIONS: Readonly<Record<AgentState, readonly AgentState[]>> = Object.freeze({
  RECEIVED: ["UNDERSTANDING", "FAILED"],
  UNDERSTANDING: ["INTENT_PROPOSED", "FAILED"],
  INTENT_PROPOSED: ["AUTHORIZATION_REQUESTED", "FAILED"],
  AUTHORIZATION_REQUESTED: ["AUTHORIZED", "DENIED", "UNKNOWN", "FAILED"],
  AUTHORIZED: ["EXECUTING", "FAILED"],
  EXECUTING: ["EXECUTED", "FAILED", "UNKNOWN"],
  EXECUTED: ["COMPLETED"],
  DENIED: [],
  FAILED: [],
  UNKNOWN: [],
  COMPLETED: [],
});

export class IllegalStateTransitionError extends Error {
  constructor(
    public readonly from: AgentState,
    public readonly to: AgentState,
  ) {
    super(`Illegal agent state transition: ${from} -> ${to}`);
    this.name = "IllegalStateTransitionError";
  }
}

export class AgentStateMachine {
  private current: AgentState = "RECEIVED";

  get state(): AgentState {
    return this.current;
  }

  /** Throws IllegalStateTransitionError rather than silently allowing an unmodeled transition. */
  transition(to: AgentState): AgentState {
    const allowed = TRANSITIONS[this.current];
    if (!allowed.includes(to)) {
      throw new IllegalStateTransitionError(this.current, to);
    }
    this.current = to;
    return this.current;
  }

  isTerminal(): boolean {
    return TRANSITIONS[this.current].length === 0;
  }
}
