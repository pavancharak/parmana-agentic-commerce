import OpenAI from "openai";
import { REFUND_INTENT_JSON_SCHEMA } from "../intent/refund-intent.js";

export interface RefundIntentHints {
  readonly orderId?: string;
  readonly txnId?: string;
  readonly amount?: number;
  readonly currency?: string;
}

/**
 * Interprets a natural-language refund request into an unvalidated
 * structured candidate. Deliberately returns `unknown`, not
 * RefundIntent -- validateRefundIntent (../intent/refund-intent.js)
 * is the only thing allowed to produce a trusted RefundIntent, kept as
 * a separate step so it runs identically whether the candidate came
 * from a real model or a test double (see the interface below).
 */
export interface RefundIntentInterpreter {
  interpret(message: string, hints?: RefundIntentHints): Promise<unknown>;
}

/**
 * The model is told, explicitly, what it may and may not do -- but
 * this instruction is a courtesy, not the security boundary. The
 * actual boundary is structural: interpret() returns unknown, never
 * trusted directly; validateRefundIntent() strictly checks every
 * field and silently drops anything not in RefundIntent's schema; and
 * nothing in this file, or anything that calls it, ever reads
 * free-form model text for a decision. The model cannot "talk its way"
 * past any of that -- there is no code path that would let it.
 */
const SYSTEM_PROMPT = `You are a refund-intake assistant for a commerce platform integrated with Parmana and Paytm.

You may:
- Read a customer's natural-language refund request.
- Propose a structured refund intent (orderId, txnId, amount, currency, reason).
- Request authorization from Parmana for that intent.

You may NOT:
- Authorize a refund yourself. Only Parmana decides APPROVED or DENIED.
- Bypass, reinterpret, or override a Parmana decision.
- Call Paytm directly, or claim a refund happened without Parmana's authorization.
- Invent an orderId, txnId, or amount not present in the request or supplied hints -- if the
  request is missing a required field, do not guess a value for it.

Always respond with a single JSON object matching the required schema exactly. Never include any
other text, explanation, or field.`;

export class OpenAiRefundIntentInterpreter implements RefundIntentInterpreter {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async interpret(message: string, hints?: RefundIntentHints): Promise<unknown> {
    const userContent = buildUserContent(message, hints);

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      response_format: {
        type: "json_schema",
        json_schema: REFUND_INTENT_JSON_SCHEMA,
      },
    });

    const content = response.choices[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("OpenAI returned no structured content");
    }

    try {
      return JSON.parse(content) as unknown;
    } catch {
      throw new Error("OpenAI returned content that is not valid JSON");
    }
  }
}

function buildUserContent(message: string, hints?: RefundIntentHints): string {
  const parts = [`Customer request: ${message}`];
  if (hints && Object.keys(hints).length > 0) {
    parts.push(`Known fields (use these exactly, do not alter them): ${JSON.stringify(hints)}`);
  }
  return parts.join("\n\n");
}

export function createOpenAiClient(apiKey: string): OpenAI {
  if (!apiKey.trim()) throw new Error("OPENAI_API_KEY is required");
  return new OpenAI({ apiKey });
}
