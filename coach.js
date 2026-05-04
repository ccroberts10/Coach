// coach.js
// Personal AI training & nutrition coach
// Pulls WHOOP recovery + Strava activity, prescribes daily training and nutrition via Claude
// Author: Casey @ DBP
// Deploy: Railway, Node 20+

require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const cron = require('node-cron');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// =================== CONFIG ===================
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/data/coach.db';
const TZ = process.env.TZ || 'America/Denver';

// Personal benchmarks (override via env, auto-estimated from Strava if missing)
const BENCHMARKS = {
  ftp: parseInt(process.env.FTP) || null,                  // cycling watts
  maxHr: parseInt(process.env.MAX_HR) || null,
  lthr: parseInt(process.env.LTHR) || null,                // lactate threshold HR
  restingHrBaseline: parseInt(process.env.RHR_BASELINE) || 55,
  hrvBaseline: parseInt(process.env.HRV_BASELINE) || 54,
  bodyweightKg: parseFloat(process.env.BODYWEIGHT_KG) || 80,
  squat1rm: parseInt(process.env.SQUAT_1RM) || null,
  deadlift1rm: parseInt(process.env.DEADLIFT_1RM) || null,
  bench1rm: parseInt(process.env.BENCH_1RM) || null,
  weeklyHoursTarget: parseFloat(process.env.WEEKLY_HOURS) || 10,
  primaryFocus: process.env.PRIMARY_FOCUS || 'cycling-balanced',
  location: process.env.LOCATION || 'Durango, CO',
};

// API credentials
const WHOOP_CLIENT_ID = process.env.WHOOP_CLIENT_ID;
const WHOOP_CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET;
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN;
const PUSHOVER_USER = process.env.PUSHOVER_USER;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}`;
const OPENWEATHER_KEY = process.env.OPENWEATHER_KEY; // optional, for ride condition context

// =================== DATABASE ===================
// Ensure data dir exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    service TEXT PRIMARY KEY,
    access_token TEXT,
    refresh_token TEXT,
    expires_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS daily_snapshots (
    date TEXT PRIMARY KEY,
    recovery_pct INTEGER,
    hrv REAL,
    rhr INTEGER,
    sleep_hours REAL,
    sleep_efficiency REAL,
    deep_sleep_min INTEGER,
    rem_sleep_min INTEGER,
    sleep_performance INTEGER,
    yesterday_strain REAL,
    weekly_strain_avg REAL,
    monthly_strain_avg REAL,
    acute_chronic_ratio REAL,
    raw_whoop TEXT,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    date TEXT,
    type TEXT,
    duration_sec INTEGER,
    distance_m REAL,
    avg_hr INTEGER,
    max_hr INTEGER,
    avg_power INTEGER,
    normalized_power INTEGER,
    elevation_gain_m REAL,
    suffer_score INTEGER,
    raw_strava TEXT,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS prescriptions (
    date TEXT PRIMARY KEY,
    workout_type TEXT,
    duration_min INTEGER,
    intensity TEXT,
    workout_detail TEXT,
    nutrition TEXT,
    rationale TEXT,
    full_response TEXT,
    delivered INTEGER DEFAULT 0,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS connection_status (
    service TEXT PRIMARY KEY,
    status TEXT,
    error_message TEXT,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS workout_feedback (
    date TEXT PRIMARY KEY,
    status TEXT,
    note TEXT,
    rpe INTEGER,
    created_at INTEGER,
    updated_at INTEGER
  );
`);

console.log(`[db] Initialized at ${DB_PATH}`);

// =================== TOKEN MANAGEMENT ===================
function saveToken(service, access, refresh, expiresAt) {
  db.prepare(`INSERT OR REPLACE INTO tokens (service, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?)`)
    .run(service, access, refresh, expiresAt);
}

function getToken(service) {
  return db.prepare(`SELECT * FROM tokens WHERE service = ?`).get(service);
}

function setConnectionStatus(service, status, errorMessage) {
  db.prepare(`INSERT OR REPLACE INTO connection_status (service, status, error_message, updated_at) VALUES (?, ?, ?, ?)`)
    .run(service, status, errorMessage || null, Date.now());
}

function getConnectionStatus(service) {
  return db.prepare(`SELECT * FROM connection_status WHERE service = ?`).get(service);
}

async function refreshWhoopToken() {
  const t = getToken('whoop');
  if (!t) {
    setConnectionStatus('whoop', 'disconnected', 'No WHOOP token. Reconnect to begin.');
    throw new Error('No WHOOP token. Visit /auth/whoop first.');
  }

  // WHOOP requires client credentials in the body of refresh requests
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: t.refresh_token,
    client_id: WHOOP_CLIENT_ID,
    client_secret: WHOOP_CLIENT_SECRET,
  });

  const res = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  console.log('[whoop refresh] status:', res.status, 'body:', JSON.stringify(data).slice(0, 300));

  if (!data.access_token) {
    setConnectionStatus('whoop', 'disconnected', `Refresh failed: ${data.error_description || data.error || 'unknown'}`);
    throw new Error(`WHOOP refresh failed: ${JSON.stringify(data)}`);
  }
  // WHOOP rotates refresh tokens — save the new one
  saveToken('whoop', data.access_token, data.refresh_token || t.refresh_token, Date.now() + (data.expires_in * 1000));
  setConnectionStatus('whoop', 'connected', null);
  return data.access_token;
}

async function refreshStravaToken() {
  const t = getToken('strava');
  if (!t) {
    setConnectionStatus('strava', 'disconnected', 'No Strava token. Reconnect to begin.');
    throw new Error('No Strava token. Visit /auth/strava first.');
  }
  const res = await (await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
    }),
  })).json();
  if (!res.access_token) {
    setConnectionStatus('strava', 'disconnected', `Refresh failed: ${res.message || res.error || 'unknown'}`);
    throw new Error(`Strava refresh failed: ${JSON.stringify(res)}`);
  }
  saveToken('strava', res.access_token, res.refresh_token, res.expires_at * 1000);
  setConnectionStatus('strava', 'connected', null);
  return res.access_token;
}

async function whoopToken() {
  const t = getToken('whoop');
  if (!t || Date.now() > (t.expires_at - 60000)) return await refreshWhoopToken();
  return t.access_token;
}

async function stravaToken() {
  const t = getToken('strava');
  if (!t || Date.now() > (t.expires_at - 60000)) return await refreshStravaToken();
  return t.access_token;
}

