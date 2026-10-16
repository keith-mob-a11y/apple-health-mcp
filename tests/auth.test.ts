import { describe, it, expect, beforeEach } from "vitest";
import { secretOk } from "@/lib/auth";

beforeEach(() => {
  process.env.MCP_SECRET = "s3cr3t";
});

function req(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { headers });
}

describe("secretOk", () => {
  it("accepts a correct Authorization: Bearer header", () => {
    expect(secretOk(req("https://x/api/mcp", { authorization: "Bearer s3cr3t" }))).toBe(true);
  });
  it("rejects the secret in a ?key query param (URLs get logged)", () => {
    expect(secretOk(req("https://x/api/mcp?key=s3cr3t"))).toBe(false);
  });
  it("rejects a wrong secret", () => {
    expect(secretOk(req("https://x/api/mcp", { authorization: "Bearer nope" }))).toBe(false);
  });
  it("rejects a missing secret", () => {
    expect(secretOk(req("https://x/api/mcp"))).toBe(false);
  });
});
