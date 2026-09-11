import { describe, expect, it } from "vitest";
import { OpenAiRefundIntentInterpreter } from "../../src/openai/client.js";
import { validateRefundIntent } from "../../src/intent/refund-intent.js";

/**
 * Exercises OpenAiRefundIntentInterpreter against a fake OpenAI SDK
 * client (dependency-injected, no network call, no API key needed) --
 * this agent has no real OPENAI_API_KEY configured in this
 * environment, so the actual OpenAI call itself is not exercised
 * here. See docs/DEMO.md for the live-run instructions once a real
 * key is available.
 */
function fakeOpenAiClient(content: string | undefined) {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content } }],
        }),
      },
    },
  } as unknown as import("openai").default;
}

const VALID_CANDIDATE = {
  action: "paytm:refund",
  orderId: "ORD-123",
  txnId: "TXN-123",
  amount: 500,
  currency: "INR",
  reason: "Item arrived damaged",
};

describe("OpenAiRefundIntentInterpreter", () => {
  it("parses well-formed structured JSON content into a candidate that validates", async () => {
    const interpreter = new OpenAiRefundIntentInterpreter(fakeOpenAiClient(JSON.stringify(VALID_CANDIDATE)), "gpt-test");
    const candidate = await interpreter.interpret("Refund order ORD-123, txn TXN-123, amount 500 INR, damaged item.");
    expect(validateRefundIntent(candidate)).toEqual(VALID_CANDIDATE);
  });

  it("fails closed when the model returns no content", async () => {
    const interpreter = new OpenAiRefundIntentInterpreter(fakeOpenAiClient(undefined), "gpt-test");
    await expect(interpreter.interpret("refund please")).rejects.toThrow(/no structured content/);
  });

  it("fails closed when the model returns non-JSON content", async () => {
    const interpreter = new OpenAiRefundIntentInterpreter(fakeOpenAiClient("I refunded it for you!"), "gpt-test");
    await expect(interpreter.interpret("refund please")).rejects.toThrow(/not valid JSON/);
  });

  it("includes caller-supplied hints in the prompt sent to the model", async () => {
    let capturedMessages: unknown;
    const client = {
      chat: {
        completions: {
          create: async (args: { messages: unknown }) => {
            capturedMessages = args.messages;
            return { choices: [{ message: { content: JSON.stringify(VALID_CANDIDATE) } }] };
          },
        },
      },
    } as unknown as import("openai").default;

    const interpreter = new OpenAiRefundIntentInterpreter(client, "gpt-test");
    await interpreter.interpret("please refund my order", { orderId: "ORD-123", amount: 500 });

    const serialized = JSON.stringify(capturedMessages);
    expect(serialized).toContain("ORD-123");
  });
});