// =================== WHOOP API ===================
async function whoopGet(endpoint, params = {}) {
  const token = await whoopToken();
  const url = new URL(`https://api.prod.whoop.com${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`WHOOP ${endpoint} ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function pullWhoopData() {
  // WHOOP v2 API
  // Recovery is nested inside cycle objects, not a separate endpoint
  const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const end = new Date().toISOString();

  const [sleep, cycles, workouts, recovery] = await Promise.all([
    whoopGet('/developer/v2/activity/sleep', { start, end, limit: 25 }),
    whoopGet('/developer/v2/cycle', { start, end, limit: 25 }),
    whoopGet('/developer/v2/activity/workout', { start, end, limit: 25 }),
    whoopGet('/developer/v2/recovery', { start, end, limit: 25 }).catch(() => ({ records: [] })),
  ]);

  return { recovery, sleep, cycles, workouts };
}

// =================== STRAVA API ===================
async function stravaGet(endpoint, params = {}) {
  const token = await stravaToken();
  const url = new URL(`https://www.strava.com/api/v3${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Strava ${endpoint} ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function pullStravaActivities(daysBack = 30) {
  const after = Math.floor((Date.now() - daysBack * 24 * 60 * 60 * 1000) / 1000);
  const activities = await stravaGet('/athlete/activities', { after, per_page: 100 });
  // Persist
  const insert = db.prepare(`INSERT OR REPLACE INTO activities
    (id, date, type, duration_sec, distance_m, avg_hr, max_hr, avg_power, normalized_power, elevation_gain_m, suffer_score, raw_strava, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const a of activities) {
    insert.run(
      String(a.id), a.start_date.slice(0, 10), a.type,
      a.moving_time, a.distance, a.average_heartrate || null, a.max_heartrate || null,
      a.average_watts || null, a.weighted_average_watts || null,
      a.total_elevation_gain || null, a.suffer_score || null,
      JSON.stringify(a), Date.now()
    );
  }
  return activities;
}

// =================== TRAINING LOAD MATH ===================
function computeTRIMP(activity, maxHr, restingHr) {
  // Banister TRIMP — heart-rate based training load
  if (!activity.average_heartrate || !maxHr) return null;
  const hrr = (activity.average_heartrate - restingHr) / (maxHr - restingHr);
  const minutes = activity.moving_time / 60;
  const gender_k = 1.92; // male coefficient
  return minutes * hrr * 0.64 * Math.exp(gender_k * hrr);
}

function computeTSS(activity, ftp) {
  // Training Stress Score — power-based
  if (!activity.weighted_average_watts || !ftp) return null;
  const np = activity.weighted_average_watts;
  const intensity = np / ftp;
  const seconds = activity.moving_time;
  return (seconds * np * intensity) / (ftp * 3600) * 100;
}

function computeAcuteChronicRatio(activities, maxHr, restingHr, ftp) {
  const now = Date.now();
  let acute = 0, chronic = 0, acuteCount = 0, chronicCount = 0;
  for (const a of activities) {
    const ageDays = (now - new Date(a.start_date).getTime()) / (1000 * 60 * 60 * 24);
    const load = computeTSS(a, ftp) || computeTRIMP(a, maxHr, restingHr) || (a.suffer_score || 0);
    if (ageDays <= 7) { acute += load; acuteCount++; }
    if (ageDays <= 28) { chronic += load; chronicCount++; }
  }
  const acuteAvg = acuteCount > 0 ? acute / 7 : 0;
  const chronicAvg = chronicCount > 0 ? chronic / 28 : 0;
  return {
    acute7dTotal: acute,
    chronic28dTotal: chronic,
    acuteAvg, chronicAvg,
    ratio: chronicAvg > 0 ? acuteAvg / chronicAvg : 1,
  };
}

function estimateFtpFromStrava(activities) {
  // Best 20-min normalized power × 0.95 ≈ FTP
  let best20 = 0;
  for (const a of activities) {
    if (a.type !== 'Ride' && a.type !== 'VirtualRide') continue;
    if (!a.weighted_average_watts || a.moving_time < 20 * 60) continue;
    if (a.weighted_average_watts > best20) best20 = a.weighted_average_watts;
  }
  return best20 ? Math.round(best20 * 0.95) : null;
}

function computeWeeklyDistribution(activities, lthr) {
  // Polarized analysis: % time in Z1-2 (easy) vs Z3 (moderate) vs Z4-5 (hard)
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let easy = 0, mod = 0, hard = 0;
  for (const a of activities) {
    if (new Date(a.start_date).getTime() < cutoff) continue;
    if (!a.average_heartrate) continue;
    const pct = a.average_heartrate / (lthr || 165);
    const min = a.moving_time / 60;
    if (pct < 0.85) easy += min;
    else if (pct < 0.95) mod += min;
    else hard += min;
  }
  const total = easy + mod + hard;
  if (total === 0) return null;
  return {
    easyPct: Math.round(easy / total * 100),
    moderatePct: Math.round(mod / total * 100),
    hardPct: Math.round(hard / total * 100),
    totalMinutes: Math.round(total),
  };
}

// =================== WEATHER (optional) ===================
async function getWeather() {
  if (!OPENWEATHER_KEY) return null;
  try {
    // Get coordinates for Durango (avoids one geocoding call per request)
    const lat = 37.2753, lon = -107.8801;

    // Pull current conditions + 5-day/3-hour forecast in parallel
    const [currentRes, forecastRes] = await Promise.all([
      fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=imperial&appid=${OPENWEATHER_KEY}`),
      fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&units=imperial&appid=${OPENWEATHER_KEY}&cnt=4`),
    ]);
    const current = await currentRes.json();
    const forecast = await forecastRes.json();

    // Today's window (next 12 hours)
    const next12h = (forecast.list || []).slice(0, 4).map(f => ({
      time: new Date(f.dt * 1000).toLocaleTimeString('en-US', { hour: 'numeric', timeZone: TZ }),
      temp: Math.round(f.main.temp),
      feels_like: Math.round(f.main.feels_like),
      conditions: f.weather[0].main,
      description: f.weather[0].description,
      wind_mph: Math.round(f.wind.speed),
      wind_gust_mph: f.wind.gust ? Math.round(f.wind.gust) : null,
      precip_chance_pct: Math.round((f.pop || 0) * 100),
    }));

    return {
      current: {
        temp: Math.round(current.main.temp),
        feels_like: Math.round(current.main.feels_like),
        conditions: current.weather[0].main,
        description: current.weather[0].description,
        wind_mph: Math.round(current.wind.speed),
        humidity_pct: current.main.humidity,
      },
      next_12h: next12h,
      summary: `${Math.round(current.main.temp)}°F ${current.weather[0].description}, wind ${Math.round(current.wind.speed)}mph. Next 12h range: ${Math.min(...next12h.map(f=>f.temp))}°-${Math.max(...next12h.map(f=>f.temp))}°F.`,
    };
  } catch (e) {
    console.log('[weather] Failed:', e.message);
    return null;
  }
}

// =================== BUILD CONTEXT FOR CLAUDE ===================
function buildCoachContext(whoop, strava, weather) {
  // Latest recovery
  const recoveryRecords = (whoop.recovery?.records || []).sort((a, b) =>
    new Date(b.created_at) - new Date(a.created_at));
  const latestRec = recoveryRecords[0]?.score || {};

  // Latest sleep
  const sleepRecords = (whoop.sleep?.records || []).sort((a, b) =>
    new Date(b.start) - new Date(a.start));
  const latestSleep = sleepRecords[0]?.score?.stage_summary || {};
  const sleepNeed = sleepRecords[0]?.score?.sleep_needed || {};

  // Latest cycle (yesterday's strain)
  const cycleRecords = (whoop.cycles?.records || []).sort((a, b) =>
    new Date(b.start) - new Date(a.start));
  const yesterdayStrain = cycleRecords[1]?.score?.strain || cycleRecords[0]?.score?.strain;

  // Weekly avg strain
  const recentCycles = cycleRecords.slice(0, 7);
  const weeklyStrain = recentCycles.length
    ? recentCycles.reduce((s, c) => s + (c.score?.strain || 0), 0) / recentCycles.length
    : null;

  // Strava-derived metrics
  const ftp = BENCHMARKS.ftp || estimateFtpFromStrava(strava) || 250;
  const maxHr = BENCHMARKS.maxHr || 185;
  const lthr = BENCHMARKS.lthr || Math.round(maxHr * 0.89);
  const acRatio = computeAcuteChronicRatio(strava, maxHr, BENCHMARKS.restingHrBaseline, ftp);
  const distribution = computeWeeklyDistribution(strava, lthr);

  // Last 7 days of activities summarized
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentActivities = strava
    .filter(a => new Date(a.start_date).getTime() >= cutoff)
    .map(a => ({
      date: a.start_date.slice(0, 10),
      type: a.type,
      duration_min: Math.round(a.moving_time / 60),
      distance_km: a.distance ? Math.round(a.distance / 100) / 10 : null,
      avg_hr: a.average_heartrate,
      avg_power: a.average_watts,
      np: a.weighted_average_watts,
      elevation_m: a.total_elevation_gain,
      suffer: a.suffer_score,
    }));

  // Strength session tracking — check both WHOOP weightlifting workouts and Strava
  // (Casey logs lifts via WHOOP primarily, occasionally Strava)
  const whoopWorkouts = whoop.workouts?.records || [];
  const whoopStrengthSessions = whoopWorkouts
    .filter(w => {
      const wDate = new Date(w.start).getTime();
      return wDate >= cutoff && /weight|strength|lift/i.test(w.sport_name || '');
    })
    .map(w => ({
      source: 'whoop',
      date: w.start.slice(0, 10),
      sport: w.sport_name,
      duration_min: Math.round((new Date(w.end) - new Date(w.start)) / 60000),
      strain: w.score?.strain,
      avg_hr: w.score?.average_heart_rate,
    }));

  const stravaStrengthSessions = strava
    .filter(a => {
      const aDate = new Date(a.start_date).getTime();
      return aDate >= cutoff && /weight|workout|crossfit/i.test(a.type || '');
    })
    .map(a => ({
      source: 'strava',
      date: a.start_date.slice(0, 10),
      sport: a.type,
      duration_min: Math.round(a.moving_time / 60),
    }));

  // Dedupe by date — if both sources logged a session same day, count once
  const allStrengthDates = new Set([
    ...whoopStrengthSessions.map(s => s.date),
    ...stravaStrengthSessions.map(s => s.date),
  ]);

  // Days since last strength session (across both sources)
  const lastStrengthDate = [...allStrengthDates].sort().reverse()[0];
  const daysSinceLastStrength = lastStrengthDate
    ? Math.floor((Date.now() - new Date(lastStrengthDate).getTime()) / (1000 * 60 * 60 * 24))
    : 999;

  return {
    today: new Date().toISOString().slice(0, 10),
    dayOfWeek: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
    location: BENCHMARKS.location,
    weather,
    recovery: {
      pct: latestRec.recovery_score,
      hrv_ms: latestRec.hrv_rmssd_milli,
      rhr: latestRec.resting_heart_rate,
      hrv_baseline: BENCHMARKS.hrvBaseline,
      rhr_baseline: BENCHMARKS.restingHrBaseline,
    },
    sleep: {
      total_min: latestSleep.total_in_bed_time_milli ? Math.round(latestSleep.total_in_bed_time_milli / 60000) : null,
      deep_min: latestSleep.total_slow_wave_sleep_time_milli ? Math.round(latestSleep.total_slow_wave_sleep_time_milli / 60000) : null,
      rem_min: latestSleep.total_rem_sleep_time_milli ? Math.round(latestSleep.total_rem_sleep_time_milli / 60000) : null,
      light_min: latestSleep.total_light_sleep_time_milli ? Math.round(latestSleep.total_light_sleep_time_milli / 60000) : null,
      sleep_need_min: sleepNeed.need_from_recent_strain_milli ? Math.round((sleepNeed.baseline_milli + sleepNeed.need_from_sleep_debt_milli + sleepNeed.need_from_recent_strain_milli) / 60000) : null,
      respiratory_rate: sleepRecords[0]?.score?.respiratory_rate,
    },
    yesterday_strain: yesterdayStrain,
    weekly_strain_avg: weeklyStrain,
    benchmarks: {
      ftp_watts: ftp,
      max_hr: maxHr,
      lthr,
      bodyweight_kg: BENCHMARKS.bodyweightKg,
      squat_1rm_lb: BENCHMARKS.squat1rm,
      deadlift_1rm_lb: BENCHMARKS.deadlift1rm,
      bench_1rm_lb: BENCHMARKS.bench1rm,
      weekly_hours_target: BENCHMARKS.weeklyHoursTarget,
      primary_focus: BENCHMARKS.primaryFocus,
    },
    training_load: {
      acute_7d: Math.round(acRatio.acute7dTotal),
      chronic_28d_avg_per_week: Math.round(acRatio.chronicAvg * 7),
      ac_ratio: Math.round(acRatio.ratio * 100) / 100,
      ac_status: acRatio.ratio < 0.8 ? 'detraining'
                : acRatio.ratio < 1.3 ? 'optimal'
                : acRatio.ratio < 1.5 ? 'building (caution)'
                : 'overreaching (high injury risk)',
    },
    weekly_distribution: distribution,
    strength_tracking: {
      sessions_last_7d: allStrengthDates.size,
      days_since_last_session: daysSinceLastStrength,
      last_session_date: lastStrengthDate || null,
      sessions_detail: [...whoopStrengthSessions, ...stravaStrengthSessions]
        .sort((a, b) => b.date.localeCompare(a.date)),
      target_per_week: 2,
      status: allStrengthDates.size >= 2 ? 'on_target'
            : allStrengthDates.size === 1 ? 'one_more_needed_this_week'
            : daysSinceLastStrength >= 7 ? 'overdue_two_sessions'
            : 'overdue_one_session',
    },
    prescription_history_14d: getPrescriptionHistoryWithFeedback(),
    recent_activities_7d: recentActivities,
  };
}

// Build a 14-day rolling history of what was prescribed vs what actually happened
function getPrescriptionHistoryWithFeedback() {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT p.date, p.workout_type, p.duration_min, p.intensity, p.full_response,
           f.status as feedback_status, f.note as feedback_note, f.rpe as feedback_rpe
    FROM prescriptions p
    LEFT JOIN workout_feedback f ON p.date = f.date
    WHERE p.date >= ?
    ORDER BY p.date DESC
  `).all(cutoff);

  return rows.map(r => {
    const parsed = JSON.parse(r.full_response || '{}');
    return {
      date: r.date,
      prescribed: {
        type: r.workout_type,
        duration_min: r.duration_min,
        headline: parsed.headline,
      },
      feedback: r.feedback_status ? {
        status: r.feedback_status,
        note: r.feedback_note,
        rpe: r.feedback_rpe,
      } : null,
    };
  });
}

// =================== CLAUDE COACH PROMPT ===================
const COACH_SYSTEM_PROMPT = `You are Casey's personal AI training and nutrition coach. Casey is a cyclist-focused athlete based in Durango, CO who also values strength training and general fitness. You receive their WHOOP recovery data and Strava activity data each morning and prescribe today's workout and fueling plan.

PRIMARY OBJECTIVES (in order):
1. Prevent overtraining and injury — when the data says rest, prescribe rest with conviction
2. Build cycling-specific fitness while maintaining strength
3. Optimize sleep recovery (Casey's deep sleep tends to be a bottleneck)
4. Make prescriptions specific, actionable, and matched to today's recovery state

DECISION FRAMEWORK:

Recovery zones (WHOOP %):
- 67%+ GREEN → green light for hard work (intervals, threshold, strength PRs, long ride)
- 34-66% YELLOW → moderate aerobic, technical work, endurance, light strength — no max efforts
- <34% RED → active recovery only or full rest, regardless of how Casey feels

Acute:Chronic Workload Ratio override:
- AC ratio >1.5 → force a recovery week even if today's recovery is green (overreaching guard)
- AC ratio <0.8 → safe to push harder than recovery alone might suggest

Weekly distribution targets (polarized model):
- ~80% time in Z1-Z2 (easy/aerobic)
- ~20% in Z4-Z5 (hard/threshold)
- Minimize Z3 (moderate/junk miles) — biggest fitness gains come from extremes
- If recent week is too Z3-heavy, prescribe either pure easy or pure hard today

Interference effect:
- Heavy leg day within 48hr of hard cycling intervals = both suffer. Avoid.
- Upper body strength can pair with cycling days fine.

STRENGTH PROGRAMMING (NON-NEGOTIABLE — Casey trains 2x/week minimum):
- Casey trains at home with FULL gym equipment: barbell + plates, rack, bench, dumbbells, kettlebells, pull-up bar, bands. Prescribe accordingly.
- TARGET: 2 strength sessions per week, every week. This is enforced even when cycling recovery is green.
- Style: hybrid of full-body compound work + cyclist-specific accessory work (single-leg, posterior chain, core, hip stability).
- Track strength sessions in the last 7 days from WHOOP workouts (sport_name "weightlifting") and Strava (type "WeightTraining" or "Workout"). If <2 sessions in last 7 days, today's prescription should bias strongly toward strength UNLESS recovery is red OR the AC ratio override forces rest.
- If 0 strength sessions in last 7 days AND today is anything but red recovery: TODAY IS STRENGTH. Override cycling prescription.
- Smart scheduling — never prescribe heavy bilateral leg work (squat, deadlift) the day before a planned hard ride. Use upper body or single-leg unilateral work instead.
- Session structure (60 min target):
  * Warmup 5 min: leg swings, hip circles, glute bridges, band pull-aparts
  * Main lift 1 (compound, 4-5 sets): squat / deadlift / bench / OHP — alternate across sessions
  * Main lift 2 (compound or unilateral, 3-4 sets): pull-up, row, RDL, split squat, lunge variation
  * Cyclist accessory (3 sets each): single-leg RDL or step-up, copenhagen plank or side plank, dead bug or pallof press
  * Optional finisher: KB swings, farmer carries, or hip thrusts
- Use RPE-based prescriptions (no 1RM data available): RPE 7-8 for main lifts, RPE 6-7 for accessories. Format like "4x6 @ RPE 7-8 (~2-3 reps in reserve)"
- For cycling-friendly strength programming reference: the goal is functional strength + injury resistance, not hypertrophy or max strength. Lower volume, moderate-heavy loads.

Sleep-driven adjustments:
- Deep sleep <60 min → reduce intensity, push magnesium glycinate + carbs at dinner
- Sleep performance <70% for 2+ days → automatic recovery day
- HRV >10% below baseline for 2+ days → automatic recovery day

WORKOUT SPECIFICITY REQUIREMENTS:
- Cycling intervals: give exact wattage targets based on FTP (not just "Z4")
- Strength: give sets × reps and % of 1RM if known, or RPE
- Always include duration, intensity zone, and a fueling cue (pre/intra/post)
- Suggest a Durango-area route when cycling outside (Animas River Trail, Hermosa Creek, Junction Creek, La Plata Canyon, Smelter Mountain, Horse Gulch)

WEATHER-AWARE PRESCRIPTIONS:
When weather data is provided, factor it into recommendations:
- Cold (<40°F): suggest later-in-day rides, warmer route choices, layering cues
- Hot (>85°F): suggest morning rides, hydration emphasis (extra 20oz), shaded routes (Animas River Trail), avoid Smelter Mountain exposure
- Wind >20mph: bias toward sheltered routes, suggest indoor trainer for hard intervals (consistent power) or recommend rescheduling
- Rain/snow predicted: suggest trainer or strength substitution; never prescribe outdoor intervals in unsafe conditions
- Fresh snow / icy: trainer or gym only
- Beautiful weather (50-75°F, low wind, clear): encourage getting outside even on easy days; mention the conditions positively
- Suggest specific time-of-day when forecast shows a clear window (e.g., "ride before 11am — wind picks up to 25mph by afternoon")

NUTRITION PRINCIPLES:
- Carbs scaled to today's load: 3-5g/kg rest day, 6-8g/kg moderate, 8-12g/kg heavy training day
- Protein steady at 1.6-2.0 g/kg bodyweight daily
- Pre-ride if intervals/long: 60-80g carbs 1-2hr prior
- Intra: 60g carbs/hr after first 45 min on rides >90 min
- Post: 20-40g protein + 1g/kg carbs within 60 min of hard sessions
- Dinner on training days: include 80-120g complex carbs to support deep sleep + glycogen replenishment
- Magnesium glycinate 300mg before bed (always)
- Tart cherry juice 8oz after hard sessions (anti-inflammatory + melatonin)
- No caffeine after noon, no alcohol within 3hr of bed

LEARNING FROM PRESCRIPTION HISTORY (CRITICAL):
The context includes prescription_history_14d — a record of what you prescribed each day and what actually happened (feedback status: did_it / modified / skipped, with optional note and RPE). USE THIS:

- If Casey marked recent prescriptions "skipped" with notes about being too hard/tired → reduce intensity bias for this week, prioritize what they're actually willing to do
- If Casey marked "modified" with notes → respect their adaptation pattern. Example: "modified — did 3x10 instead of 4x6" tells you they prefer higher reps
- If Casey marked "did_it" with high RPE notes → the prescriptions are well-calibrated, continue
- If Casey marked "did_it" with low RPE notes → prescriptions may be too easy, push harder when recovery permits
- If a strength prescription was skipped multiple times → diagnose: is it timing? equipment? motivation? Address it directly in today's rationale, don't just re-prescribe the same thing
- If patterns emerge across 7+ days (e.g., always skips Monday lifts, always crushes Saturday rides) → adapt the weekly structure to fit reality, not theory
- When recent prescriptions were skipped, acknowledge it briefly in the rationale ("noticed you skipped Tuesday's strength — let's get a session in today since legs are fresh") rather than ignoring it
- NEVER lecture about skipped workouts. Be a coach, not a parent.

OUTPUT FORMAT — return ONLY valid JSON, no preamble, no markdown:
{
  "headline": "1-line summary like 'Threshold day — green light, moderate fueling'",
  "recovery_readout": "2-3 sentences interpreting today's recovery + sleep + load context",
  "workout": {
    "type": "rest | easy_aerobic | endurance | tempo | threshold | vo2max | strength | mixed",
    "primary_modality": "cycling | strength | run | rest | cross_train",
    "duration_min": 90,
    "intensity_zone": "Z2 (HR 130-150)" or "Z4 95-105% FTP",
    "specific_workout": "Detailed structure: warmup, main set with exact targets, cooldown",
    "route_suggestion": "Specific Durango route or 'gym' or 'home' — null if rest",
    "alternates": "Optional: 1-2 alternate workouts if Casey isn't feeling it",
    "skip_if": "Conditions under which to bail (e.g., 'HR doesn't respond in warmup')"
  },
  "nutrition": {
    "pre_workout": "Specific food/timing or null if rest",
    "intra_workout": "Specific or null",
    "post_workout": "Specific or null",
    "breakfast": "Specific meal suggestion",
    "lunch": "Specific meal suggestion",
    "dinner": "Specific meal — emphasize sleep-supporting carbs on training days",
    "supplements": "Daily stack with timing",
    "hydration_target_oz": 100
  },
  "rationale": "1 paragraph: why this prescription, what the data is telling us, what to watch for tomorrow",
  "flags": ["any warnings: low_deep_sleep, ac_ratio_high, hrv_dropping, etc."]
}`;

// =================== CALL CLAUDE ===================
async function generatePrescription(context) {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 3000,
    system: COACH_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Today's data:\n\n${JSON.stringify(context, null, 2)}\n\nPrescribe today's workout and nutrition. Return JSON only.`
    }],
  });
  const text = msg.content[0].text;
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

