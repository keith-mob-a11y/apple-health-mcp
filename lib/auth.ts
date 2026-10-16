import crypto from "node:crypto";
import { requireEnv } from "@/lib/env";
import { validateAccessToken } from "@/lib/oauth";

// Constant-time string comparison. Hashing first gives equal-length buffers, so
// neither the length nor the content of the secret leaks through timing.
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Static-secret check (Health Auto Export ingest + Claude Code): the shared secret
// as `Authorization: Bearer <secret>`. A `?key=` query param is deliberately NOT
// accepted: URLs end up in request logs, headers do not.
export function secretOk(req: Request): boolean {
  const auth = req.headers.get("authorization");
  return !!auth?.startsWith("Bearer ") && safeEqual(auth.slice(7), requireEnv("MCP_SECRET"));
}

// MCP endpoint authorization: accept EITHER the static secret (Claude Code)
// OR a valid OAuth access token (claude.ai web/mobile, which require OAuth).
export function isAuthorized(req: Request): boolean {
  if (secretOk(req)) return true;
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return validateAccessToken(auth.slice(7));
  return false;
}
