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

async function refreshWhoopToken() {
  const t = getToken('whoop');
  if (!t) throw new Error('No WHOOP token. Visit /auth/whoop first.');
  const res = await (await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: WHOOP_CLIENT_ID,
      client_secret: WHOOP_CLIENT_SECRET,
      scope: 'read:recovery read:sleep read:cycles read:workout read:profile read:body_measurement',
    }),
  })).json();
  if (!res.access_token) throw new Error(`WHOOP refresh failed: ${JSON.stringify(res)}`);
  saveToken('whoop', res.access_token, res.refresh_token, Date.now() + (res.expires_in * 1000));
  return res.access_token;
}

async function refreshStravaToken() {
  const t = getToken('strava');
  if (!t) throw new Error('No Strava token. Visit /auth/strava first.');
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
  if (!res.access_token) throw new Error(`Strava refresh failed: ${JSON.stringify(res)}`);
  saveToken('strava', res.access_token, res.refresh_token, res.expires_at * 1000);
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
  const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const end = new Date().toISOString();

  const [recovery, sleep, cycles, workouts] = await Promise.all([
    whoopGet('/developer/v1/recovery', { start, end, limit: 25 }),
    whoopGet('/developer/v1/activity/sleep', { start, end, limit: 25 }),
    whoopGet('/developer/v1/cycle', { start, end, limit: 25 }),
    whoopGet('/developer/v1/activity/workout', { start, end, limit: 25 }),
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
    const res = await (await fetch(
      `https://api.openweathermap.org/data/2.5/weather?q=Durango,CO,US&units=imperial&appid=${OPENWEATHER_KEY}`
    )).json();
    return {
      temp: Math.round(res.main.temp),
      conditions: res.weather[0].main,
      wind: Math.round(res.wind.speed),
      description: res.weather[0].description,
    };
  } catch (e) { return null; }
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
    recent_activities_7d: recentActivities,
  };
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

Sleep-driven adjustments:
- Deep sleep <60 min → reduce intensity, push magnesium glycinate + carbs at dinner
- Sleep performance <70% for 2+ days → automatic recovery day
- HRV >10% below baseline for 2+ days → automatic recovery day

WORKOUT SPECIFICITY REQUIREMENTS:
- Cycling intervals: give exact wattage targets based on FTP (not just "Z4")
- Strength: give sets × reps and % of 1RM if known, or RPE
- Always include duration, intensity zone, and a fueling cue (pre/intra/post)
- Suggest a Durango-area route when cycling outside (Animas River Trail, Hermosa Creek, Junction Creek, La Plata Canyon, Smelter Mountain, Horse Gulch)

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

// Dashboard
app.get('/dashboard', (req, res) => {
  const snapshots = db.prepare(`SELECT * FROM daily_snapshots ORDER BY date DESC LIMIT 30`).all();
  const prescriptions = db.prepare(`SELECT * FROM prescriptions ORDER BY date DESC LIMIT 30`).all();
  const today = prescriptions[0];
  const todayPrescription = today ? JSON.parse(today.full_response || '{}') : null;
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Coach Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#e8e8e8;margin:0;padding:16px;max-width:900px;margin:0 auto}
h1{color:#4ade80;font-size:1.4em;margin:8px 0 16px}
h2{color:#60a5fa;font-size:1.1em;margin:24px 0 8px;border-bottom:1px solid #333;padding-bottom:4px}
.card{background:#1a1a1a;border-radius:12px;padding:16px;margin:8px 0}
.recovery{font-size:2em;font-weight:bold}
.green{color:#4ade80}.yellow{color:#facc15}.red{color:#f87171}
.label{color:#888;font-size:0.85em}.val{font-size:1.1em;margin-bottom:8px}
table{width:100%;border-collapse:collapse;font-size:0.85em}
td,th{padding:6px;text-align:left;border-bottom:1px solid #222}
pre{white-space:pre-wrap;word-break:break-word;font-size:0.85em;background:#0f0f0f;padding:12px;border-radius:8px}
</style></head><body>
<h1>🚴 Coach Dashboard</h1>
${today ? `
<div class="card">
  <div class="label">${today.date} — ${todayPrescription?.headline || ''}</div>
  <pre>${JSON.stringify(todayPrescription, null, 2)}</pre>
</div>` : '<div class="card">No prescriptions yet. Hit POST /run.</div>'}
<h2>Recent Snapshots</h2>
<table><tr><th>Date</th><th>Recovery</th><th>HRV</th><th>RHR</th><th>Sleep hr</th><th>Deep min</th><th>Yest Strain</th><th>AC</th></tr>
${snapshots.map(s => `<tr>
<td>${s.date}</td>
<td class="${s.recovery_pct >= 67 ? 'green' : s.recovery_pct >= 34 ? 'yellow' : 'red'}">${s.recovery_pct || '-'}</td>
<td>${s.hrv?.toFixed?.(0) || '-'}</td><td>${s.rhr || '-'}</td>
<td>${s.sleep_hours?.toFixed?.(1) || '-'}</td><td>${s.deep_sleep_min || '-'}</td>
<td>${s.yesterday_strain?.toFixed?.(1) || '-'}</td><td>${s.acute_chronic_ratio || '-'}</td>
</tr>`).join('')}
</table>
<h2>Recent Prescriptions</h2>
${prescriptions.slice(0, 7).map(p => {
  const fr = JSON.parse(p.full_response || '{}');
  return `<div class="card">
    <div class="label">${p.date}</div>
    <div class="val"><b>${fr.headline || p.workout_type}</b></div>
    <div>${fr.workout?.specific_workout || ''}</div>
  </div>`;
}).join('')}
</body></html>`);
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
