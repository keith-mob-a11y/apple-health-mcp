import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { metricSamples, workouts } from "@/db/schema";

// Compact, day-level views for chat use. Everything is bucketed by LOCAL calendar day
// (HEALTH_TZ, default Europe/London) so a day matches what the Health app shows.
// A UTC bucket would push late-evening BST samples onto the wrong day.

// Health Auto Export metric names. Confirm against list_metrics after the first sync.
export const METRICS = {
  weight: "weight_body_mass",
  energy: "dietary_energy",
  protein: "protein",
  steps: "step_count",
  activeEnergy: "active_energy",
  sleep: "sleep_analysis",
} as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function tz(): string {
  const z = process.env.HEALTH_TZ ?? "Europe/London";
  // Interpolated as raw SQL (a bound parameter would differ between SELECT and
  // GROUP BY), so it must be a plain zone name.
  if (!/^[A-Za-z0-9_/+-]+$/.test(z)) throw new Error("Invalid HEALTH_TZ");
  return z;
}

const localDay = (col: unknown) =>
  sql<string>`to_char((${col} at time zone '${sql.raw(tz())}'), 'YYYY-MM-DD')`;

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function today(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz() });
}

function checkRange(start: string, end: string, maxDays: number): void {
  for (const d of [start, end]) {
    if (!DATE_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
      throw new Error(`Dates must be YYYY-MM-DD, got "${d}"`);
    }
  }
  if (end < start) throw new Error("end is before start");
  if ((Date.parse(end) - Date.parse(start)) / DAY_MS + 1 > maxDays) {
    throw new Error(`Range too long: max ${maxDays} days`);
  }
}

function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

const round = (n: number | null, dp: number) =>
  n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp;

type Daily = Map<string, { value: number; units: string | null }>;

// One metric reduced to one number per local day. `valueExpr` lets sleep read its
// hours out of the `extra` JSON instead of qty.
async function daily(
  db: any, metric: string, start: string, end: string, agg: "sum" | "avg",
  valueExpr = sql`coalesce(${metricSamples.qty}, ${metricSamples.avg})`,
): Promise<Daily> {
  const day = localDay(metricSamples.date);
  const fn = agg === "sum" ? sql`sum(${valueExpr})` : sql`avg(${valueExpr})`;
  const rows = await db
    .select({ day, value: sql<string>`${fn}`, units: sql<string>`max(${metricSamples.units})` })
    .from(metricSamples)
    .where(and(
      eq(metricSamples.metricName, metric),
      // Coarse UTC window keeps the (metric, date) index in play; the exact local-day
      // filter below does the real work.
      gte(metricSamples.date, new Date(`${addDays(start, -1)}T00:00:00Z`)),
      lt(metricSamples.date, new Date(`${addDays(end, 2)}T00:00:00Z`)),
      sql`${day} >= ${start} and ${day} <= ${end}`,
    ))
    .groupBy(day).orderBy(day);
  const out: Daily = new Map();
  for (const r of rows) {
    if (r.value != null) out.set(r.day, { value: Number(r.value), units: r.units ?? null });
  }
  return out;
}

const sleepHours = sql`coalesce((${metricSamples.extra}->>'totalSleep')::numeric, (${metricSamples.extra}->>'asleep')::numeric, ${metricSamples.qty})`;

async function dailyWorkouts(db: any, start: string, end: string) {
  const day = localDay(workouts.start);
  const rows = await db
    .select({
      day, name: workouts.name, start: workouts.start, durationS: workouts.durationS,
      avgHr: workouts.avgHr, activeEnergy: workouts.activeEnergy, activeEnergyUnits: workouts.activeEnergyUnits,
      distance: workouts.distance, distanceUnits: workouts.distanceUnits,
    })
    .from(workouts)
    .where(and(
      gte(workouts.start, new Date(`${addDays(start, -1)}T00:00:00Z`)),
      lt(workouts.start, new Date(`${addDays(end, 2)}T00:00:00Z`)),
      sql`${day} >= ${start} and ${day} <= ${end}`,
    ))
    .orderBy(asc(workouts.start));
  return rows.map((r: any) => ({
    date: r.day as string,
    type: r.name as string | null,
    durationMin: r.durationS == null ? null : round(Number(r.durationS) / 60, 0),
    avgHr: r.avgHr == null ? null : round(Number(r.avgHr), 0),
    activeEnergy: r.activeEnergy == null ? null : round(Number(r.activeEnergy), 0),
    activeEnergyUnits: r.activeEnergyUnits as string | null,
    distance: r.distance == null ? null : round(Number(r.distance), 2),
    distanceUnits: r.distanceUnits as string | null,
  }));
}

