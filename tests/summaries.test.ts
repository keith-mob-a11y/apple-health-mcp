import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/db";
import { normalize } from "@/lib/ingest";
import { persist } from "@/lib/persist";
import { dailySummary, nutritionSummary, workoutSummary, weightTrend, addDays, today, tz } from "@/lib/tools/summaries";

beforeEach(() => { process.env.HEALTH_TZ = "Europe/London"; });

const empty = { ecg: [], stateOfMind: [], symptoms: [], medications: [], cycleTracking: [], heartRateNotifications: [] };

async function seeded() {
  const db = await makeTestDb();
  await persist(db, normalize({ data: {
    metrics: [
      { name: "weight_body_mass", units: "kg", data: [
        { date: "2026-06-01 07:00:00 +0100", qty: 80 },
        { date: "2026-06-02 07:00:00 +0100", qty: 79 },
      ] },
      { name: "protein", units: "g", data: [
        // 23:30 UTC on 1 June is 00:30 BST on 2 June: must land on the 2nd.
        { date: "2026-06-01 23:30:00 +0000", qty: 40 },
        { date: "2026-06-02 12:00:00 +0100", qty: 60 },
        { date: "2026-06-01 12:00:00 +0100", qty: 100 },
      ] },
      { name: "dietary_energy", units: "kcal", data: [{ date: "2026-06-01 12:00:00 +0100", qty: 2000 }] },
      { name: "step_count", units: "count", data: [
        { date: "2026-06-01 10:00:00 +0100", qty: 3000 }, { date: "2026-06-01 15:00:00 +0100", qty: 4000 },
      ] },
      { name: "sleep_analysis", units: "hr", data: [{ date: "2026-06-02 06:30:00 +0100", asleep: 7.25, inBed: 8 }] },
    ],
    workouts: [{ id: "w1", name: "Running", start: "2026-06-01 08:00:00 +0100", end: "2026-06-01 08:30:00 +0100", duration: 1800, avgHeartRate: { qty: 150, units: "bpm" } }],
    ...empty,
  } }));
  return db;
}

describe("summary tools", () => {
  it("daily_summary buckets by local day and aggregates", async () => {
    const r = await dailySummary(await seeded(), { start: "2026-06-01", end: "2026-06-02" });
    const [d1, d2] = r.days;
    expect(d1).toMatchObject({ date: "2026-06-01", weight: 80, energy: 2000, protein: 100, steps: 7000 });
    expect(d1.workouts).toEqual([{ type: "Running", min: 30 }]);
    expect(d2).toMatchObject({ date: "2026-06-02", weight: 79, protein: 100, sleepHours: 7.3, energy: null });
    expect(r.units.weight).toBe("kg");
  });

  it("nutrition_summary averages over logged days only", async () => {
    const r = await nutritionSummary(await seeded(), { start: "2026-06-01", end: "2026-06-05" });
    expect(r.daysInRange).toBe(5);
    expect(r.daysWithFoodLogged).toBe(2);
    expect(r.avgProteinPerLoggedDay).toBe(100);
    expect(r.avgEnergyPerLoggedDay).toBe(2000);
  });

  it("workouts returns type, minutes and heart rate", async () => {
    const r = await workoutSummary(await seeded(), { start: "2026-06-01", end: "2026-06-01" });
    expect(r.workouts).toEqual([expect.objectContaining({ type: "Running", durationMin: 30, avgHr: 150 })]);
  });

  it("weight_trend computes a 7-day rolling average", async () => {
    const db = await makeTestDb();
    const t = today();
    const rows = [0, 1, 2].map((i) => ({ date: `${addDays(t, -i)} 07:00:00 +0000`, qty: 80 - i }));
    await persist(db, normalize({ data: { metrics: [{ name: "weight_body_mass", units: "kg", data: rows }], workouts: [], ...empty } }));
    const r = await weightTrend(db, { days: 7 });
    expect(r.points).toHaveLength(3);
    expect(r.latestAvg7).toBe(79); // (80+79+78)/3
  });

  it("rejects bad or oversized ranges", async () => {
    const db = await makeTestDb();
    await expect(dailySummary(db, { start: "01/06/2026", end: "2026-06-02" })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(dailySummary(db, { start: "2026-01-01", end: "2026-06-01" })).rejects.toThrow(/too long/);
    await expect(dailySummary(db, { start: "2026-06-03", end: "2026-06-01" })).rejects.toThrow(/before start/);
  });
});

describe("tz", () => {
  it("tolerates stray whitespace and wrapping quotes from a pasted env value", () => {
    for (const v of ["Europe/London ", " Europe/London\n", '"Europe/London"', "'Europe/London'"]) {
      process.env.HEALTH_TZ = v;
      expect(tz()).toBe("Europe/London");
    }
  });

  it("falls back to Europe/London when blank and still rejects junk", () => {
    process.env.HEALTH_TZ = "   ";
    expect(tz()).toBe("Europe/London");
    process.env.HEALTH_TZ = "Europe/London; select 1";
    expect(() => tz()).toThrow("Invalid HEALTH_TZ");
  });
});
