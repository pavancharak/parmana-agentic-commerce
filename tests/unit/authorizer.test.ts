import { describe, expect, it, vi } from "vitest";
import { deterministicBusinessTransactionId, ParmanaRefundAuthorizer } from "../../src/parmana/authorizer.js";
import { ParmanaHttpClient } from "../../src/parmana/client.js";
import type { RefundIntent } from "../../src/intent/refund-intent.js";

const SIGNALS = { refundEligible: true, managerApproved: true, fraudCheckPassed: true };

function intent(overrides: Partial<RefundIntent> = {}): RefundIntent {
  return { action: "paytm:refund", orderId: "ORD-1", txnId: "TXN-1", amount: 500, currency: "INR", reason: "damaged", ...overrides };
}

describe("deterministicBusinessTransactionId -- 10. duplicate refund semantics", () => {
  it("is deterministic for the same (orderId, txnId) pair", () => {
    expect(deterministicBusinessTransactionId("ORD-1", "TXN-1")).toBe(deterministicBusinessTransactionId("ORD-1", "TXN-1"));
  });

  it("never depends on wall-clock time or randomness (repeated calls in the same process agree)", () => {
    const first = deterministicBusinessTransactionId("ORD-9", "TXN-9");
    const second = deterministicBusinessTransactionId("ORD-9", "TXN-9");
    expect(first).toBe(second);
  });

  it("differs for a different orderId or txnId", () => {
    const base = deterministicBusinessTransactionId("ORD-1", "TXN-1");
    expect(deterministicBusinessTransactionId("ORD-2", "TXN-1")).not.toBe(base);
    expect(deterministicBusinessTransactionId("ORD-1", "TXN-2")).not.toBe(base);
  });

  it("produces a valid version-4 UUID shape (the businessTransactionId format Parmana expects)", () => {
    const id = deterministicBusinessTransactionId("ORD-1", "TXN-1");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

describe("ParmanaRefundAuthorizer -- submits exactly the real capability's allowed parameters", () => {
  it("sends {orderId, transactionId, amount} -- no refId, no txnId key -- and the same businessTransactionId for a retried request", async () => {
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const parsedBody = JSON.parse(String(init?.body)) as { businessTransactionId: string };
      return new Response(
        JSON.stringify({
          businessTransactionId: parsedBody.businessTransactionId,
          transaction: { businessTransactionId: parsedBody.businessTransactionId },
          executions: [{ decision: { outcome: "APPROVED" }, metadata: { authorizationId: "auth-x" } }],
          authorization: { payload: { authorizationId: "auth-x" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const client = new ParmanaHttpClient({ baseUrl: "https://parmana.example.com", apiKey: "test-key", timeoutMs: 2000 });
    const authorizer = new ParmanaRefundAuthorizer(client, "openai-refund-agent");

    await authorizer.authorize(intent(), SIGNALS);
    await authorizer.authorize(intent(), SIGNALS);

    expect(bodies).toHaveLength(2);
    const first = bodies[0] as { intent: { parameters: Record<string, unknown> }; businessTransactionId: string };
    const second = bodies[1] as { intent: { parameters: Record<string, unknown> }; businessTransactionId: string };

    expect(Object.keys(first.intent.parameters).sort()).toEqual(["amount", "orderId", "transactionId"]);
    expect(first.intent.parameters["transactionId"]).toBe("TXN-1");
    // Same logical refund -> same businessTransactionId across both calls.
    expect(first.businessTransactionId).toBe(second.businessTransactionId);

    vi.restoreAllMocks();
  });

  it("binds the signals' refundAmount to the same validated amount that will execute -- never a second, independent value", async () => {
    let capturedSignals: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { businessTransactionId: string; signals: Record<string, unknown> };
      capturedSignals = body.signals;
      return new Response(
        JSON.stringify({
          businessTransactionId: body.businessTransactionId,
          transaction: { businessTransactionId: body.businessTransactionId },
          executions: [{ decision: { outcome: "APPROVED" }, metadata: { authorizationId: "auth-y" } }],
          authorization: { payload: { authorizationId: "auth-y" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const client = new ParmanaHttpClient({ baseUrl: "https://parmana.example.com", apiKey: "test-key", timeoutMs: 2000 });
    const authorizer = new ParmanaRefundAuthorizer(client, "openai-refund-agent");

    await authorizer.authorize(intent({ amount: 750 }), SIGNALS);

    expect(capturedSignals?.["refundAmount"]).toBe(750);

    vi.restoreAllMocks();
  });
});
