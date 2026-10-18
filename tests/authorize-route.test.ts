import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "@/app/api/oauth/authorize/route";

beforeEach(() => { process.env.MCP_SECRET = "s3cr3t"; });

function submit(secret: string) {
  const body = new URLSearchParams({
    secret,
    client_id: "c",
    redirect_uri: "https://claude.ai/cb",
    state: "st",
    code_challenge: "abc",
    code_challenge_method: "S256",
  });
  return POST(new Request("https://x/api/oauth/authorize", { method: "POST", body }));
}

describe("authorize POST", () => {
  it("redirects with a code when the secret is right", async () => {
    const res = await submit("s3cr3t");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("code=");
  });

  it("ignores a trailing space or newline on the secret", async () => {
    expect((await submit("s3cr3t ")).status).toBe(302);
    expect((await submit("  s3cr3t\n")).status).toBe(302);
  });

  it("still rejects a wrong secret", async () => {
    expect((await submit("nope")).status).toBe(401);
    expect((await submit("s3cr3tx")).status).toBe(401);
  });
});