// =================== PUSHOVER DELIVERY ===================
async function sendPushover(prescription, context) {
  if (!PUSHOVER_TOKEN || !PUSHOVER_USER) {
    console.log('[push] Pushover not configured, skipping');
    return;
  }
  const w = prescription.workout;
  const n = prescription.nutrition;
  const recPct = context.recovery.pct;
  const recEmoji = recPct >= 67 ? '🟢' : recPct >= 34 ? '🟡' : '🔴';

  const message = `${recEmoji} Recovery: ${recPct}%  |  HRV: ${context.recovery.hrv_ms}ms  |  AC: ${context.training_load.ac_ratio}

📋 ${prescription.headline}

${prescription.recovery_readout}

🏋️ TODAY'S WORKOUT (${w.duration_min} min, ${w.type})
${w.specific_workout}
${w.route_suggestion ? `📍 ${w.route_suggestion}` : ''}
${w.intensity_zone ? `🎯 ${w.intensity_zone}` : ''}

🍽️ NUTRITION
${n.pre_workout ? `Pre: ${n.pre_workout}\n` : ''}${n.intra_workout ? `Intra: ${n.intra_workout}\n` : ''}${n.post_workout ? `Post: ${n.post_workout}\n` : ''}Breakfast: ${n.breakfast}
Lunch: ${n.lunch}
Dinner: ${n.dinner}
Supps: ${n.supplements}
Hydration: ${n.hydration_target_oz}oz

💡 ${prescription.rationale}

${prescription.flags?.length ? `⚠️ ${prescription.flags.join(', ')}` : ''}`;

  await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: PUSHOVER_TOKEN,
      user: PUSHOVER_USER,
      title: `Coach: ${prescription.headline}`,
      message,
      priority: '0',
    }),
  });
  console.log('[push] Sent');
}

