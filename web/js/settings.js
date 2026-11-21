// Settings live in users/{uid}/meta/settings. The PC guardian reads the same document
// (helper/settings.py mirrors effectiveGaming / isLooser — keep them in sync).
export const DEFAULTS = {
  dayStartsAtHour: 4,
  korean: { newCardsPerDay: 10, desiredRetention: 0.9, unlockTypingAfterDays: 7 },
  workout: {
    schedule: { mon: 'gym', tue: 'rest', wed: 'home', thu: 'rest', fri: 'gym', sat: 'home', sun: 'rest' },
    homeEquipment: [], units: 'lb', restCompound: 150, restAccessory: 90,
  },
  activity: { stepGoal: 7000, restDayStepGoal: 0, watchWorkoutCounts: true, watchWorkoutMinMinutes: 20 },
  gaming: {
    requireWorkout: true, countMinimumWorkout: true, requireKoreanReviews: true, requireKoreanNewCards: true,
    sessionChoices: [30, 45, 60, 90], dailyCapWeekday: 120, dailyCapWeekend: 180, cooldownMinutes: 45,
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

const MORE_IS_LOOSER = ['dailyCapWeekday', 'dailyCapWeekend', 'graceSeconds', 'overrideMaxPerDay', 'overrideExtendMinutes'];
const LESS_IS_LOOSER = ['cooldownMinutes', 'overrideWaitSeconds', 'overrideMinReasonChars'];
const OFF_IS_LOOSER = ['requireWorkout', 'requireKoreanReviews', 'requireKoreanNewCards'];

export function isLooser(old, next) {
  if (MORE_IS_LOOSER.some(k => next[k] > old[k])) return true;
  if (LESS_IS_LOOSER.some(k => next[k] < old[k])) return true;
  if (OFF_IS_LOOSER.some(k => old[k] && !next[k])) return true;
  if (!old.countMinimumWorkout && next.countMinimumWorkout) return true;
  return Math.max(...next.sessionChoices) > Math.max(...old.sessionChoices);
}

/**
 * A change that tightens the rules applies now. A change that loosens them is stored as pending until tomorrow,
 * so the decision is made in a cool moment rather than in the middle of wanting to play.
 */
export function gamingChange(settings, next, today, tomorrow) {
  const current = effectiveGaming(settings, today);
  if (isLooser(current, next)) return { patch: { gaming: current, gamingPending: { values: next, effective: tomorrow } }, delayed: true };
  return { patch: { gaming: next, gamingPending: null }, delayed: false };
}
