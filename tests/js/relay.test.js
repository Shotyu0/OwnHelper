import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transform, writes, localParts, plain, value, dailyWrite } from '../../relay/hc.js';
import { sumIntervals, summarize, heartDuring, exerciseName } from '../../web/js/activity.js';

// Shapes from HC Webhook's docs/webhook.md (UTC timestamps + phone time zone).
const payload = {
  timestamp: '2026-11-21T14:00:00.123Z', app_version: '1.9.32', timezone: 'America/New_York',
  steps: [
    { count: 1200, start_time: '2026-11-21T13:00:00Z', end_time: '2026-11-21T13:30:00Z', metadata: { id: 'abc-1', data_origin: 'com.sec.android.app.shealth' } },
    { count: 1100, start_time: '2026-11-21T13:00:00Z', end_time: '2026-11-21T13:30:00Z', metadata: { id: 'xyz-2', data_origin: 'com.google.android.apps.fitness' } },
    { count: 300, start_time: '2026-11-21T04:30:00Z', end_time: '2026-11-21T04:40:00Z', metadata: { id: 'late-night', data_origin: 'com.sec.android.app.shealth' } },
  ],
  heart_rate: [
    { time: '2026-11-21T13:05:00Z', avg: 120, min: 110, max: 131, bpm: 120 },
    { bpm: 72, time: '2026-11-21T13:06:10Z' }, { bpm: 76, time: '2026-11-21T13:06:40Z' },
  ],
  exercise: [{ type: 'strength_training', start_time: '2026-11-21T13:00:00Z', end_time: '2026-11-21T13:45:00Z', duration_seconds: 2700, metadata: { id: 'ex-1', data_origin: 'com.sec.android.app.shealth' } }],
  deleted: [{ type: 'exercise', id: 'old-ex' }, { type: 'steps', id: 'ignored' }],
};

test('timestamps land on the phone\'s local day', () => {
  assert.deepEqual(localParts('2026-11-21T04:30:00Z', 'America/New_York').day, '2026-11-20');   // 11:30pm the day before
  assert.equal(localParts('2026-11-21T13:05:00Z', 'America/New_York').hm, '0805');
  assert.deepEqual([localParts('2026-05-09T18:04:56.789+05:30').day, localParts('2026-05-09T18:04:56.789+05:30').hm], ['2026-05-09', '1804']);
  assert.equal(localParts('nope'), null);
});

test('transform groups records by day with idempotent keys', () => {
  const r = transform(payload);
  assert.deepEqual([...r.days.keys()].sort(), ['2026-11-20', '2026-11-21']);
  const d = r.days.get('2026-11-21');
  assert.deepEqual(d.get('steps.r_abc_1'), { c: 1200, s: Date.parse('2026-11-21T13:00:00Z'), e: Date.parse('2026-11-21T13:30:00Z'), o: 'com.sec.android.app.shealth' });
  assert.deepEqual(d.get('hr.m0805'), [120, 110, 131]);
  assert.deepEqual(d.get('hr.m0806'), [74, 72, 76]);     // two samples in one minute merge
  assert.equal(r.exercises[0].id, 'r_ex_1');
  assert.equal(r.exercises[0].data.dur, 2700);
  assert.deepEqual(r.deletedExercises, ['r_old_ex']);
  // re-sending the same payload produces the same writes
  assert.deepEqual(JSON.stringify(writes(transform(payload), 'R', 1)), JSON.stringify(writes(r, 'R', 1)));
});

test('Firestore writes merge fields instead of replacing the day', () => {
  const w = writes(transform(payload), 'projects/p/databases/(default)/documents/users/u', 99);
  const day = w.find(x => x.update?.name.endsWith('/activity/2026-11-21'));
  assert.ok(day.updateMask.fieldPaths.includes('steps.r_abc_1'));
  assert.ok(day.updateMask.fieldPaths.includes('updatedAt'));
  assert.equal(day.update.fields.steps.mapValue.fields.r_abc_1.mapValue.fields.c.integerValue, '1200');
  assert.ok(w.some(x => x.delete?.endsWith('/exercises/r_old_ex')));
  assert.deepEqual(plain(value({ a: [1, 2.5, 'x', null, true], b: { c: 3 } })), { a: [1, 2.5, 'x', null, true], b: { c: 3 } });
  assert.deepEqual(dailyWrite('R', '2026-11-21', { steps: 5 }).updateMask.fieldPaths, ['day', 'steps']);
});

test('steps from two apps are not double counted; aggregates win', () => {
  const doc = { steps: Object.fromEntries([...transform(payload).days.get('2026-11-21')].filter(([k]) => k.startsWith('steps.')).map(([k, v]) => [k.slice(6), v])) };
  assert.equal(sumIntervals(doc.steps), 1200);   // Samsung 1200 vs Google 1100 for the same half hour -> 1200
  const agg = { a_1: { c: 5000, s: 0, e: 100 }, a_2: { c: 3000, s: 50, e: 150 }, a_3: { c: 1000, s: 100, e: 200 }, r_x: { c: 9999, s: 0, e: 1, o: 'x' } };
  assert.equal(sumIntervals(agg), 6000);         // overlapping bucket skipped, raw ignored when aggregates exist
  const s = summarize({ steps: doc.steps, hr: { m0805: [120, 110, 131], m0300: [55, 52, 58] } }, [{ dur: 2700 }]);
  assert.equal(s.restingHr, 52); assert.equal(s.activeMinutes, 45);
});

test('heart rate during a workout window', () => {
  const start = new Date(2026, 10, 21, 8, 4).getTime(), end = new Date(2026, 10, 21, 8, 7).getTime();
  const docs = { '2026-11-21': { hr: { m0805: [120, 110, 131], m0806: [74, 72, 76], m0900: [60, 60, 60] } } };
  assert.deepEqual({ ...heartDuring(docs, start, end), points: undefined }, { avg: 97, max: 131, points: undefined });
  assert.equal(heartDuring({}, start, end), null);
  assert.equal(exerciseName('STRENGTH_TRAINING'), 'Strength training');
  assert.equal(exerciseName('exercise_type_rowing_machine'), 'Rowing machine');
});

test('body readings: latest per day in activity, newer-only into meta/body', async () => {
  const { bodyWrite } = await import('../../relay/hc.js');
  const r = transform({
    timezone: 'America/New_York',
    weight: [{ kilograms: 84.31, time: '2026-11-21T12:00:00Z' }, { kilograms: 84.0, time: '2026-11-21T23:00:00Z' }],
    resting_heart_rate: [{ bpm: 58, time: '2026-11-21T09:00:00Z' }],
    vo2_max: [{ ml_per_kg_per_min: 41.2, time: '2026-11-20T15:00:00Z' }],
  });
  assert.deepEqual(r.days.get('2026-11-21').get('body.weightKg'), [84, Date.parse('2026-11-21T23:00:00Z')]);
  assert.deepEqual(r.days.get('2026-11-20').get('body.vo2max'), [41.2, Date.parse('2026-11-20T15:00:00Z')]);
  assert.deepEqual(Object.keys(r.body).sort(), ['restingHr', 'vo2max', 'weightKg']);
  const root = 'projects/p/databases/(default)/documents/users/u';
  const stored = { weightKg: [85, Date.parse('2026-11-22T08:00:00Z')], restingHr: [60, 0] };
  const w = bodyWrite(root, stored, r.body);
  assert.deepEqual(w.updateMask.fieldPaths.sort(), ['restingHr', 'vo2max']);   // stored weight is newer: kept
  assert.equal(bodyWrite(root, { ...stored, ...r.body }, r.body), null);
});
