import type { NormalizeResult, MetricRow, WorkoutRow } from "@/lib/ingest";

// Plain-text ingest for the iOS Shortcuts route. One record per line, pipe separated:
//   steps|2026-10-18|8421
//   weight|2026-10-18|82.4|kg
//   workout|2026-10-18T07:30:00+01:00|Running|45|2026-10-18T08:15:00+01:00|148
// Daily metrics carry a local calendar day, not a timestamp, so a re-sent day replaces
// the earlier total instead of stacking on it.

export const LINE_METRICS: Record<string, { name: string; units: string }> = {
  weight: { name: "weight_body_mass", units: "kg" },
  energy: { name: "dietary_energy", units: "kcal" },
  protein: { name: "protein", units: "g" },
  steps: { name: "step_count", units: "count" },
  active_energy: { name: "active_energy", units: "kcal" },
  sleep: { name: "sleep_analysis", units: "hr" },
};

// Distinct from Health Auto Export's source so the two feeds never overwrite each other,
// and non-null so the (metric, date, source) unique index can actually fire.
export const LINES_SOURCE = "shortcuts";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const LB_PER_KG = 2.2046226218;

function num(s: string | undefined): number | null {
  if (s == null || s.trim() === "") return null;
  const n = Number(s.trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function iso(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseLines(text: string): NormalizeResult {
  // Keyed by metric and day: a repeat inside one request keeps the last value, because
  // an upsert batch may not touch the same row twice.
  const byKey = new Map<string, MetricRow>();
  const workoutById = new Map<string, WorkoutRow>();
  let skipped = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const f = line.split("|").map((s) => s.trim());
    const kind = f[0]?.toLowerCase();

    if (kind === "workout") {
      const [, start, name, durationMin, end, avgHr] = f;
      const startD = iso(start);
      const mins = num(durationMin);
      if (!startD || mins == null) { skipped++; continue; }
      workoutById.set(`shortcuts-${startD.toISOString()}-${name ?? ""}`, {
        id: `shortcuts-${startD.toISOString()}-${name ?? ""}`,
        name: name || null,
        start: startD,
        end: iso(end),
        durationS: String(mins * 60),
        activeEnergy: null,
        activeEnergyUnits: null,
        distance: null,
        distanceUnits: null,
        avgHr: num(avgHr) == null ? null : String(num(avgHr)),
        maxHr: null,
        stepCount: null,
        route: null,
        raw: { source: LINES_SOURCE, line },
      });
      continue;
    }

    const metric = LINE_METRICS[kind ?? ""];
    const day = f[1];
    let value = num(f[2]);
    if (!metric || !day || !DAY_RE.test(day) || value == null) { skipped++; continue; }
    // A day with no weigh-in or no food logged can reach us as 0 from an empty Health
    // query. A real weight is never 0, and a 0 for energy or protein would count as a
    // logged day. Steps and the other activity totals can legitimately be 0.
    if ((kind === "weight" || kind === "energy" || kind === "protein") && value <= 0) { skipped++; continue; }
    const date = new Date(`${day}T12:00:00Z`);
    if (Number.isNaN(date.getTime())) { skipped++; continue; }

    // Shortcuts hands weight back in the user's Health unit, which is often stones or
    // pounds in the UK. Normalise lb to kg so the trend tools stay in one unit.
    let units = (f[3] || metric.units).toLowerCase();
    if (kind === "weight" && (units === "lb" || units === "lbs")) {
      value = value / LB_PER_KG;
      units = "kg";
    }
    // A UTC noon anchor sits inside the same Europe/London calendar day all year, so the
    // local-day bucketing in the summary tools lands it on the right date.
    byKey.set(`${metric.name}|${day}`, {
      metricName: metric.name,
      units,
      date,
      qty: String(Math.round(value * 1000) / 1000),
      min: null, avg: null, max: null, systolic: null, diastolic: null,
      source: LINES_SOURCE,
      extra: kind === "sleep" ? { totalSleep: value } : null,
    });
  }

  return { metricRows: [...byKey.values()], workoutRows: [...workoutById.values()], eventRows: [], skipped };
}
