import type { IncomingMessage, ServerResponse } from "node:http";
import { createOpenAiClient, OpenAiRefundIntentInterpreter } from "../openai/client.js";
import { ParmanaHttpClient } from "../parmana/client.js";
import { ParmanaRefundAuthorizer } from "../parmana/authorizer.js";
import { RefundAgent, type RefundAgentRequest } from "../agent/refund-agent.js";

export const config = loadConfig();

const openai = createOpenAiClient(config.openaiApiKey);
const interpreter = new OpenAiRefundIntentInterpreter(openai, config.openaiModel);
const parmanaClient = new ParmanaHttpClient({ baseUrl: config.parmanaUrl, apiKey: config.parmanaApiKey, timeoutMs: config.timeoutMs });
const authorizer = new ParmanaRefundAuthorizer(parmanaClient, config.parmanaPrincipalId);
const agent = new RefundAgent(interpreter, authorizer);

export async function requestHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    if (request.method === "GET" && request.url === "/health") {
      return sendJson(response, 200, { status: "ok", service: "parmana-openai-refund-agent" });
    }

    if (request.method === "POST" && request.url === "/agent/refund") {
      if (config.agentApiKey !== undefined && !authorized(request.headers.authorization, config.agentApiKey)) {
        return sendJson(response, 401, { error: "unauthorized" });
      }

      const body = await readJson(request);
      const input = parseRequest(body);
      if (input === undefined) {
        return sendJson(response, 400, { error: "request must include a non-empty \"message\" and a \"signals\" object" });
      }

      const result = await agent.handleRequest(input);

      const httpStatus =
        result.status === "APPROVED" ? 200 :
        result.status === "DENIED" ? 403 :
        result.status === "UNKNOWN" ? 409 :
        422;

      return sendJson(response, httpStatus, result);
    }

    return sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    return sendJson(response, 500, { error: error instanceof Error ? error.message : "request failed" });
  }
}

function loadConfig() {
  const required = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const port = Number(process.env.PORT ?? "3001");
  const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS ?? "10000");
  if (!Number.isInteger(port) || port <= 0) throw new Error("PORT must be a positive integer");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("REQUEST_TIMEOUT_MS must be a positive integer");

  return {
    port,
    timeoutMs,
    openaiApiKey: required("OPENAI_API_KEY"),
    openaiModel: required("OPENAI_MODEL"),
    parmanaUrl: required("PARMANA_API_URL"),
    parmanaApiKey: required("PARMANA_API_KEY"),
    parmanaPrincipalId: required("PARMANA_PRINCIPAL_ID"),
    // Optional inbound auth for this agent's own POST /agent/refund
    // endpoint. Not part of the spec's minimal .env, deliberately kept
    // optional rather than required, so that exact .env still works --
    // but every real deployment should set it: this endpoint spends
    // real OpenAI credits and forwards to Parmana on every call.
    agentApiKey: process.env.AGENT_API_KEY?.trim() || undefined,
  } as const;
}

function parseRequest(body: Record<string, unknown>): RefundAgentRequest | undefined {
  const message = body["message"];
  if (typeof message !== "string" || message.trim().length === 0) return undefined;

  const signalsRaw = body["signals"];
  if (typeof signalsRaw !== "object" || signalsRaw === null || Array.isArray(signalsRaw)) return undefined;
  const signals = signalsRaw as Record<string, unknown>;
  if (
    typeof signals["refundEligible"] !== "boolean" ||
    typeof signals["managerApproved"] !== "boolean" ||
    typeof signals["fraudCheckPassed"] !== "boolean"
  ) {
    return undefined;
  }

  const orderId = typeof body["orderId"] === "string" ? body["orderId"] : undefined;
  const txnId = typeof body["txnId"] === "string" ? body["txnId"] : undefined;
  const amount = typeof body["amount"] === "number" ? body["amount"] : undefined;
  const currency = typeof body["currency"] === "string" ? body["currency"] : undefined;

  return {
    message,
    ...(orderId !== undefined ? { orderId } : {}),
    ...(txnId !== undefined ? { txnId } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(currency !== undefined ? { currency } : {}),
    signals: {
      refundEligible: signals["refundEligible"] as boolean,
      managerApproved: signals["managerApproved"] as boolean,
      fraudCheckPassed: signals["fraudCheckPassed"] as boolean,
    },
  };
}

function authorized(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice(7) === expected;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON body must be an object");
  return parsed as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
