// Settings live in users/{uid}/meta/settings. The PC guardian reads the same document
// (helper/settings.py mirrors effectiveGaming / isLooser — keep them in sync).
export const DEFAULTS = {
  dayStartsAtHour: 4,
  // Used for personal targets (Plan page). Weight/resting HR/VO2 max from the watch override these when present.
  profile: { birthYear: null, weightKg: null, goal: 'recomp' },
  // autoNewCards: new words/day are sized so the long-run daily load fits minutesPerDay (korean.js newQuota).
  korean: { minutesPerDay: 40, autoNewCards: true, newCardsPerDay: 10, desiredRetention: 0.9, unlockTypingAfterDays: 7 },
  workout: {
    schedule: { mon: 'gym', tue: 'rest', wed: 'home', thu: 'rest', fri: 'gym', sat: 'home', sun: 'rest' },
    homeEquipment: [], units: 'lb', restCompound: 150, restAccessory: 90, restSuperset: 60,
  },
  // stepGoalAuto: weekly goal ramps from your own baseline toward the target for your goal (targets.js).
  activity: { stepGoalAuto: true, stepGoal: 8000, restDayStepGoal: 0, watchWorkoutCounts: true, watchWorkoutMinMinutes: 20 },
  // PC nudge to get up after this long at the desk; resets when the PC sees no input for awayMinutes.
  // treadmill: there's a treadmill under the desk, so the nudge says "walk while you work" and pauses for walkMinutes.
  moveBreaks: { enabled: true, everyMinutes: 30, awayMinutes: 3, snoozeMinutes: 15, treadmill: false, walkMinutes: 15 },
  gaming: {
    requireWorkout: true, countMinimumWorkout: true, requireKoreanReviews: true, requireKoreanNewCards: true,
    // 0 = no limit (session choices, daily caps, set interval).
    sessionChoices: [0, 30, 60, 90, 120], dailyCapWeekday: 0, dailyCapWeekend: 0, cooldownMinutes: 0,
    // A short set (push/pull + legs) every setEveryMinutes of play; setsRequired closes the game when one is overdue.
    // setMenu: your own sets ([[{name, reps, note}], ...], alternating); empty = sized from your home-workout levels.
    setEveryMinutes: 30, setsRequired: true, setMinSeconds: 30, setMenu: [],
    // Dinner break (web/js/dinner.js): once a day, starting between dinnerFrom and dinnerTo (local hours), sets wait
    // dinnerMinutes while you eat, and play during it doesn't count toward the next set. 0 = off.
    dinnerMinutes: 45, dinnerFrom: 18, dinnerTo: 21,
    warnAtMinutes: [10, 2], graceSeconds: 60,
    overrideWaitSeconds: 60, overrideMinReasonChars: 25, overrideMaxPerDay: 1, overrideExtendMinutes: 15,
  },
};

export function withDefaults(saved = {}) {
  const out = structuredClone(DEFAULTS);
  for (const [k, v] of Object.entries(saved || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') out[k] = { ...out[k], ...v };
    else out[k] = v;
  }
  return out;
}

/** Gaming rules in force today: loosened limits only apply from the day after they were changed. */
export function effectiveGaming(settings, today) {
  const p = settings.gamingPending;
  return p && today >= p.effective ? { ...settings.gaming, ...p.values } : settings.gaming;
}

const noLimit = x => (x > 0 ? x : Infinity);   // 0 means "no limit"
const MORE_IS_LOOSER = ['graceSeconds', 'overrideMaxPerDay', 'overrideExtendMinutes', 'dinnerMinutes', 'dinnerTo'];
const LIMITS = ['dailyCapWeekday', 'dailyCapWeekend', 'setEveryMinutes'];
const LESS_IS_LOOSER = ['cooldownMinutes', 'overrideWaitSeconds', 'overrideMinReasonChars', 'setMinSeconds', 'dinnerFrom'];
const OFF_IS_LOOSER = ['requireWorkout', 'requireKoreanReviews', 'requireKoreanNewCards', 'setsRequired'];

export function isLooser(old, next) {
  if (MORE_IS_LOOSER.some(k => next[k] > old[k])) return true;
  if (LIMITS.some(k => noLimit(next[k]) > noLimit(old[k]))) return true;
  if (LESS_IS_LOOSER.some(k => next[k] < old[k])) return true;
  if (OFF_IS_LOOSER.some(k => old[k] && !next[k])) return true;
  if (!old.countMinimumWorkout && next.countMinimumWorkout) return true;
  return Math.max(...next.sessionChoices.map(noLimit)) > Math.max(...old.sessionChoices.map(noLimit));
}

export const sessionLabel = m => (m > 0 ? `${m} min` : 'No limit');

/**
 * A change that tightens the rules applies now. A change that loosens them is stored as pending until tomorrow,
 * so the decision is made in a cool moment rather than in the middle of wanting to play.
 */
export function gamingChange(settings, next, today, tomorrow) {
  const current = effectiveGaming(settings, today);
  if (isLooser(current, next)) return { patch: { gaming: current, gamingPending: { values: next, effective: tomorrow } }, delayed: true };
  return { patch: { gaming: next, gamingPending: null }, delayed: false };
}
