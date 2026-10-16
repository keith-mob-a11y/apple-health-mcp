import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { isAuthorized } from "@/lib/auth";
import { baseUrl } from "@/lib/oauth";
import { getDb } from "@/lib/db";
import { listMetrics } from "@/lib/tools/list-metrics";
import { queryMetric } from "@/lib/tools/query-metric";
import { listWorkouts } from "@/lib/tools/list-workouts";
import { queryEvents } from "@/lib/tools/query-events";
import { latestSnapshot } from "@/lib/tools/latest-snapshot";
import { dailySummary, weightTrend, nutritionSummary, workoutSummary } from "@/lib/tools/summaries";

export const maxDuration = 60;

// Wrap each tool's JSON result in the MCP text-content envelope.
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true });

const range = { start: z.string().describe("First day, YYYY-MM-DD (local time)"), end: z.string().describe("Last day inclusive, YYYY-MM-DD (local time)") };

// Summary tools: compact day-level aggregates, the ones to reach for first. They
// return an Error text on bad input rather than throwing through the transport.
async function run(fn: () => Promise<unknown>) {
  try { return ok(await fn()); }
  catch (e) { return fail(e instanceof Error ? e.message : "query failed"); }
}

const handler = createMcpHandler((server) => {
  server.registerTool("daily_summary",
    { title: "Daily summary", description: "Per local day: weight, dietary energy, protein, steps, active energy, sleep hours and workouts. Max 31 days. Prefer this for weekly reviews.",
      inputSchema: range },
    async (a) => run(() => dailySummary(getDb(), a)));

  server.registerTool("weight_trend",
    { title: "Weight trend", description: "Daily weights for the last N days (default 30) with a 7-day rolling average.",
      inputSchema: { days: z.number().int().min(1).max(365).default(30) } },
    async (a) => run(() => weightTrend(getDb(), a)));

  server.registerTool("nutrition_summary",
    { title: "Nutrition summary", description: "Daily dietary energy and protein, the count of days with any food logged, and averages over logged days only. Max 92 days.",
      inputSchema: range },
    async (a) => run(() => nutritionSummary(getDb(), a)));

  server.registerTool("workouts",
    { title: "Workouts", description: "Workouts in a local-day range: type, duration (min), average heart rate, active energy. Max 92 days.",
      inputSchema: range },
    async (a) => run(() => workoutSummary(getDb(), a)));

  server.registerTool("list_metrics",
    { title: "List metrics", description: "List available Apple Health metric types with units, sample counts, and date ranges.", inputSchema: {} },
    async () => ok(await listMetrics(getDb())));

  server.registerTool("query_metric",
    { title: "Query a metric", description: "Query a metric over a date range. aggregation: raw|hourly|daily|avg|sum|min|max.",
      inputSchema: { name: z.string(), start: z.string(), end: z.string(),
        aggregation: z.enum(["raw", "hourly", "daily", "avg", "sum", "min", "max"]).default("daily") } },
    async (a) => ok(await queryMetric(getDb(), a)));

  server.registerTool("list_workouts",
    { title: "List workouts", description: "List workouts in a date range, optionally filtered by type.",
      inputSchema: { start: z.string(), end: z.string(), type: z.string().optional() } },
    async (a) => ok(await listWorkouts(getDb(), a)));

  server.registerTool("query_events",
    { title: "Query health events", description: "Query long-tail data: ecg, stateOfMind, symptoms, medications, cycleTracking, heartRateNotifications.",
      inputSchema: { eventType: z.enum(["ecg", "stateOfMind", "symptoms", "medications", "cycleTracking", "heartRateNotifications"]),
        start: z.string(), end: z.string() } },
    async (a) => ok(await queryEvents(getDb(), a)));

  server.registerTool("latest_snapshot",
    { title: "Latest snapshot", description: "Most recent value for every metric — a quick current-status overview.", inputSchema: {} },
    async () => ok(await latestSnapshot(getDb())));

}, undefined, {
  // basePath MUST match where the [transport] segment is mounted, else the handler
  // 404s every request. Our route lives at app/api/[transport]/route.ts → "/api".
  basePath: "/api",
  maxDuration: 60,
});

// Gate the MCP endpoint. Accept the static secret (Claude Code / ?key) OR a valid
// OAuth access token (claude.ai web/mobile). On rejection, return a 401 with a
// WWW-Authenticate challenge pointing at our protected-resource metadata, which is
// what makes claude.ai start the OAuth flow.
async function authed(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`,
      },
    });
  }
  return handler(req);
}

export { authed as GET, authed as POST };
