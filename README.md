# apple-health-mcp

A remote [MCP](https://modelcontextprotocol.io) server that exposes your **Apple Watch / Apple Health** data to **every Claude surface** — claude.ai web, Claude Desktop, the Claude mobile app, and Claude Code — with near-fresh data.

Built in public. MIT licensed. Your health data and secrets never live in this repo — only code does.

## How it works

```
Apple Watch → iPhone HealthKit
   → Health Auto Export (iOS app) POSTs to /api/ingest every ~hour
   → Neon Postgres
   → /api/mcp (remote MCP server, this repo)
   → Claude (web · desktop · mobile · Claude Code)
```

HealthKit is iOS-only, so the data is pushed from your iPhone by the
[Health Auto Export](https://apps.apple.com/app/health-auto-export/id1115567069) app.
Local MCP servers can't reach claude.ai web/mobile, so this one is remote.

## Tools

Start with the four summary tools: they return compact day-level aggregates sized for a chat.

| Tool | What it does |
|---|---|
| `daily_summary(start, end)` | Per local day: weight, dietary energy, protein, steps, active energy, sleep hours, workouts. Max 31 days |
| `weight_trend(days)` | Daily weights plus a 7-day rolling average, and the change in that average |
| `nutrition_summary(start, end)` | Daily energy and protein, days with any food logged, averages over logged days only |
| `workouts(start, end)` | Type, duration, average heart rate, active energy per workout |
| `list_metrics` | Discover available metrics (units, counts, date ranges) |
| `query_metric` | Raw / hourly / daily / aggregate query of any one metric |
| `list_workouts` | Raw workout rows (UTC range) |
| `query_events` | ECG, State of Mind, symptoms, medications, cycle tracking, HR notifications |
| `latest_snapshot` | Most recent value for every metric |

Dates are `YYYY-MM-DD` in the local timezone (`HEALTH_TZ`, default `Europe/London`).
Days are bucketed locally, not in UTC, so they match the Health app.

The upstream `health_sql` tool was **removed** in this fork. Its SELECT-only guard let a
data-modifying CTE through (`WITH d AS (DELETE ... RETURNING *) SELECT ...`), so a stray tool
call could have deleted data. The summary tools cover the weekly review without it.

## Changes from upstream (mikipalet/apple-health-mcp)

- Added the four summary tools, with local-timezone day bucketing.
- Removed `health_sql`.
- Removed the `?key=` auth option: URLs end up in request logs, headers do not.
- Secret comparisons are constant-time (ingest, MCP and the OAuth authorise form).
- Ingest no longer logs or returns Zod issue text or DB error text, which can echo health values.
  It logs only issue codes and field paths.
- Vitest timeouts raised to 60s: PGlite start-up is slow on an Intel Mac and the stock 5s limit
  caused false failures.

## Self-host

1. **Database** — provision Neon (Vercel Marketplace → Neon) and copy the connection string.
2. **Deploy** — deploy this repo to Vercel. Set env vars:
   - `DATABASE_URL` — your Neon string
   - `MCP_SECRET` — `openssl rand -hex 32 | pbcopy`, then paste straight into Vercel.
     Never write it into a file in the repo, a chat or a note.
   - `HEALTH_TZ` — optional, defaults to `Europe/London`
3. **Migrate** — `DATABASE_URL=... npm run db:migrate`.
4. **iOS push** — in Health Auto Export: **Automations → REST API**
   - URL: `https://<your-app>.vercel.app/api/ingest`
   - Header: `Authorization: Bearer <MCP_SECRET>`
   - Format: JSON, schedule hourly.
   - Metrics: Body Mass, Dietary Energy, Protein, Step Count, Active Energy, Sleep Analysis,
     plus Workouts.
   - Turn **Summarize Data** on with a **Day** interval for the cumulative metrics (steps,
     energy, protein, active energy). Without it, iPhone and Watch can both report the same
     steps and they are summed twice.
   - After the first sync run `list_metrics` and check the names match `METRICS` in
     `lib/tools/summaries.ts` (`weight_body_mass`, `dietary_energy`, `protein`, `step_count`,
     `active_energy`, `sleep_analysis`). Edit that map if HAE names differ.
4b. **Free alternative: iOS Shortcuts instead of Health Auto Export.** Health Auto Export's
   REST automation is a paid feature. `POST /api/ingest/lines` takes plain text instead, so a
   Shortcuts personal automation can feed the server for nothing.
   - Auth: `Authorization: Bearer <MCP_SECRET>`, `Content-Type: text/plain`.
   - One record per line, pipe separated. Daily metrics are one line per local day:
     `steps|2026-10-18|8421`, `weight|2026-10-18|82.4|kg`, `energy|...|kcal`, `protein|...|g`,
     `active_energy|...|kcal`, `sleep|...|hours`.
   - Workouts: `workout|<start ISO>|<name>|<duration minutes>|<end ISO>|<avg heart rate>`
     (the last two are optional).
   - Re-sending a day **replaces** its total, so today's partial count can be pushed hourly.
     Weight in pounds is converted to kilograms. Bad lines are skipped and counted in the
     response; the lines themselves are never logged.
   - These rows use source `shortcuts`, so they never overwrite Health Auto Export data.
     Do not run both feeds for the same metrics or the summary tools will add them together.
5. **Connect Claude** — same URL everywhere: `https://<your-app>.vercel.app/api/mcp`
   - **Web / mobile / desktop (claude.ai):** add a Custom Connector with that URL.
     claude.ai requires OAuth, which this server implements: when prompted to sign
     in, an **Authorize** page opens — enter your `MCP_SECRET` as the access secret.
     That issues a 90-day token; no per-request URL secret.
   - **Claude Code:**
     `claude mcp add --transport http apple-health https://<your-app>.vercel.app/api/mcp --header "Authorization: Bearer <MCP_SECRET>"`

## Auth model

- **Claude Code / ingest** use the static `MCP_SECRET` as a bearer (or `?key=`).
- **claude.ai web/mobile/desktop** require OAuth, so the server ships a minimal,
  stateless OAuth 2.1 layer (discovery, dynamic client registration, PKCE). The
  `/authorize` step is gated by `MCP_SECRET` (entered as a password), so only the
  secret-holder can mint a token. Codes and tokens are HMAC-signed — no DB, no deps.

## Security notes

- Every endpoint (`/api/ingest`, `/api/mcp`) requires a bearer secret or a signed OAuth token. The
  home page serves a static line and no data. No analytics or third-party scripts.
- OAuth tokens last 90 days and cannot be revoked individually. **Rotating `MCP_SECRET` in Vercel
  and redeploying invalidates every token and the HAE bearer**; do this if a device is lost.
- Treat `MCP_SECRET` like a password: it's the ingest bearer *and* the OAuth login.
- Custom Connectors require a paid Claude plan (Pro/Max/Team/Enterprise).

## Limitations

- iOS background limits make sync periodic (≈ hourly), not real-time.
- Data is a push from the phone; if the phone is offline, ingestion pauses.

## Develop

```bash
npm install
npm test          # Vitest (uses in-memory PGlite, no DB needed)
npm run dev
```

## Verifying it works

1. `curl -i https://<app>/api/mcp` with no header must return `401`.
2. Trigger a manual sync in Health Auto Export; the response should be `200` with row counts.
3. In Claude: "What was my 7-day average weight and average daily protein this week?" Compare
   with the Health app (Browse, Body Measurements and Nutrition). Weight is the mean of each
   day's readings; protein average is over days with food logged.
4. If a number is off, ask Claude for `daily_summary` for those days and compare day by day.

## Free tier notes

Vercel Hobby and Neon Free are enough for one person. Hourly ingest is a few hundred rows a day.
Neon free databases scale to zero, so the first request after idle can take a second or two.