// =================== DAILY PIPELINE ===================
async function runDailyPipeline() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n[pipeline] Starting daily run for ${today}`);
  try {
    console.log('[pipeline] Pulling WHOOP data...');
    const whoop = await pullWhoopData();

    console.log('[pipeline] Pulling Strava activities...');
    const strava = await pullStravaActivities(30);

    console.log('[pipeline] Fetching weather...');
    const weather = await getWeather();

    console.log('[pipeline] Building context...');
    const context = buildCoachContext(whoop, strava, weather);

    // Persist daily snapshot
    db.prepare(`INSERT OR REPLACE INTO daily_snapshots
      (date, recovery_pct, hrv, rhr, sleep_hours, deep_sleep_min, rem_sleep_min,
       yesterday_strain, weekly_strain_avg, acute_chronic_ratio, raw_whoop, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      today,
      context.recovery.pct,
      context.recovery.hrv_ms,
      context.recovery.rhr,
      context.sleep.total_min ? context.sleep.total_min / 60 : null,
      context.sleep.deep_min,
      context.sleep.rem_min,
      context.yesterday_strain,
      context.weekly_strain_avg,
      context.training_load.ac_ratio,
      JSON.stringify(whoop),
      Date.now()
    );

    console.log('[pipeline] Generating prescription via Claude...');
    const prescription = await generatePrescription(context);

    db.prepare(`INSERT OR REPLACE INTO prescriptions
      (date, workout_type, duration_min, intensity, workout_detail, nutrition, rationale, full_response, delivered, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      today,
      prescription.workout.type,
      prescription.workout.duration_min,
      prescription.workout.intensity_zone,
      prescription.workout.specific_workout,
      JSON.stringify(prescription.nutrition),
      prescription.rationale,
      JSON.stringify(prescription),
      0,
      Date.now()
    );

    console.log('[pipeline] Sending Pushover...');
    await sendPushover(prescription, context);
    db.prepare(`UPDATE prescriptions SET delivered = 1 WHERE date = ?`).run(today);

    console.log(`[pipeline] ✅ Done — ${prescription.headline}`);
    return { context, prescription };
  } catch (e) {
    console.error('[pipeline] ❌ Error:', e);
    if (PUSHOVER_TOKEN && PUSHOVER_USER) {
      await fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        body: new URLSearchParams({
          token: PUSHOVER_TOKEN, user: PUSHOVER_USER,
          title: 'Coach error', message: `Pipeline failed: ${e.message}`,
        }),
      }).catch(() => {});
    }
    throw e;
  }
}

// =================== EXPRESS SERVER ===================
const app = express();
app.use(express.json());

// OAuth flows
const crypto = require('crypto');

app.get('/auth/whoop', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  saveToken('whoop_state', state, '', Date.now() + 10 * 60 * 1000);
  const url = `https://api.prod.whoop.com/oauth/oauth2/auth?client_id=${WHOOP_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI + '/auth/whoop/callback')}&response_type=code&scope=read:recovery%20read:sleep%20read:cycles%20read:workout%20read:profile%20read:body_measurement&state=${state}`;
  res.redirect(url);
});

