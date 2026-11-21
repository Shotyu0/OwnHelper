// Workout planning, logging and progression. Workouts live in users/{uid}/workouts/{id}:
//   {day, location, template, status: in_progress|done|minimum, startedAt, finishedAt, sets: [{slot, exercise, reps, weight, at}]}
// Progress per exercise slot lives in exerciseState/{slot}: {level, weight, stalls, lastChange}.
import { addDays, weekdayKey } from './time.js';
import { template, TEMPLATE_TITLES } from './workout-lib.js';

export { TEMPLATE_TITLES };

export const scheduled = (settings, day) => settings.workout.schedule[weekdayKey(day)] || 'rest';

export function nextTemplate(location, lastGymTemplate) {
  if (location === 'home') return 'home';
  return lastGymTemplate === 'gym_a' ? 'gym_b' : 'gym_a';
}

export function plan(workout, settings, states) {
  const w = settings.workout;
  return template(workout.template, w.homeEquipment).map(s => {
    const st = states[s.key];
    const level = st && s.ladder.length ? Math.min(st.level || 0, s.ladder.length - 1) : 0;
    return {
      ...s, level, weighted: !s.ladder.length,
      exerciseName: s.ladder.length ? s.ladder[level] : s.exercise,
      weight: st?.weight ?? null, lastChange: st?.lastChange || '',
      rest: s.compound ? w.restCompound : w.restAccessory,
      logged: (workout.sets || []).filter(x => x.slot === s.key),
    };
  });
}

