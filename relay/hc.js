// Turns an HC Webhook payload (github.com/mcnaveen/health-connect-webhook, docs/webhook.md) into
// Firestore writes. Pure, so it can be tested without a network.
//
// users/{uid}/activity/{YYYY-MM-DD}   one doc per calendar day on the phone, maps keyed so re-sent data overwrites:
//   steps.<key>  {c: count, s: start ms, e: end ms, o: source app}   key r_<record id> (raw) or a_<start> (aggregate)
//   cal.<key>    {c: kcal, s, e, o}
//   dist.<key>   {c: meters, s, e, o}
//   hr.m<HHMM>   [avg, min, max] bpm for that minute
//   body.<field> [value, ms] latest reading that day: weightKg, bodyFat (%), restingHr, vo2max, heightM
// users/{uid}/meta/body               {<field>: [value, ms]} latest reading overall (worker.js merges by time)
// users/{uid}/exercises/{id}          {type, start, end, dur (s), steps, dist, o, day}
//
// Records can be re-sent (edits, retries); keys make every write idempotent.

const san = s => String(s).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 120);

/** Local calendar date and HHMM for an ISO timestamp, in the phone's time zone. */
export function localParts(iso, tz) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  if (tz) {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
      return { t, day: `${p.year}-${p.month}-${p.day}`, hm: p.hour + p.minute };
    } catch (_) { /* unknown zone: fall through */ }
  }
  // "2026-05-09T18:04:56.789+05:30" already carries local wall time; "...Z" is UTC.
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m ? { t, day: m[1], hm: m[2] + m[3] } : null;
}

const origin = r => r?.metadata?.data_origin || '';

function intervalRecords(list, valueOf, tz, field, put) {
  for (const r of list || []) {
    const p = localParts(r.start_time, tz);
    const v = valueOf(r);
    if (!p || v == null || Number.isNaN(+v)) continue;
    const key = r.metadata?.id ? 'r_' + san(r.metadata.id) : 'a_' + san(r.start_time);
    put(p.day, `${field}.${key}`, { c: +v, s: p.t, e: Date.parse(r.end_time) || p.t, o: origin(r) });
  }
}

// HC Webhook array -> our field, value getter.
const BODY = [
  ['weight', 'weightKg', r => r.kilograms], ['body_fat', 'bodyFat', r => r.percentage],
  ['resting_heart_rate', 'restingHr', r => r.bpm], ['vo2_max', 'vo2max', r => r.ml_per_kg_per_min],
  ['height', 'heightM', r => r.meters],
];

export function transform(payload) {
  const tz = payload.timezone && payload.timezone !== 'UTC' ? payload.timezone : null;
  const days = new Map();   // day -> Map(fieldPath -> value)
  const put = (day, path, v) => {
    if (!days.has(day)) days.set(day, new Map());
    days.get(day).set(path, v);
  };

  intervalRecords(payload.steps, r => r.count, tz, 'steps', put);
  intervalRecords(payload.active_calories, r => r.calories, tz, 'cal', put);
  intervalRecords(payload.distance, r => r.meters, tz, 'dist', put);

  const hrMinutes = new Map();  // day|hm -> [sum, n, min, max]
  for (const r of payload.heart_rate || []) {
    const p = localParts(r.time, tz);
    if (!p) continue;
    const avg = r.avg ?? r.bpm, min = r.min ?? r.bpm, max = r.max ?? r.bpm;
    if (avg == null) continue;
    const k = p.day + '|' + p.hm;
    const cur = hrMinutes.get(k) || [0, 0, Infinity, -Infinity];
    hrMinutes.set(k, [cur[0] + avg, cur[1] + 1, Math.min(cur[2], min), Math.max(cur[3], max)]);
  }
  for (const [k, [sum, n, min, max]] of hrMinutes) {
    const [day, hm] = k.split('|');
    put(day, `hr.m${hm}`, [Math.round(sum / n), Math.round(min), Math.round(max)]);
  }

  const body = {};   // field -> [value, ms], latest in this payload
  for (const [src, field, get] of BODY) {
    for (const r of payload[src] || []) {
      const p = localParts(r.time, tz), v = get(r);
      if (!p || v == null || Number.isNaN(+v)) continue;
      const val = [Math.round(+v * 100) / 100, p.t];
      const path = `body.${field}`, cur = days.get(p.day)?.get(path);
      if (!cur || cur[1] < p.t) put(p.day, path, val);
      if (!body[field] || body[field][1] < p.t) body[field] = val;
    }
  }

  const exercises = [];
  for (const r of payload.exercise || []) {
    const p = localParts(r.start_time, tz);
    if (!p) continue;
    const end = Date.parse(r.end_time) || p.t;
    exercises.push({
      id: r.metadata?.id ? 'r_' + san(r.metadata.id) : 'a_' + san(r.start_time),
      data: {
        type: String(r.type ?? r.exercise_type ?? 'exercise'), start: p.t, end, day: p.day,
        dur: r.duration_seconds ?? Math.round((end - p.t) / 1000),
        steps: r.steps ?? null, dist: r.distance_meters ?? null, o: origin(r),
      },
    });
  }
  const deletedExercises = (payload.deleted || []).filter(d => d.type === 'exercise' && d.id).map(d => 'r_' + san(d.id));
  return { days, exercises, deletedExercises, body };
}

// ------------------------------------------------------------------------- Firestore REST encoding
export function plain(v) {
  if (!v || 'nullValue' in v) return null;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(plain);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, plain(x)]));
  return null;
}

/** meta/body update with the readings that are newer than what's stored (stored: plain object or null). */
export function bodyWrite(docsRoot, stored, latest) {
  const fresh = Object.fromEntries(Object.entries(latest || {}).filter(([k, v]) => !(stored?.[k]?.[1] >= v[1])));
  if (!Object.keys(fresh).length) return null;
  return { update: { name: `${docsRoot}/meta/body`, fields: value(fresh).mapValue.fields }, updateMask: { fieldPaths: Object.keys(fresh) } };
}

/** daily/{day} summary (what the dashboard heatmaps read), recomputed from the full activity doc. */
export function dailyWrite(docsRoot, day, summary) {
  const data = { day, ...summary };
  return { update: { name: `${docsRoot}/daily/${day}`, fields: value(data).mapValue.fields }, updateMask: { fieldPaths: Object.keys(data) } };
}

export function value(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(value) } };
  if (typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, value(v)])) } };
  return { stringValue: String(x) };
}

/** Firestore :commit writes. Day docs are merged field-by-field (updateMask), so nothing already stored is lost. */
export function writes(result, docsRoot, now) {
  const out = [];
  for (const [day, fields] of result.days) {
    const nested = { updatedAt: now };
    for (const [path, v] of fields) {
      const [group, key] = path.split('.');
      (nested[group] ||= {})[key] = v;
    }
    out.push({
      update: { name: `${docsRoot}/activity/${day}`, fields: value(nested).mapValue.fields },
      updateMask: { fieldPaths: ['updatedAt', ...fields.keys()] },
    });
  }
  for (const x of result.exercises) out.push({ update: { name: `${docsRoot}/exercises/${x.id}`, fields: value(x.data).mapValue.fields } });
  for (const id of result.deletedExercises) out.push({ delete: `${docsRoot}/exercises/${id}` });
  return out;
}