app.get('/auth/whoop/callback', async (req, res) => {
  try {
    const { code, error, error_description } = req.query;
    if (error) {
      console.error('[whoop callback] WHOOP returned error:', error, error_description);
      return res.status(400).send(`WHOOP error: ${error} - ${error_description}`);
    }
    if (!code) {
      console.error('[whoop callback] No code in query:', req.query);
      return res.status(400).send('No authorization code received');
    }

    const redirectUri = REDIRECT_URI + '/auth/whoop/callback';
    console.log('[whoop callback] Exchanging code, redirect_uri:', redirectUri);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: WHOOP_CLIENT_ID,
      client_secret: WHOOP_CLIENT_SECRET,
      redirect_uri: redirectUri,
    });

    const tokenResponse = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const tokenRes = await tokenResponse.json();
    console.log('[whoop callback] Token response status:', tokenResponse.status);
    console.log('[whoop callback] Token response body:', JSON.stringify(tokenRes));

    if (!tokenRes.access_token) {
      return res.status(400).json(tokenRes);
    }
    saveToken('whoop', tokenRes.access_token, tokenRes.refresh_token, Date.now() + tokenRes.expires_in * 1000);
    setConnectionStatus('whoop', 'connected', null);
    res.send('✅ WHOOP connected. You can close this tab.');
  } catch (e) {
    console.error('[whoop callback] Exception:', e);
    res.status(500).send(e.message);
  }
});

app.get('/auth/strava', (req, res) => {
  const url = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI + '/auth/strava/callback')}&response_type=code&scope=read,activity:read_all&approval_prompt=force`;
  res.redirect(url);
});

app.get('/auth/strava/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const tokenRes = await (await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID, client_secret: STRAVA_CLIENT_SECRET,
        code, grant_type: 'authorization_code',
      }),
    })).json();
    if (!tokenRes.access_token) return res.status(400).json(tokenRes);
    saveToken('strava', tokenRes.access_token, tokenRes.refresh_token, tokenRes.expires_at * 1000);
    setConnectionStatus('strava', 'connected', null);
    res.send('✅ Strava connected. You can close this tab.');
  } catch (e) { res.status(500).send(e.message); }
});

// Manual trigger
app.post('/run', async (req, res) => {
  try {
    const result = await runDailyPipeline();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Test run (no push)
app.post('/test-run', async (req, res) => {
  try {
    const whoop = await pullWhoopData();
    const strava = await pullStravaActivities(30);
    const weather = await getWeather();
    const context = buildCoachContext(whoop, strava, weather);
    const prescription = await generatePrescription(context);
    res.json({ context, prescription });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Recent prescriptions
app.get('/recent', (req, res) => {
  const rows = db.prepare(`SELECT * FROM prescriptions ORDER BY date DESC LIMIT 14`).all();
  res.json(rows.map(r => ({ ...r, full_response: JSON.parse(r.full_response || '{}') })));
});

// JSON API for dashboard
app.get('/api/data', async (req, res) => {
  const snapshots = db.prepare(`SELECT * FROM daily_snapshots ORDER BY date DESC LIMIT 14`).all();
  const prescriptions = db.prepare(`SELECT * FROM prescriptions ORDER BY date DESC LIMIT 14`).all();
  const activities = db.prepare(`SELECT * FROM activities ORDER BY date DESC LIMIT 14`).all();
  const feedback = db.prepare(`SELECT * FROM workout_feedback ORDER BY date DESC LIMIT 14`).all();
  // Index feedback by date for easy joining
  const feedbackByDate = {};
  feedback.forEach(f => { feedbackByDate[f.date] = f; });
  // Pull weather live (cheap, fresh) but don't block dashboard if it fails
  let weather = null;
  try { weather = await getWeather(); } catch(e) {}
  res.json({
    snapshots,
    prescriptions: prescriptions.map(p => ({
      ...p,
      full_response: JSON.parse(p.full_response || '{}'),
      feedback: feedbackByDate[p.date] || null,
    })),
    activities: activities.map(a => ({ ...a, raw_strava: undefined })),
    benchmarks: BENCHMARKS,
    weather,
    connections: {
      whoop: getConnectionStatus('whoop') || { service: 'whoop', status: getToken('whoop') ? 'connected' : 'disconnected' },
      strava: getConnectionStatus('strava') || { service: 'strava', status: getToken('strava') ? 'connected' : 'disconnected' },
    },
  });
});

// Save workout feedback
app.post('/api/feedback', (req, res) => {
  const { date, status, note, rpe } = req.body;
  if (!date || !status) return res.status(400).json({ error: 'date and status required' });
  const validStatus = ['did_it', 'modified', 'skipped'];
  if (!validStatus.includes(status)) return res.status(400).json({ error: 'invalid status' });
  const now = Date.now();
  const existing = db.prepare(`SELECT * FROM workout_feedback WHERE date = ?`).get(date);
  if (existing) {
    db.prepare(`UPDATE workout_feedback SET status = ?, note = ?, rpe = ?, updated_at = ? WHERE date = ?`)
      .run(status, note || null, rpe || null, now, date);
  } else {
    db.prepare(`INSERT INTO workout_feedback (date, status, note, rpe, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(date, status, note || null, rpe || null, now, now);
  }
  res.json({ success: true });
});

