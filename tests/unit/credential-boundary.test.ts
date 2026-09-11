import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 9. AI agent cannot access Paytm credentials.
 *
 * Structural, not just conventional: this agent must never reference
 * PAYTM_MERCHANT_ID, PAYTM_MERCHANT_KEY, or PAYTM_CONNECTOR_SHARED_SECRET
 * anywhere in its own source. Those belong exclusively to the Paytm
 * connector service (pavancharak/parmana-paytm-agent) -- this repo
 * never imports it, never reads its environment variables, and never
 * makes an HTTP call to a URL path resembling /connector/paytm-refund.
 */

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const srcDir = join(repoRoot, "src");

const FORBIDDEN_PATTERNS = [
  /PAYTM_MERCHANT_ID/,
  /PAYTM_MERCHANT_KEY/,
  /PAYTM_CONNECTOR_SHARED_SECRET/,
  /\/connector\/paytm-refund/,
];

function listTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

/** Strips comments so prose explaining what this agent must NOT do (which necessarily names the forbidden thing) doesn't false-positive as the agent doing it. */
function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("credential boundary: this agent never touches Paytm merchant credentials or the connector endpoint", () => {
  const files = listTsFiles(srcDir);

  it("found source files to scan (sanity check the scan isn't vacuous)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(FORBIDDEN_PATTERNS.map((pattern) => pattern.source))("no file in src/ matches forbidden pattern %s (outside comments)", (patternSource) => {
    const pattern = new RegExp(patternSource);
    const violations = files.filter((file) => pattern.test(stripComments(readFileSync(file, "utf8"))));
    expect(violations).toEqual([]);
  });

  it("this agent's own env schema (handler.ts's loadConfig) never reads a Paytm variable", () => {
    const handlerContent = readFileSync(join(srcDir, "server", "handler.ts"), "utf8");
    expect(handlerContent).not.toMatch(/PAYTM/);
  });
});
