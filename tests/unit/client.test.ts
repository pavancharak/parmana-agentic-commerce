import { afterEach, describe, expect, it, vi } from "vitest";
import { ParmanaAmbiguousError, ParmanaHttpClient, type BusinessTransaction } from "../../src/parmana/client.js";

function transaction(businessTransactionId: string): BusinessTransaction {
  return {
    businessTransactionId,
    metadata: {},
    authority: {},
    authorization: {},
    intent: { action: "paytm:refund", target: "order-1", parameters: {} },
    policy: { name: "customer-refund", version: "1.0.0", schemaVersion: "1.0.0" },
    signals: {},
    status: "RECEIVED",
    createdAt: new Date().toISOString(),
  };
}

function client(): ParmanaHttpClient {
  return new ParmanaHttpClient({ baseUrl: "https://parmana.example.com", apiKey: "test-key", timeoutMs: 2000 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ParmanaHttpClient.execute -- verified against the real deployed API's response shapes", () => {
  it("parses a real APPROVED trust-record response", async () => {
    const businessTransactionId = "31ac3c17-d0ea-458c-9cc3-e843e1722f9a";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          trustRecordId: "118e30c0-321e-4d12-8f10-2d9f1f39aed1",
          businessTransactionId,
          transaction: { businessTransactionId },
          executions: [{ decision: { outcome: "APPROVED" }, metadata: { authorizationId: "305631e6-3706-4368-844f-e8a3af1f273b" } }],
          authorization: { payload: { authorizationId: "305631e6-3706-4368-844f-e8a3af1f273b" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await client().execute(transaction(businessTransactionId));

    expect(result.outcome).toBe("APPROVED");
    if (result.outcome !== "APPROVED") throw new Error("unreachable");
    expect(result.authorizationId).toBe("305631e6-3706-4368-844f-e8a3af1f273b");
  });

  it("parses a real DENIED response (HTTP 403, POLICY_DENIED) as a clean result, never a thrown error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Execution rejected: amount exceeds threshold.", code: "POLICY_DENIED" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await client().execute(transaction("denied-1"));

    expect(result.outcome).toBe("DENIED");
    if (result.outcome !== "DENIED") throw new Error("unreachable");
    expect(result.reason).toContain("exceeds threshold");
  });

  it("treats 5xx and 409 as ambiguous, never as success or denial", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "content-type": "application/json" } }),
    );
    await expect(client().execute(transaction("amb-1"))).rejects.toBeInstanceOf(ParmanaAmbiguousError);
  });

  it("fails closed on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: { "content-type": "application/json" } }),
    );
    await expect(client().execute(transaction("auth-1"))).rejects.toThrow(/HTTP 401/);
  });

  it("fails closed on a 200 with no APPROVED execution decision", async () => {
    const businessTransactionId = "malformed-1";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ businessTransactionId, transaction: { businessTransactionId }, executions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(client().execute(transaction(businessTransactionId))).rejects.toThrow(/malformed response/);
  });
});