// Trigger run from dashboard (browser-friendly, POST returns JSON)
app.post('/api/run', async (req, res) => {
  try {
    const result = await runDailyPipeline();
    res.json({ success: true, prescription: result.prescription });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Dashboard UI
app.get('/dashboard', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Coach</title>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0a0a0a">
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{margin:0;padding:0;background:#000;color:#e8e8e8;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif;font-size:15px;line-height:1.5}
  .container{max-width:600px;margin:0 auto;padding:20px 16px 80px}
  .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
  .header h1{margin:0;font-size:1.3rem;font-weight:700;letter-spacing:-0.02em}
  .header .date{color:#888;font-size:0.85rem}
  .refresh-btn{background:#1a1a1a;border:1px solid #2a2a2a;color:#e8e8e8;padding:8px 14px;border-radius:20px;font-size:0.85rem;cursor:pointer;font-family:inherit}
  .refresh-btn:active{background:#2a2a2a}
  .refresh-btn:disabled{opacity:0.5;cursor:wait}

  .recovery-hero{background:linear-gradient(135deg,#0d1f12 0%,#0a0a0a 100%);border:1px solid #1f3a25;border-radius:20px;padding:24px;margin-bottom:16px;text-align:center}
  .recovery-hero.yellow{background:linear-gradient(135deg,#1f1d0d 0%,#0a0a0a 100%);border-color:#3a3a1f}
  .recovery-hero.red{background:linear-gradient(135deg,#1f0d0d 0%,#0a0a0a 100%);border-color:#3a1f1f}
  .recovery-label{color:#888;text-transform:uppercase;letter-spacing:0.1em;font-size:0.7rem;margin-bottom:8px}
  .recovery-pct{font-size:4rem;font-weight:800;letter-spacing:-0.04em;line-height:1;margin:0}
  .green{color:#4ade80}.yellow{color:#facc15}.red{color:#f87171}.blue{color:#60a5fa}.purple{color:#a78bfa}
  .recovery-headline{margin-top:12px;font-size:0.95rem;color:#ccc;font-weight:500}

  .stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px}
  .stat-tile{background:#0f0f0f;border:1px solid #1f1f1f;border-radius:14px;padding:14px 12px;text-align:center}
  .stat-label{color:#666;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px}
  .stat-value{font-size:1.4rem;font-weight:700;letter-spacing:-0.02em}
  .stat-sub{font-size:0.7rem;color:#666;margin-top:2px}
  .stat-arrow{font-size:0.7rem;margin-left:4px}
  .arrow-up{color:#4ade80}.arrow-down{color:#f87171}.arrow-flat{color:#888}

  .section{margin-top:28px}
  .section-title{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px;padding:0 4px}
  .section-title h2{margin:0;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.1em;color:#666;font-weight:600}
  .section-title .meta{font-size:0.75rem;color:#666}

  .card{background:#0f0f0f;border:1px solid #1f1f1f;border-radius:16px;padding:18px;margin-bottom:12px}
  .card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
  .card-icon{font-size:1.5rem}
  .card-title{font-weight:700;font-size:1.05rem;letter-spacing:-0.01em}
  .workout-meta{display:flex;gap:14px;font-size:0.8rem;color:#888;margin-bottom:14px;flex-wrap:wrap}
  .workout-meta span{display:flex;align-items:center;gap:4px}
  .workout-detail{font-size:0.92rem;color:#ddd;line-height:1.6;white-space:pre-wrap}
  .workout-route{margin-top:14px;padding-top:14px;border-top:1px solid #1f1f1f;font-size:0.85rem;color:#aaa}
  .workout-skip{margin-top:10px;font-size:0.8rem;color:#888;font-style:italic}

  .nutrition-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #1a1a1a;font-size:0.88rem}
  .nutrition-row:last-child{border-bottom:none}
  .nutrition-label{color:#888;flex:0 0 110px;font-weight:500}
  .nutrition-value{flex:1;color:#ddd}

  .flag{display:inline-block;background:#3a1f1f;color:#f87171;padding:3px 9px;border-radius:6px;font-size:0.7rem;margin:2px 4px 2px 0;font-weight:500}

  .chart{margin:16px 0}
  .chart-row{display:flex;align-items:end;gap:6px;height:80px;padding:0 4px}
  .chart-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px}
  .chart-bar{width:100%;background:#1a1a1a;border-radius:4px 4px 0 0;position:relative;min-height:2px}
  .chart-bar-fill{position:absolute;bottom:0;left:0;right:0;border-radius:4px 4px 0 0}
  .chart-day{font-size:0.65rem;color:#666;margin-top:6px}
  .chart-val{font-size:0.7rem;color:#aaa;font-weight:600;margin-bottom:2px}

  .activity-row{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #1a1a1a;font-size:0.87rem}
  .activity-row:last-child{border-bottom:none}
  .activity-info{flex:1}
  .activity-type{font-weight:600;color:#ddd}
  .activity-meta{color:#666;font-size:0.78rem;margin-top:2px}
  .activity-stats{text-align:right;color:#aaa;font-size:0.8rem}

  .rationale{background:#0a0e1a;border-left:3px solid #60a5fa;padding:14px 16px;border-radius:0 12px 12px 0;font-size:0.88rem;color:#ccc;line-height:1.6;margin-top:12px}

  .empty{text-align:center;padding:40px 20px;color:#666}
  .empty-icon{font-size:3rem;margin-bottom:12px}

  .tab-bar{position:fixed;bottom:0;left:0;right:0;background:#0a0a0a;border-top:1px solid #1f1f1f;display:flex;padding:8px 0 calc(8px + env(safe-area-inset-bottom));z-index:100}
  .tab{flex:1;text-align:center;padding:6px 0;color:#666;text-decoration:none;font-size:0.7rem;cursor:pointer;font-family:inherit;background:none;border:none}
  .tab.active{color:#4ade80}
  .tab-icon{font-size:1.2rem;display:block;margin-bottom:2px}

  .view{display:none}
  .view.active{display:block}

  .loading{text-align:center;padding:60px 20px;color:#666}
  .spinner{display:inline-block;width:30px;height:30px;border:3px solid #1f1f1f;border-top-color:#4ade80;border-radius:50%;animation:spin 0.8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}

  .reconnect-banner{background:linear-gradient(135deg,#3a1f0d 0%,#1a0f08 100%);border:1px solid #5a3a1f;border-radius:14px;padding:14px 16px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:12px}
  .reconnect-banner.error{background:linear-gradient(135deg,#3a1212 0%,#1a0808 100%);border-color:#5a2828}
  .reconnect-text{flex:1;font-size:0.85rem;color:#f5d491;line-height:1.4}
  .reconnect-text.error{color:#f5a191}
  .reconnect-text strong{display:block;font-size:0.95rem;margin-bottom:2px;color:#fff}
  .reconnect-btn{background:#facc15;color:#000;border:none;padding:9px 16px;border-radius:8px;font-size:0.85rem;font-weight:600;text-decoration:none;white-space:nowrap;cursor:pointer;font-family:inherit}
  .reconnect-btn:active{transform:scale(0.97)}
  .reconnect-btn.error{background:#f87171}

  .feedback-section{margin-top:14px;padding-top:14px;border-top:1px solid #1f1f1f}
  .feedback-label{color:#666;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px}
  .feedback-buttons{display:flex;gap:8px;margin-bottom:10px}
  .fb-btn{flex:1;padding:10px 8px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;color:#aaa;font-size:0.8rem;cursor:pointer;font-family:inherit;transition:all 0.15s;font-weight:500}
  .fb-btn:active{transform:scale(0.97)}
  .fb-btn.active.did_it{background:#0d2818;border-color:#1f5a35;color:#4ade80}
  .fb-btn.active.modified{background:#1f1d0d;border-color:#5a4a1f;color:#facc15}
  .fb-btn.active.skipped{background:#1f0d0d;border-color:#5a2828;color:#f87171}
  .fb-note{width:100%;background:#0a0a0a;border:1px solid #2a2a2a;border-radius:10px;color:#ddd;padding:10px 12px;font-size:0.85rem;font-family:inherit;resize:none;margin-top:6px;box-sizing:border-box}
  .fb-note::placeholder{color:#555}
  .fb-note:focus{outline:none;border-color:#444}
  .fb-saved{color:#4ade80;font-size:0.75rem;margin-left:8px;display:inline-block;opacity:0;transition:opacity 0.3s}
  .fb-saved.show{opacity:1}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div>
      <h1>🚴 Coach</h1>
      <div class="date" id="dateDisplay"></div>
    </div>
    <button class="refresh-btn" id="refreshBtn" onclick="runRefresh()">↻ Run</button>
  </div>

  <div id="loadingView" class="loading">
    <div class="spinner"></div>
    <div style="margin-top:14px">Loading…</div>
  </div>

  <div id="connectionBanners"></div>

  <!-- TODAY VIEW -->
  <div class="view" id="todayView">
    <div id="todayContent"></div>
  </div>

  <!-- TRENDS VIEW -->
  <div class="view" id="trendsView">
    <div id="trendsContent"></div>
  </div>

  <!-- HISTORY VIEW -->
  <div class="view" id="historyView">
    <div id="historyContent"></div>
  </div>
</div>

<div class="tab-bar">
  <button class="tab active" data-view="today" onclick="switchView('today')">
    <span class="tab-icon">📋</span>Today
  </button>
  <button class="tab" data-view="trends" onclick="switchView('trends')">
    <span class="tab-icon">📈</span>Trends
  </button>
  <button class="tab" data-view="history" onclick="switchView('history')">
    <span class="tab-icon">📅</span>History
  </button>
</div>

<script>
let appData = null;

function fmtDate(s){return new Date(s+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'})}
function fmtShortDate(s){return new Date(s+'T12:00:00').toLocaleDateString('en-US',{month:'numeric',day:'numeric'})}
function fmtDay(s){return new Date(s+'T12:00:00').toLocaleDateString('en-US',{weekday:'short'})}
function recColor(p){return p>=67?'green':p>=34?'yellow':'red'}
function arrow(curr,base){if(curr==null||base==null)return'';const d=curr-base;if(Math.abs(d)<base*0.02)return'<span class="stat-arrow arrow-flat">→</span>';return d>0?'<span class="stat-arrow arrow-up">▲</span>':'<span class="stat-arrow arrow-down">▼</span>'}

async function loadData(){
  document.getElementById('loadingView').style.display='block';
  try{
    const r = await fetch('/api/data');
    appData = await r.json();
    renderAll();
  }catch(e){
    document.getElementById('loadingView').innerHTML = '<div style="color:#f87171">Error: '+e.message+'</div>';
    return;
  }
  document.getElementById('loadingView').style.display='none';
}

async function runRefresh(){
  const btn = document.getElementById('refreshBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Running…';
  try{
    const r = await fetch('/api/run', { method: 'POST' });
    const data = await r.json();
    if(!data.success) throw new Error(data.error);
    await loadData();
  }catch(e){
    // Reload data anyway so the disconnect banner appears
    await loadData();
    alert('Run failed: '+e.message);
  }
  btn.disabled = false;
  btn.textContent = '↻ Run';
}

function switchView(name){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(name+'View').classList.add('active');
  document.querySelector('[data-view="'+name+'"]').classList.add('active');
}

function renderAll(){
  if(!appData) return;
  document.getElementById('dateDisplay').textContent = new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
  renderBanners();
  renderToday();
  renderTrends();
  renderHistory();
  document.getElementById('todayView').classList.add('active');
}

function renderBanners(){
  const el = document.getElementById('connectionBanners');
  const banners = [];
  const c = appData.connections || {};
  if(c.whoop?.status === 'disconnected'){
    banners.push(\`<div class="reconnect-banner error">
      <div class="reconnect-text error">
        <strong>⚠ WHOOP disconnected</strong>
        \${c.whoop.error_message || 'Tap to reconnect your WHOOP account.'}
      </div>
      <a href="/auth/whoop" class="reconnect-btn error">Reconnect</a>
    </div>\`);
  }
  if(c.strava?.status === 'disconnected'){
    banners.push(\`<div class="reconnect-banner error">
      <div class="reconnect-text error">
        <strong>⚠ Strava disconnected</strong>
        \${c.strava.error_message || 'Tap to reconnect your Strava account.'}
      </div>
      <a href="/auth/strava" class="reconnect-btn error">Reconnect</a>
    </div>\`);
  }
  el.innerHTML = banners.join('');
}

function renderToday(){
  const el = document.getElementById('todayContent');
  const snap = appData.snapshots[0];
  const presc = appData.prescriptions[0];

  if(!snap || !presc){
    el.innerHTML = '<div class="empty"><div class="empty-icon">🌱</div><div>No data yet — tap <b>Run</b> to pull from WHOOP and Strava.</div></div>';
    return;
  }

  const p = presc.full_response;
  const recCol = recColor(snap.recovery_pct);
  const acStatus = snap.acute_chronic_ratio < 0.8 ? 'detraining' : snap.acute_chronic_ratio < 1.3 ? 'optimal' : snap.acute_chronic_ratio < 1.5 ? 'building' : 'overreaching';
  const acCol = snap.acute_chronic_ratio < 1.3 ? 'green' : snap.acute_chronic_ratio < 1.5 ? 'yellow' : 'red';

  el.innerHTML = \`
    <div class="recovery-hero \${recCol}">
      <div class="recovery-label">Recovery</div>
      <div class="recovery-pct \${recCol}">\${snap.recovery_pct ?? '—'}<span style="font-size:1.5rem">%</span></div>
      <div class="recovery-headline">\${p?.headline || ''}</div>
    </div>

    \${appData.weather ? \`
    <div class="card" style="margin-bottom:14px;padding:12px 16px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:0.7rem;color:#666;text-transform:uppercase;letter-spacing:0.08em">Durango Weather</div>
          <div style="font-size:0.95rem;color:#ddd;margin-top:2px">\${appData.weather.current.temp}°F · \${appData.weather.current.description}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:0.75rem;color:#888">Wind \${appData.weather.current.wind_mph}mph</div>
          <div style="font-size:0.75rem;color:#888">Feels \${appData.weather.current.feels_like}°</div>
        </div>
      </div>
      \${appData.weather.next_12h?.length ? \`
      <div style="display:flex;gap:8px;margin-top:10px;padding-top:10px;border-top:0.5px solid #1f1f1f">
        \${appData.weather.next_12h.map(f => \`<div style="flex:1;text-align:center;font-size:0.7rem">
          <div style="color:#666">\${f.time}</div>
          <div style="color:#ddd;margin-top:2px;font-weight:500">\${f.temp}°</div>
          \${f.precip_chance_pct > 20 ? \`<div style="color:#60a5fa;font-size:0.65rem">\${f.precip_chance_pct}%💧</div>\` : ''}
        </div>\`).join('')}
      </div>\` : ''}
    </div>\` : ''}

    <div class="stat-grid">
      <div class="stat-tile">
        <div class="stat-label">HRV</div>
        <div class="stat-value">\${snap.hrv?.toFixed?.(0) ?? '—'}\${arrow(snap.hrv, appData.benchmarks.hrvBaseline)}</div>
        <div class="stat-sub">ms · base \${appData.benchmarks.hrvBaseline}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">RHR</div>
        <div class="stat-value">\${snap.rhr ?? '—'}\${arrow(appData.benchmarks.restingHrBaseline, snap.rhr)}</div>
        <div class="stat-sub">bpm · base \${appData.benchmarks.restingHrBaseline}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">Sleep</div>
        <div class="stat-value">\${snap.sleep_hours?.toFixed?.(1) ?? '—'}<span style="font-size:0.85rem">h</span></div>
        <div class="stat-sub">\${snap.deep_sleep_min ?? '—'} deep</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">Strain Yest</div>
        <div class="stat-value blue">\${snap.yesterday_strain?.toFixed?.(1) ?? '—'}</div>
        <div class="stat-sub">/ 21</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">AC Ratio</div>
        <div class="stat-value \${acCol}">\${snap.acute_chronic_ratio ?? '—'}</div>
        <div class="stat-sub">\${acStatus}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">Wkly Avg</div>
        <div class="stat-value">\${snap.weekly_strain_avg?.toFixed?.(1) ?? '—'}</div>
        <div class="stat-sub">strain</div>
      </div>
    </div>

    \${p?.workout ? \`
    <div class="section">
      <div class="section-title">
        <h2>Today's Workout</h2>
        <div class="meta">\${p.workout.duration_min || '—'} min · \${p.workout.type || '—'}</div>
      </div>
      <div class="card">
        <div class="card-header">
          <div class="card-icon">\${workoutEmoji(p.workout.primary_modality)}</div>
          <div class="card-title" style="flex:1;margin-left:12px">\${(p.workout.primary_modality || '').toUpperCase()}</div>
        </div>
        <div class="workout-meta">
          \${p.workout.intensity_zone ? '<span>🎯 '+p.workout.intensity_zone+'</span>' : ''}
          \${p.workout.duration_min ? '<span>⏱ '+p.workout.duration_min+' min</span>' : ''}
        </div>
        <div class="workout-detail">\${p.workout.specific_workout || ''}</div>
        \${p.workout.route_suggestion ? \`<div class="workout-route">📍 \${p.workout.route_suggestion}</div>\` : ''}
        \${p.workout.alternates ? \`<div class="workout-route"><b>Alternates:</b> \${p.workout.alternates}</div>\` : ''}
        \${p.workout.skip_if ? \`<div class="workout-skip">⚠️ Skip if: \${p.workout.skip_if}</div>\` : ''}

        <div class="feedback-section">
          <div class="feedback-label">How did it go?<span class="fb-saved" id="fbSaved">✓ saved</span></div>
          <div class="feedback-buttons">
            <button class="fb-btn did_it \${presc.feedback?.status === 'did_it' ? 'active' : ''}" data-status="did_it" onclick="saveFeedback('\${presc.date}', 'did_it')">✅ Did it</button>
            <button class="fb-btn modified \${presc.feedback?.status === 'modified' ? 'active' : ''}" data-status="modified" onclick="saveFeedback('\${presc.date}', 'modified')">🔧 Modified</button>
            <button class="fb-btn skipped \${presc.feedback?.status === 'skipped' ? 'active' : ''}" data-status="skipped" onclick="saveFeedback('\${presc.date}', 'skipped')">⏭️ Skipped</button>
          </div>
          <textarea class="fb-note" id="fbNote" placeholder="Optional note: how the legs felt, what you actually did, RPE, anything…" rows="2" onblur="saveFeedbackNote('\${presc.date}')">\${presc.feedback?.note || ''}</textarea>
        </div>
      </div>
    </div>\` : ''}

    \${p?.nutrition ? \`
    <div class="section">
      <div class="section-title"><h2>Nutrition</h2><div class="meta">\${p.nutrition.hydration_target_oz || '—'} oz water</div></div>
      <div class="card">
        \${p.nutrition.pre_workout ? nutritionRow('Pre', p.nutrition.pre_workout) : ''}
        \${p.nutrition.intra_workout ? nutritionRow('Intra', p.nutrition.intra_workout) : ''}
        \${p.nutrition.post_workout ? nutritionRow('Post', p.nutrition.post_workout) : ''}
        \${nutritionRow('Breakfast', p.nutrition.breakfast)}
        \${nutritionRow('Lunch', p.nutrition.lunch)}
        \${nutritionRow('Dinner', p.nutrition.dinner)}
        \${nutritionRow('Supps', p.nutrition.supplements)}
      </div>
    </div>\` : ''}

    \${p?.rationale ? \`
    <div class="section">
      <div class="section-title"><h2>Why this prescription</h2></div>
      <div class="rationale">\${p.rationale}</div>
    </div>\` : ''}

    \${p?.flags?.length ? \`
    <div class="section">
      <div class="section-title"><h2>Flags</h2></div>
      <div>\${p.flags.map(f=>'<span class="flag">⚠ '+f.replace(/_/g,' ')+'</span>').join('')}</div>
    </div>\` : ''}
  \`;
}

function nutritionRow(label, val){
  return \`<div class="nutrition-row"><div class="nutrition-label">\${label}</div><div class="nutrition-value">\${val||'—'}</div></div>\`;
}

function workoutEmoji(m){
  const map = {cycling:'🚴', strength:'🏋️', run:'🏃', rest:'😴', cross_train:'🤸', mixed:'🔀'};
  return map[m] || '💪';
}

async function saveFeedback(date, status){
  // Toggle visual state immediately
  document.querySelectorAll('.fb-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.fb-btn[data-status="'+status+'"]').classList.add('active', status);
  const note = document.getElementById('fbNote')?.value || '';
  try {
    await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, status, note }),
    });
    showSaved();
    // Refresh underlying data so subsequent renders have the right state
    if(appData?.prescriptions?.[0]) appData.prescriptions[0].feedback = { status, note };
  } catch(e) { console.error('Feedback save failed', e); }
}

async function saveFeedbackNote(date){
  const noteEl = document.getElementById('fbNote');
  if (!noteEl) return;
  const note = noteEl.value;
  const status = appData?.prescriptions?.[0]?.feedback?.status;
  if (!status) return; // Only save note if status is set
  try {
    await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, status, note }),
    });
    showSaved();
    if(appData?.prescriptions?.[0]) appData.prescriptions[0].feedback = { status, note };
  } catch(e) { console.error('Note save failed', e); }
}

function showSaved(){
  const el = document.getElementById('fbSaved');
  if (!el) return;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1500);
}

function renderTrends(){
  const el = document.getElementById('trendsContent');
  const snaps = [...appData.snapshots].reverse(); // oldest first

  if(snaps.length === 0){
    el.innerHTML = '<div class="empty">No trend data yet.</div>';
    return;
  }

  // Recovery chart
  const maxRec = 100;
  const recBars = snaps.map(s => {
    const h = ((s.recovery_pct||0) / maxRec) * 100;
    const col = recColor(s.recovery_pct);
    return \`<div class="chart-col">
      <div class="chart-val \${col}">\${s.recovery_pct||'—'}</div>
      <div class="chart-bar" style="height:80px">
        <div class="chart-bar-fill \${col}" style="height:\${h}%;background:currentColor"></div>
      </div>
      <div class="chart-day">\${fmtDay(s.date)}</div>
    </div>\`;
  }).join('');

  // Strain chart
  const maxStrain = Math.max(21, ...snaps.map(s => s.yesterday_strain || 0));
  const strainBars = snaps.map(s => {
    const v = s.yesterday_strain || 0;
    const h = (v / maxStrain) * 100;
    return \`<div class="chart-col">
      <div class="chart-val blue">\${v.toFixed(1)}</div>
      <div class="chart-bar" style="height:80px">
        <div class="chart-bar-fill blue" style="height:\${h}%;background:currentColor"></div>
      </div>
      <div class="chart-day">\${fmtDay(s.date)}</div>
    </div>\`;
  }).join('');

  // HRV chart
  const hrvVals = snaps.map(s => s.hrv).filter(v => v != null);
  const minHrv = hrvVals.length ? Math.min(...hrvVals) - 5 : 0;
  const maxHrv = hrvVals.length ? Math.max(...hrvVals) + 5 : 100;
  const hrvBars = snaps.map(s => {
    if(s.hrv == null) return \`<div class="chart-col"><div class="chart-val">—</div><div class="chart-bar" style="height:80px"></div><div class="chart-day">\${fmtDay(s.date)}</div></div>\`;
    const h = ((s.hrv - minHrv) / (maxHrv - minHrv)) * 100;
    return \`<div class="chart-col">
      <div class="chart-val purple">\${s.hrv.toFixed(0)}</div>
      <div class="chart-bar" style="height:80px">
        <div class="chart-bar-fill purple" style="height:\${h}%;background:currentColor"></div>
      </div>
      <div class="chart-day">\${fmtDay(s.date)}</div>
    </div>\`;
  }).join('');

  // Sleep chart
  const sleepBars = snaps.map(s => {
    const v = s.sleep_hours || 0;
    const h = (v / 10) * 100;
    return \`<div class="chart-col">
      <div class="chart-val">\${v.toFixed(1)}</div>
      <div class="chart-bar" style="height:80px">
        <div class="chart-bar-fill blue" style="height:\${h}%;background:#60a5fa"></div>
      </div>
      <div class="chart-day">\${fmtDay(s.date)}</div>
    </div>\`;
  }).join('');

  el.innerHTML = \`
    <div class="section">
      <div class="section-title"><h2>Recovery (last \${snaps.length} days)</h2></div>
      <div class="card"><div class="chart-row">\${recBars}</div></div>
    </div>
    <div class="section">
      <div class="section-title"><h2>HRV trend</h2></div>
      <div class="card"><div class="chart-row">\${hrvBars}</div></div>
    </div>
    <div class="section">
      <div class="section-title"><h2>Daily strain</h2></div>
      <div class="card"><div class="chart-row">\${strainBars}</div></div>
    </div>
    <div class="section">
      <div class="section-title"><h2>Sleep hours</h2></div>
      <div class="card"><div class="chart-row">\${sleepBars}</div></div>
    </div>
  \`;
}

function renderHistory(){
  const el = document.getElementById('historyContent');
  const items = appData.prescriptions;
  const acts = appData.activities;

  if(items.length === 0){
    el.innerHTML = '<div class="empty">No history yet.</div>';
    return;
  }

  const prescHtml = items.map(p => {
    const fr = p.full_response;
    const w = fr.workout || {};
    const fb = p.feedback;
    const fbBadge = fb ? \`<span style="display:inline-block;padding:2px 8px;border-radius:6px;font-size:0.7rem;margin-left:6px;\${
      fb.status === 'did_it' ? 'background:#0d2818;color:#4ade80' :
      fb.status === 'modified' ? 'background:#1f1d0d;color:#facc15' :
      'background:#1f0d0d;color:#f87171'
    }">\${fb.status === 'did_it' ? '✓ done' : fb.status === 'modified' ? '🔧 modified' : '⏭ skipped'}</span>\` : '';
    return \`<div class="card">
      <div class="card-header">
        <div>
          <div style="color:#666;font-size:0.75rem">\${fmtDate(p.date)}\${fbBadge}</div>
          <div class="card-title" style="margin-top:4px">\${fr.headline || p.workout_type || '—'}</div>
        </div>
        <div class="card-icon">\${workoutEmoji(w.primary_modality)}</div>
      </div>
      <div class="workout-meta">
        \${w.duration_min ? '<span>⏱ '+w.duration_min+'m</span>' : ''}
        \${w.intensity_zone ? '<span>🎯 '+w.intensity_zone+'</span>' : ''}
        \${w.type ? '<span>'+w.type+'</span>' : ''}
      </div>
      <div style="font-size:0.85rem;color:#bbb;line-height:1.5">\${(w.specific_workout || '').slice(0,200)}\${w.specific_workout?.length > 200 ? '…' : ''}</div>
      \${fb?.note ? \`<div style="margin-top:10px;padding:10px 12px;background:#0a0a0a;border-radius:8px;font-size:0.8rem;color:#aaa;font-style:italic">"\${fb.note}"</div>\` : ''}
    </div>\`;
  }).join('');

  const actsHtml = acts.length ? \`
    <div class="section">
      <div class="section-title"><h2>Recent Strava Activities</h2></div>
      <div class="card">
        \${acts.slice(0,10).map(a => \`<div class="activity-row">
          <div class="activity-info">
            <div class="activity-type">\${a.type} · \${fmtShortDate(a.date)}</div>
            <div class="activity-meta">\${a.distance_m ? (a.distance_m/1000).toFixed(1)+'km' : ''} \${a.elevation_gain_m ? '· '+Math.round(a.elevation_gain_m)+'m gain' : ''}</div>
          </div>
          <div class="activity-stats">
            \${a.duration_sec ? Math.round(a.duration_sec/60)+' min' : ''}<br>
            \${a.avg_hr ? '<span style="color:#f87171">'+Math.round(a.avg_hr)+'bpm</span>' : ''}\${a.avg_power ? ' · <span style="color:#facc15">'+Math.round(a.avg_power)+'W</span>' : ''}
          </div>
        </div>\`).join('')}
      </div>
    </div>\` : '';

  el.innerHTML = \`
    <div class="section">
      <div class="section-title"><h2>Recent Prescriptions</h2></div>
      \${prescHtml}
    </div>
    \${actsHtml}
  \`;
}

loadData();
</script>
</body>
</html>`);
});

// Privacy policy (required by WHOOP for app approval)
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'privacy.html'));
});

app.get('/', (req, res) => res.redirect('/dashboard'));

// =================== CRON ===================
// 6:30am MST daily
cron.schedule('30 6 * * *', () => {
  console.log('[cron] Trigger');
  runDailyPipeline().catch(e => console.error(e));
}, { timezone: TZ });

app.listen(PORT, () => {
  console.log(`[server] Coach running on port ${PORT}`);
  console.log(`[server] Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`[server] Connect WHOOP: ${REDIRECT_URI}/auth/whoop`);
  console.log(`[server] Connect Strava: ${REDIRECT_URI}/auth/strava`);
});