const mostCommon = list => {
  const n = new Map();
  for (const x of list) n.set(x, (n.get(x) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0][0];
};

/** Double progression for one slot. Returns the new state and a note for next time. */
export function progress(s, sets, state, units) {
  let stalls = state?.stalls || 0;
  const reps = sets.map(x => x.reps);
  const hitTop = reps.length >= s.sets && reps.every(r => r >= s.reps[1]);
  const missed = reps.some(r => r < s.reps[0]);
  let msg = '';
  if (!s.ladder.length) {
    const weights = sets.map(x => x.weight).filter(x => x != null);
    if (!weights.length) return null;
    let weight = mostCommon(weights);
    const inc = s.inc[units === 'kg' ? 1 : 0];
    if (hitTop) { weight += inc; stalls = 0; msg = `All sets hit ${s.reps[1]} reps → next time ${weight} ${units}`; }
    else if (missed && ++stalls >= 2) {
      weight = Math.max(inc, Math.floor((weight * 0.9) / inc) * inc); stalls = 0;
      msg = `Missed the rep range twice → deload to ${weight} ${units} and build back up`;
    }
    return { level: 0, weight, stalls, lastChange: msg };
  }
  const name = mostCommon(sets.map(x => x.exercise));
  let level = s.ladder.includes(name) ? s.ladder.indexOf(name) : (state?.level || 0);
  if (hitTop) {
    stalls = 0;
    if (level < s.ladder.length - 1) msg = `Level up → ${s.ladder[++level]}`;
    else msg = 'Top of the ladder — add a 3-second lowering phase or a pause to keep progressing';
  } else if (missed && ++stalls >= 2 && level > 0) {
    level -= 1; stalls = 0;
    msg = `Step back to ${s.ladder[level]} for a bit — rebuild reps, then move up again`;
  }
  return { level, weight: null, stalls, lastChange: msg };
}

/** Apply progression for a finished workout. Returns {states: {slot: state}, notes: [..]} to save. */
export function finishWorkout(workout, settings, states, minimum) {
  const out = { states: {}, notes: [] };
  if (minimum) return out;
  for (const s of template(workout.template, settings.workout.homeEquipment)) {
    const sets = (workout.sets || []).filter(x => x.slot === s.key);
    if (!sets.length) continue;
    const st = progress(s, sets, states[s.key], settings.workout.units);
    if (!st) continue;
    out.states[s.key] = st;
    if (st.lastChange) out.notes.push(`${s.title}: ${st.lastChange}`);
  }
  return out;
}

/** Consecutive scheduled sessions completed. Rest days don't break it; today counts once it's done. */
export function streak(doneDays, settings, today, startedOn) {
  let n = 0, day = doneDays.has(today) ? today : addDays(today, -1), missedLast = false;
  while (day >= startedOn) {
    const isDone = doneDays.has(day);
    if (scheduled(settings, day) !== 'rest' || isDone) {
      if (isDone) n++;
      else { missedLast = n === 0; break; }
    }
    day = addDays(day, -1);
  }
  return { streak: n, missedLast };
}

export function consistency(doneDays, settings, today, startedOn, days = 28) {
  let planned = 0, hit = 0;
  for (let i = 1; i <= days; i++) {
    const d = addDays(today, -i);
    if (d >= startedOn && scheduled(settings, d) !== 'rest') { planned++; if (doneDays.has(d)) hit++; }
  }
  return { planned, hit, pct: planned ? hit / planned : null };
}

/** A watch-recorded session counts as a workout if it's long enough and not just a walk (walks count as steps).
 *  Mirrored in helper/gaming/rules.py. */
export const watchCounts = (x, a) => !!a.watchWorkoutCounts && x.dur >= a.watchWorkoutMinMinutes * 60 && !/walk/i.test(x.type || '');

/** Workout gate input: did today's training happen (app-logged or watch-recorded)? */
export function workoutStatus({ settings, today, workouts, watchSessions }) {
  const sched = scheduled(settings, today);
  const g = settings.gaming;
  const statuses = new Set(workouts.map(w => w.status));
  let doneAs = statuses.has('done') ? 'done' : (statuses.has('minimum') && g.countMinimumWorkout ? 'minimum' : null);
  const watch = watchSessions.find(x => watchCounts(x, settings.activity)) || null;
  if (!doneAs && watch) doneAs = 'watch';
  return { scheduled: sched, doneAs, done: !!doneAs, watch, satisfied: !!doneAs || sched === 'rest' };
}

// ------------------------------------------------------------------------------------------- sets during play
// Every setEveryMinutes of gaming you stand up for one short set: an upper-body move + a leg move, at your current
// home-workout level and ~70% of the bottom of its rep range, so it stays well short of failure. Spread-out
// "exercise snacks" add weekly volume (what drives muscle growth) without wrecking recovery, and they break up sitting.
const DEFAULT_LEVEL = { 'home.push': 3, 'home.pull': 1, 'home.vpush': 0, 'home.squat': 1, 'home.hinge': 0 };

export function setPlan(settings, states = {}) {
  const eq = settings.workout.homeEquipment || [];
  // Bodyweight ladders only (no dumbbells mid-game); the pull-up bar decides the pull ladder.
  const slots = Object.fromEntries(template('home', eq.filter(x => x === 'pullup_bar')).map(s => [s.key, s]));
  const at = key => {
    const s = slots[key];
    const lvl = Math.min(states[key] ? states[key].level || 0 : DEFAULT_LEVEL[key] ?? 0, s.ladder.length - 1);
    return { s, lvl, name: s.ladder[lvl] };
  };
  const upper = key => { const x = at(key); return { name: x.name, reps: Math.max(3, Math.ceil(x.s.reps[0] * 0.7)) }; };
  const squat = () => {
    const x = at('home.squat');
    return x.lvl <= 1 ? { name: x.name, reps: 15 } : { name: x.name, reps: x.lvl >= 5 ? 4 : 8, note: 'each leg' };
  };
  const hinge = () => {
    const x = at('home.hinge');
    if (x.lvl === 0) return { name: x.name, reps: 15 };
    return x.lvl === x.s.ladder.length - 1 ? { name: x.name, reps: 3 } : { name: x.name, reps: 8, note: 'each leg' };
  };
  return [
    [upper('home.push'), squat()],
    [eq.includes('pullup_bar') ? upper('home.pull') : upper('home.vpush'), hinge()],
  ];
}

export const setText = items => (items || []).map(i => `${i.reps} × ${i.name}${i.note ? ` (${i.note})` : ''}`).join(' + ');

/** Keeps meta/setPlan (read by the PC guardian) in step with your workout levels and equipment. */
export async function syncSetPlan(store, settings) {
  const states = Object.fromEntries((await store.query('exerciseState')).map(s => [s.id, s]));
  const variants = setPlan(settings, states);
  const sig = JSON.stringify(variants);
  const cur = await store.get('meta', 'setPlan');
  if (cur?.sig !== sig) store.set('meta', 'setPlan', { variants, sig, at: Date.now() });
  return variants;
}
