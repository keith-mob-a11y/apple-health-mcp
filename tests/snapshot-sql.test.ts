import { describe, it, expect } from "vitest";
import { makeTestDb } from "./helpers/db";
import { normalize } from "@/lib/ingest";
import { persist } from "@/lib/persist";
import { latestSnapshot } from "@/lib/tools/latest-snapshot";

async function seeded() {
  const db = await makeTestDb();
  await persist(db, normalize({
    data: {
      metrics: [{ name: "step_count", units: "count", data: [
        { date: "2026-06-01 08:00:00 +0000", qty: 100 },
        { date: "2026-06-02 08:00:00 +0000", qty: 250 },
      ] }],
      workouts: [], ecg: [], stateOfMind: [], symptoms: [], medications: [], cycleTracking: [], heartRateNotifications: [],
    },
  }));
  return db;
}

describe("latest_snapshot", () => {
  it("returns the most recent value per metric", async () => {
    const snap = await latestSnapshot(await seeded());
    const step = snap.find((s: any) => s.metricName === "step_count");
    expect(step.value).toBe("250");
  });
});
