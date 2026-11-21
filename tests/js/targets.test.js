import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepTarget, stepWeek, protein, lossRate, bodyNow, monday } from '../../web/js/targets.js';
import { koreanPlan } from '../../web/js/korean.js';
import { setPlan, setText } from '../../web/js/workout.js';
import { verifySet } from '../../web/js/activity.js';
import { withDefaults, isLooser, DEFAULTS } from '../../web/js/settings.js';
import { addDays } from '../../web/js/time.js';

const MON = '2026-11-23';   // a Monday

test('step target depends on the goal and age', () => {
  assert.equal(stepTarget({ goal: 'recomp' }, MON).steps, 10000);
  assert.equal(stepTarget({ goal: 'health', birthYear: 1990 }, MON).steps, 8000);
  assert.equal(stepTarget({ goal: 'health', birthYear: 1960 }, MON).steps, 7000);
  assert.equal(monday('2026-11-29'), MON);
});

test('weekly step goal starts above baseline, climbs when hit, eases off when missed', () => {
  const steps = {};
  for (let i = 1; i <= 6; i++) steps[addDays(MON, -i)] = 4000 + i * 100;     // a sedentary week, median ~4,400
  let st = stepWeek(null, steps, 10000, MON);
  assert.equal(st.goal, 5500);                                              // baseline + 1,000, rounded to 500
  assert.equal(stepWeek(st, steps, 10000, addDays(MON, 3)).goal, 5500);      // same week: unchanged
  for (let i = 0; i < 7; i++) steps[addDays(MON, i)] = i < 5 ? 6000 : 3000; // hit on 5 days
  st = stepWeek(st, steps, 10000, addDays(MON, 7));
  assert.deepEqual([st.goal, st.change, st.lastWeek], [6500, 'up', { hit: 5, days: 7 }]);
  for (let i = 7; i < 14; i++) steps[addDays(MON, i)] = 3000;               // missed every day
  st = stepWeek(st, steps, 10000, addDays(MON, 14));
  assert.deepEqual([st.goal, st.change], [6000, 'down']);
  assert.equal(stepWeek({ ...st, weekStart: addDays(MON, 14) }, steps, 5000, addDays(MON, 15)).goal, 5000);  // never above target
  assert.equal(stepWeek(null, { [addDays(MON, -1)]: 5000 }, 10000, MON).goal, null);                     // still measuring
});

test('protein and weight-loss targets scale with body weight', () => {
  assert.deepEqual(protein(80, 'recomp'), { low: 130, high: 175, perKg: [1.6, 2.2] });
  const loss = lossRate(80, 'recomp');
  assert.ok(Math.abs(loss.highKg - 0.56) < 1e-9 && Math.abs(loss.lowKg - 0.2) < 1e-9);
  assert.equal(lossRate(80, 'muscle'), null);
  const now = Date.parse('2026-11-21T12:00:00Z');
  const b = bodyNow({ weightKg: 90 }, { weightKg: [84.2, now - 864e5], restingHr: [61, now - 40 * 864e5] }, now);
  assert.deepEqual([b.weightKg, b.weightFrom, b.restingHr], [84.2, 'watch', null]);   // stale resting HR is ignored
});

test('Korean new words fit the daily minutes, using measured speed when there is enough', () => {
  const korean = withDefaults().korean;                      // 40 min, 90% recall
  let k = koreanPlan([], korean, 0);
  assert.deepEqual([k.steady, k.newPerDay, k.measured.read], [10, 10, false]);
  k = koreanPlan([], { ...korean, minutesPerDay: 15 }, 0);
  assert.equal(k.steady, 4);
  k = koreanPlan([], korean, 300);                           // big backlog: reviews first
  assert.equal(k.newPerDay, 0);
  const fast = Array.from({ length: 20 }, (_, i) => ({ card: `x${i}_r`, ms: 4000, isNew: false }));
  k = koreanPlan(fast, korean, 0);
  assert.deepEqual([k.secRead, k.measured.read], [4, true]);
  assert.ok(k.steady > 10);
});

test('sets during play follow workout levels and equipment', () => {
  const s = withDefaults({ workout: { homeEquipment: [] } });
  const [a, b] = setPlan(s, {});
  assert.equal(setText(a), '6 × Push-up + 15 × Bodyweight squat');
  assert.equal(b[0].name, 'Pike push-up (hips high)');
  const bar = setPlan(withDefaults({ workout: { homeEquipment: ['pullup_bar', 'dumbbells'] } }),
    { 'home.push': { level: 5 }, 'home.squat': { level: 3 } });
  assert.equal(setText(bar[0]), '6 × Diamond push-up + 8 × Bulgarian split squat (rear foot on chair) (each leg)');
  assert.match(bar[1][0].name, /pull-up/i);
  assert.equal(bar[1][1].name, 'Glute bridge');                // bodyweight hinge even with dumbbells
});

test('the watch confirms a set by a heart-rate rise', () => {
  const at = new Date(2026, 10, 21, 20, 30).getTime();
  const doc = { hr: {} };
  for (let m = 0; m < 30; m++) {
    const t = new Date(at - (25 - m) * 60e3);
    const key = 'm' + String(t.getHours()).padStart(2, '0') + String(t.getMinutes()).padStart(2, '0');
    doc.hr[key] = m >= 22 && m <= 25 ? [100, 90, 118] : [72, 68, 76];
  }
  const day = { '2026-11-21': doc };
  assert.deepEqual([verifySet(day, at).status, verifySet(day, at).rise], ['ok', 46]);
  for (const k of Object.keys(doc.hr)) doc.hr[k] = [72, 68, 76];
  assert.equal(verifySet(day, at).status, 'low');
  assert.equal(verifySet({}, at).status, 'nodata');
});

test('no daily cap and sets: dropping or easing them waits until tomorrow', () => {
  const g = DEFAULTS.gaming;
  assert.equal(g.dailyCapWeekday, 0);
  assert.ok(isLooser({ ...g, dailyCapWeekday: 120 }, g));            // removing a cap is looser
  assert.ok(!isLooser(g, { ...g, dailyCapWeekday: 120 }));           // adding one is tighter
  assert.ok(isLooser(g, { ...g, setEveryMinutes: 45 }));
  assert.ok(isLooser(g, { ...g, setEveryMinutes: 0 }));              // switching sets off
  assert.ok(!isLooser(g, { ...g, setEveryMinutes: 20 }));
  assert.ok(isLooser(g, { ...g, setsRequired: false }));
  assert.ok(isLooser({ ...g, sessionChoices: [30, 60] }, g));        // allowing "no limit" sessions
});
