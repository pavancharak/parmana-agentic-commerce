import { describe, expect, it } from "vitest";
import { InvalidRefundIntentError, validateRefundIntent } from "../../src/intent/refund-intent.js";

const valid = {
  action: "paytm:refund",
  orderId: "ORD-123",
  txnId: "TXN-123",
  amount: 500,
  currency: "INR",
  reason: "Item arrived damaged",
};

describe("validateRefundIntent", () => {
  it("accepts a well-formed candidate", () => {
    const intent = validateRefundIntent(valid);
    expect(intent).toEqual(valid);
  });

  it("silently drops any extra/unknown field, never passing it through", () => {
    const intent = validateRefundIntent({ ...valid, __bypassParmana: true, decision: "APPROVED" });
    expect(intent).toEqual(valid);
    expect(Object.keys(intent)).toEqual(["action", "orderId", "txnId", "amount", "currency", "reason"]);
  });

  it.each([
    ["wrong action", { ...valid, action: "paytm:charge" }],
    ["missing action", { ...valid, action: undefined }],
    ["empty orderId", { ...valid, orderId: "" }],
    ["missing orderId", { ...valid, orderId: undefined }],
    ["empty txnId", { ...valid, txnId: "" }],
    ["zero amount", { ...valid, amount: 0 }],
    ["negative amount", { ...valid, amount: -500 }],
    ["non-numeric amount", { ...valid, amount: "500" }],
    ["NaN amount", { ...valid, amount: Number.NaN }],
    ["Infinity amount", { ...valid, amount: Number.POSITIVE_INFINITY }],
    ["wrong currency", { ...valid, currency: "USD" }],
    ["missing currency", { ...valid, currency: undefined }],
    ["empty reason", { ...valid, reason: "" }],
    ["null", null],
    ["array", [valid]],
    ["a string", "not an object"],
  ])("rejects %s", (_label, candidate) => {
    expect(() => validateRefundIntent(candidate)).toThrow(InvalidRefundIntentError);
  });

  it("never lets the model widen currency beyond INR (Paytm/INR-only this milestone)", () => {
    expect(() => validateRefundIntent({ ...valid, currency: "usd" })).toThrow(/currency/);
  });
});
