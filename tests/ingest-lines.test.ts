import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/db";
import { handleLines } from "@/app/api/ingest/lines/route";
import { parseLines } from "@/lib/ingest-lines";
import { metricSamples, workouts } from "@/db/schema";

beforeEach(() => { process.env.MCP_SECRET = "s3cr3t"; });

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("https://x/api/ingest/lines", { method: "POST", headers: { "content-type": "text/plain", ...headers }, body });
const auth = { authorization: "Bearer s3cr3t" };

describe("parseLines", () => {
  it("maps short names to the stored metric names", () => {
    const r = parseLines("steps|2026-10-18|8421\nprotein|2026-10-18|120.5|g");
    expect(r.metricRows.map((m) => m.metricName)).toEqual(["step_count", "protein"]);
    expect(r.metricRows[0]).toMatchObject({ qty: "8421", source: "shortcuts" });
  });

  it("converts pounds to kilograms", () => {
    const r = parseLines("weight|2026-10-18|180|lb");
    expect(r.metricRows[0].units).toBe("kg");
    expect(Number(r.metricRows[0].qty)).toBeCloseTo(81.647, 2);
  });

  it("skips bad lines and counts them", () => {
    const r = parseLines("steps|18-10-2026|5\nnonsense|2026-10-18|5\nsteps|2026-10-18|abc\n\nsteps|2026-10-18|5");
    expect(r.metricRows).toHaveLength(1);
    expect(r.skipped).toBe(3);
  });

  it("drops a zero weight, energy or protein but keeps a zero step count", () => {
    const r = parseLines("weight|2026-10-18|0|kg\nenergy|2026-10-18|0\nprotein|2026-10-18|0\nsteps|2026-10-18|0");
    expect(r.metricRows.map((m) => m.metricName)).toEqual(["step_count"]);
    expect(r.skipped).toBe(3);
  });

  it("keeps the last value when a metric and day repeat", () => {
    const r = parseLines("steps|2026-10-18|100\nsteps|2026-10-18|900");
    expect(r.metricRows).toHaveLength(1);
    expect(r.metricRows[0].qty).toBe("900");
  });

  it("stores sleep hours where the summary tool reads them", () => {
    expect(parseLines("sleep|2026-10-18|7.25").metricRows[0].extra).toEqual({ totalSleep: 7.25 });
  });

  it("parses a workout line", () => {
    const r = parseLines("workout|2026-10-18T07:30:00+01:00|Running|45|2026-10-18T08:15:00+01:00|148");
    expect(r.workoutRows[0]).toMatchObject({ name: "Running", durationS: "2700", avgHr: "148" });
  });
});

describe("handleLines", () => {
  it("401s without the secret and does not open the db", async () => {
    let resolved = false;
    const res = await handleLines(post("steps|2026-10-18|1"), () => { resolved = true; return null as any; });
    expect(res.status).toBe(401);
    expect(resolved).toBe(false);
  });

  it("400s when nothing is usable", async () => {
    const db = await makeTestDb();
    const res = await handleLines(post("rubbish", auth), () => db);
    expect(res.status).toBe(400);
  });

  it("replaces a day's total when it is re-sent", async () => {
    const db = await makeTestDb();
    await handleLines(post("steps|2026-10-18|3000", auth), () => db);
    const res = await handleLines(post("steps|2026-10-18|8421\nworkout|2026-10-18T07:30:00+01:00|Run|30", auth), () => db);
    expect(res.status).toBe(200);
    const rows = await db.select().from(metricSamples);
    expect(rows).toHaveLength(1);
    expect(rows[0].qty).toBe("8421");
    expect(await db.select().from(workouts)).toHaveLength(1);
  });
});
