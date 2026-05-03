[README.md](https://github.com/user-attachments/files/27326395/README.md)
# Coach 🚴

Personal AI training & nutrition coach. Pulls WHOOP recovery data + Strava activity each morning, sends to Claude for analysis, and pushes a specific workout + nutrition prescription to your phone via Pushover.

## What it does

Every morning at 6:30am MST:
1. Pulls last 24h from WHOOP (recovery, HRV, sleep stages, RHR, strain)
2. Pulls last 30 days from Strava (rides, runs, gym sessions with HR/power/pace)
3. Computes acute:chronic workload ratio, weekly polarization, training stress
4. Sends full context to Claude (Opus 4.7)
5. Returns a specific workout (sets/reps/wattage/zones) + full day's nutrition
6. Pushes formatted card to phone via Pushover
7. Logs everything to SQLite at `/data/coach.db`

## One-time setup

### 1. Create a WHOOP developer app
- Go to https://developer.whoop.com/
- Create new app, redirect URI: `https://YOUR-RAILWAY-DOMAIN/auth/whoop/callback`
- Save Client ID + Client Secret

### 2. Create a Strava API app
- Go to https://www.strava.com/settings/api
- Authorization Callback Domain: `YOUR-RAILWAY-DOMAIN` (no https://)
- Save Client ID + Client Secret

### 3. Deploy to Railway
```bash
gh repo create coach --private
git init && git add . && git commit -m "init"
git remote add origin git@github.com:YOU/coach.git
git push -u origin main
```
Connect on Railway, add a volume mounted at `/data`, set all env vars from `.env.example`.

### 4. Connect accounts (one time)
Visit:
- `https://YOUR-RAILWAY-DOMAIN/auth/whoop` → log in, approve
- `https://YOUR-RAILWAY-DOMAIN/auth/strava` → log in, approve

Tokens persist in SQLite and auto-refresh.

### 5. Test it
```
curl -X POST https://YOUR-RAILWAY-DOMAIN/test-run
```
Returns full context + prescription as JSON, no push sent.

```
curl -X POST https://YOUR-RAILWAY-DOMAIN/run
```
Full pipeline including Pushover delivery.

### 6. Cron is automatic
6:30am MST every day. Adjust in `coach.js` if you want a different time.

## Endpoints
- `GET /dashboard` — recent recovery + prescriptions
- `GET /recent` — last 14 days as JSON
- `POST /run` — trigger full pipeline now
- `POST /test-run` — generate prescription without pushing
- `GET /auth/whoop` — connect WHOOP
- `GET /auth/strava` — connect Strava

## Customizing

Set benchmarks in env vars (or let it auto-estimate from Strava history):
- `FTP` — your cycling threshold watts
- `MAX_HR`, `LTHR`
- `SQUAT_1RM`, `DEADLIFT_1RM`, `BENCH_1RM` — for strength prescriptions
- `WEEKLY_HOURS` — training time target
- `PRIMARY_FOCUS` — `cycling`, `cycling-balanced`, `strength`, `aerobic_base`

The coach prompt is in `coach.js` near the top — tune it as you learn what works.

## Roadmap (v3+)
- Periodization: build/recover week cycles, taper before events
- Backtest module: which foods/timings actually move HRV and deep sleep for YOU
- Event mode: input race date, system reverse-engineers the build
- Web UI for logging RPE / how the workout actually went
- Garmin Connect IQ widget for dashboard on the bike

## Security TODO before going live
- Rotate any keys exposed in commit history
- Add basic auth on `/dashboard` and `/recent`
- Restrict CORS