const unitsOf = (d: Daily) => [...d.values()].find((v) => v.units)?.units ?? null;

export async function dailySummary(db: any, args: { start: string; end: string }) {
  const { start, end } = args;
  checkRange(start, end, 31);
  const [weight, energy, protein, steps, active, sleep, wo] = await Promise.all([
    daily(db, METRICS.weight, start, end, "avg"),
    daily(db, METRICS.energy, start, end, "sum"),
    daily(db, METRICS.protein, start, end, "sum"),
    daily(db, METRICS.steps, start, end, "sum"),
    daily(db, METRICS.activeEnergy, start, end, "sum"),
    daily(db, METRICS.sleep, start, end, "sum", sleepHours),
    dailyWorkouts(db, start, end),
  ]);
  const v = (m: Daily, d: string, dp: number) => round(m.get(d)?.value ?? null, dp);
  return {
    timezone: tz(),
    units: {
      weight: unitsOf(weight), energy: unitsOf(energy), protein: unitsOf(protein),
      activeEnergy: unitsOf(active), sleep: "hours",
    },
    days: eachDay(start, end).map((d) => ({
      date: d,
      weight: v(weight, d, 1),
      energy: v(energy, d, 0),
      protein: v(protein, d, 0),
      steps: v(steps, d, 0),
      activeEnergy: v(active, d, 0),
      sleepHours: v(sleep, d, 1),
      workouts: wo.filter((w: any) => w.date === d).map((w: any) => ({ type: w.type, min: w.durationMin })),
    })),
  };
}

export async function weightTrend(db: any, args: { days: number }) {
  const days = Math.min(Math.max(Math.trunc(args.days), 1), 365);
  const end = today();
  const start = addDays(end, -(days - 1));
  const byDay = await daily(db, METRICS.weight, addDays(start, -6), end, "avg");
  const points = eachDay(start, end)
    .filter((d) => byDay.has(d))
    .map((d) => {
      // Mean of the days that have a reading inside the trailing 7-calendar-day window.
      const win = eachDay(addDays(d, -6), d).flatMap((x) => (byDay.has(x) ? [byDay.get(x)!.value] : []));
      return {
        date: d,
        weight: round(byDay.get(d)!.value, 1),
        avg7: round(win.reduce((a, b) => a + b, 0) / win.length, 2),
        readingsInWindow: win.length,
      };
    });
  const first = points[0], last = points[points.length - 1];
  return {
    timezone: tz(),
    units: unitsOf(byDay),
    points,
    latestAvg7: last?.avg7 ?? null,
    changeInAvg7: first && last ? round(last.avg7! - first.avg7!, 2) : null,
  };
}

export async function nutritionSummary(db: any, args: { start: string; end: string }) {
  const { start, end } = args;
  checkRange(start, end, 92);
  const [energy, protein] = await Promise.all([
    daily(db, METRICS.energy, start, end, "sum"),
    daily(db, METRICS.protein, start, end, "sum"),
  ]);
  const all = eachDay(start, end);
  // A day counts as logged if it has any energy or protein. Averages use logged days
  // only, so an unlogged day does not drag the average towards zero.
  const logged = all.filter((d) => (energy.get(d)?.value ?? 0) > 0 || (protein.get(d)?.value ?? 0) > 0);
  const mean = (m: Daily) => {
    const xs = logged.flatMap((d) => (m.has(d) ? [m.get(d)!.value] : []));
    return xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 0) : null;
  };
  return {
    timezone: tz(),
    units: { energy: unitsOf(energy), protein: unitsOf(protein) },
    daysInRange: all.length,
    daysWithFoodLogged: logged.length,
    avgEnergyPerLoggedDay: mean(energy),
    avgProteinPerLoggedDay: mean(protein),
    days: all.map((d) => ({ date: d, energy: round(energy.get(d)?.value ?? null, 0), protein: round(protein.get(d)?.value ?? null, 0) })),
  };
}

export async function workoutSummary(db: any, args: { start: string; end: string }) {
  checkRange(args.start, args.end, 92);
  return { timezone: tz(), workouts: await dailyWorkouts(db, args.start, args.end) };
}
