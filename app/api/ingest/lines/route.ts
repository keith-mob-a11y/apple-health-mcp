import { secretOk } from "@/lib/auth";
import { parseLines } from "@/lib/ingest-lines";
import { persist } from "@/lib/persist";
import { getDb } from "@/lib/db";

export const maxDuration = 60;

type Db = Parameters<typeof persist>[0];

const MAX_BODY_CHARS = 500_000;

// Takes a db factory for the same reason as /api/ingest: nothing touches the database
// until auth and parsing have passed.
export async function handleLines(req: Request, getDbFn: () => Db): Promise<Response> {
  if (!secretOk(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) {
    return Response.json({ error: "body too large" }, { status: 413 });
  }
  const parsed = parseLines(text);
  if (parsed.metricRows.length === 0 && parsed.workoutRows.length === 0) {
    // Counts only. The lines are health values and stay out of logs and responses.
    console.warn("[ingest-lines] nothing usable, skipped:", parsed.skipped);
    return Response.json({ error: "no valid lines", skipped: parsed.skipped }, { status: 400 });
  }
  try {
    const summary = await persist(getDbFn(), parsed, { metricConflict: "update" });
    return Response.json({ ...summary, skipped: parsed.skipped }, { status: 200 });
  } catch (err) {
    console.error("[ingest-lines] persist error");
    const message = err instanceof Error ? err.message : "persist failed";
    return Response.json({ error: "ingest failed", detail: message }, { status: 500 });
  }
}

export function POST(req: Request) {
  return handleLines(req, getDb);
}
