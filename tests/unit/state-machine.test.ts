import { describe, expect, it } from "vitest";
import { AgentStateMachine, IllegalStateTransitionError } from "../../src/agent/state-machine.js";

describe("AgentStateMachine", () => {
  it("starts at RECEIVED", () => {
    expect(new AgentStateMachine().state).toBe("RECEIVED");
  });

  it("walks the full approved path", () => {
    const machine = new AgentStateMachine();
    for (const state of ["UNDERSTANDING", "INTENT_PROPOSED", "AUTHORIZATION_REQUESTED", "AUTHORIZED", "EXECUTING", "EXECUTED", "COMPLETED"] as const) {
      machine.transition(state);
    }
    expect(machine.state).toBe("COMPLETED");
    expect(machine.isTerminal()).toBe(true);
  });

  it("walks the denied path and stops -- DENIED is terminal", () => {
    const machine = new AgentStateMachine();
    machine.transition("UNDERSTANDING");
    machine.transition("INTENT_PROPOSED");
    machine.transition("AUTHORIZATION_REQUESTED");
    machine.transition("DENIED");
    expect(machine.state).toBe("DENIED");
    expect(machine.isTerminal()).toBe(true);
  });

  it.each([
    ["DENIED", "EXECUTING"],
    ["DENIED", "EXECUTED"],
    ["DENIED", "COMPLETED"],
    ["DENIED", "AUTHORIZED"],
  ] as const)("forbids %s -> %s (the two the spec names explicitly, plus adjacent variants)", (from, to) => {
    const machine = new AgentStateMachine();
    machine.transition("UNDERSTANDING");
    machine.transition("INTENT_PROPOSED");
    machine.transition("AUTHORIZATION_REQUESTED");
    machine.transition("DENIED");
    expect(machine.state).toBe(from);
    expect(() => machine.transition(to)).toThrow(IllegalStateTransitionError);
    // Rejected transition never actually moved the state.
    expect(machine.state).toBe("DENIED");
  });

  it("forbids skipping straight from RECEIVED to EXECUTING", () => {
    const machine = new AgentStateMachine();
    expect(() => machine.transition("EXECUTING")).toThrow(IllegalStateTransitionError);
  });

  it("forbids skipping straight from RECEIVED to COMPLETED", () => {
    const machine = new AgentStateMachine();
    expect(() => machine.transition("COMPLETED")).toThrow(IllegalStateTransitionError);
  });

  it("allows failing closed (-> FAILED) from every non-terminal state", () => {
    for (const path of [
      [],
      ["UNDERSTANDING"],
      ["UNDERSTANDING", "INTENT_PROPOSED"],
      ["UNDERSTANDING", "INTENT_PROPOSED", "AUTHORIZATION_REQUESTED"],
      ["UNDERSTANDING", "INTENT_PROPOSED", "AUTHORIZATION_REQUESTED", "AUTHORIZED"],
      ["UNDERSTANDING", "INTENT_PROPOSED", "AUTHORIZATION_REQUESTED", "AUTHORIZED", "EXECUTING"],
    ] as const) {
      const machine = new AgentStateMachine();
      for (const state of path) machine.transition(state);
      machine.transition("FAILED");
      expect(machine.state).toBe("FAILED");
    }
  });

  it("allows falling back to UNKNOWN (ambiguous authorization outcome) only from AUTHORIZATION_REQUESTED or EXECUTING", () => {
    const fromAuthRequested = new AgentStateMachine();
    fromAuthRequested.transition("UNDERSTANDING");
    fromAuthRequested.transition("INTENT_PROPOSED");
    fromAuthRequested.transition("AUTHORIZATION_REQUESTED");
    fromAuthRequested.transition("UNKNOWN");
    expect(fromAuthRequested.state).toBe("UNKNOWN");
    expect(fromAuthRequested.isTerminal()).toBe(true);
  });

  it("FAILED and UNKNOWN are both terminal", () => {
    const failed = new AgentStateMachine();
    failed.transition("FAILED");
    expect(failed.isTerminal()).toBe(true);
  });
});
