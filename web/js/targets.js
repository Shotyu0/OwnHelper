// Personal targets: what the research supports, adjusted to your profile and to your own data.
// Shown with their reasons on the Plan page; the step goal also drives Today and Activity.
import { addDays, parseDay } from './time.js';

export const GOALS = {
  recomp: 'Lose fat + build muscle', fat: 'Lose fat', muscle: 'Build muscle / strength', health: 'Health & energy',
};

export const SOURCES = {
  ding2025: ['Ding et al. 2025, Lancet Public Health — daily steps and 15 health outcomes', 'https://pubmed.ncbi.nlm.nih.gov/40713949/'],
  paluch2022: ['Paluch et al. 2022, Lancet Public Health — steps and mortality, by age', 'https://doi.org/10.1016/S2468-2667(21)00302-9'],
  steps10k: ['Schneider et al. 2006 — a 10,000-step goal in overweight adults (adherence predicted weight loss)', 'https://pubmed.ncbi.nlm.nih.gov/17152246/'],
  duran2023: ['Duran et al. 2023, Med Sci Sports Exerc — walking breaks from sitting, dose-response', 'https://doi.org/10.1249/MSS.0000000000003109'],
  vilpa2022: ['Stamatakis et al. 2022, Nature Medicine — 1–2 min bursts of vigorous activity in daily life', 'https://doi.org/10.1038/s41591-022-02100-x'],
  minDose2024: ['Sports Medicine 2024 — minimal-dose strength training, including "exercise snacks"', 'https://pubmed.ncbi.nlm.nih.gov/38509414/'],
  daily2022: ['Yoshida et al. 2022 — a few contractions daily beat a larger dose once a week', 'https://pubmed.ncbi.nlm.nih.gov/35908200/'],
  freq2019: ['Schoenfeld et al. 2019 — with weekly volume equal, splitting it across more sessions works as well', 'https://pubmed.ncbi.nlm.nih.gov/30558493/'],
  volume2017: ['Schoenfeld et al. 2017 — more weekly sets, more muscle growth (dose-response)', 'https://doi.org/10.1080/02640414.2016.1210197'],
  protein2018: ['Morton et al. 2018, Br J Sports Med — protein for muscle gain with training (meta-analysis)', 'https://doi.org/10.1136/bjsports-2017-097608'],
  garthe2011: ['Garthe et al. 2011 — slower weight loss (0.7%/week) kept more muscle than 1.4%/week', 'https://doi.org/10.1123/ijsnem.21.2.97'],
  cepeda2006: ['Cepeda et al. 2006, Psychological Bulletin — spaced practice (meta-analysis)', 'https://doi.org/10.1037/0033-2909.132.3.354'],
  fsrs: ['FSRS, the spaced-repetition scheduler used here (also in Anki)', 'https://github.com/open-spaced-repetition/ts-fsrs'],
};

export const KG_PER_LB = 0.45359237;
export const CM_PER_IN = 2.54;

export function ageOn(profile, today) {
  return profile?.birthYear ? +today.slice(0, 4) - profile.birthYear : null;
}

/** Body numbers: recent watch readings (meta/body, field -> [value, ms]) win over what you typed in. */
export function bodyNow(profile = {}, watch = {}, now = Date.now()) {
  const recent = (f, days) => (watch?.[f] && now - watch[f][1] < days * 864e5 ? watch[f] : null);
  const w = recent('weightKg', 30);
  return {
    weightKg: w ? w[0] : profile.weightKg || null,
    weightFrom: w ? 'watch' : profile.weightKg ? 'profile' : null,
    weightAt: w ? w[1] : null,
    heightCm: watch?.heightM ? Math.round(watch.heightM[0] * 100) : profile.heightCm || null,
    restingHr: recent('restingHr', 14)?.[0] ?? null,
    vo2max: recent('vo2max', 120)?.[0] ?? null,
    bodyFat: recent('bodyFat', 60)?.[0] ?? null,
  };
}

/** Where the weekly step goal is heading. */
export function stepTarget(profile = {}, today) {
  const age = ageOn(profile, today);
  const older = age != null && age >= 60;
  if (profile.goal === 'recomp' || profile.goal === 'fat') {
    return {
      steps: 10000, sources: ['ding2025', 'paluch2022', 'steps10k'],
      why: 'Most health benefits level off around 7,000–8,000 steps, but walking is also the easiest extra energy to burn '
        + "for fat loss, and it doesn't eat into recovery from lifting the way more hard training would. 10,000 is "
        + 'where the mortality benefit is still going down and where the weight-loss trials set their goal.',
    };
  }
  return {
    steps: older ? 7000 : 8000, sources: ['ding2025', 'paluch2022'],
    why: older ? 'For adults 60+, the benefit levels off around 6,000–8,000 steps a day.'
      : 'For adults under 60, the benefit levels off around 8,000–10,000 steps a day; 7,000 already gets most of it.',
  };
}

export const monday = day => addDays(day, -((parseDay(day).getDay() + 6) % 7));
const round500 = n => Math.round(n / 500) * 500;
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/**
 * Weekly step goal that starts a notch above your own baseline and climbs toward the target.
 * Hit it on 5+ of last week's days -> +1,000. Hit it on 2 or fewer -> -500 (never below your baseline).
 * `state` is what was stored in meta/steps last time; the result is what to store now.
 */
export function stepWeek(state, stepsByDay, target, today) {
  const wk = monday(today);
  const days = n => Array.from({ length: n }, (_, i) => addDays(today, -n + i)).filter(d => stepsByDay[d] > 0);
  if (!state?.goal) {
    const have = days(14);
    if (have.length < 4) return { weekStart: wk, goal: null, baseline: null, target, measuring: have.length };
    const baseline = median(have.map(d => stepsByDay[d]));
    return { weekStart: wk, baseline, target, goal: Math.max(3000, Math.min(target, round500(baseline + 1000))), change: 'start' };
  }
  if (state.weekStart === wk) return { ...state, target, goal: Math.min(state.goal, target) };
  const last = Array.from({ length: 7 }, (_, i) => addDays(wk, -7 + i)).filter(d => stepsByDay[d] > 0);
  const hit = last.filter(d => stepsByDay[d] >= state.goal).length;
  let goal = Math.min(state.goal, target), change = 'hold';
  if (last.length >= 4 && hit >= Math.min(5, last.length)) {
    goal = Math.min(target, goal + 1000);
    change = goal > state.goal ? 'up' : 'at-target';
  } else if (last.length >= 4 && hit <= 2) {
    goal = Math.max(round500(state.baseline || 3000), goal - 500);
    change = goal < state.goal ? 'down' : 'hold';
  }
  return { weekStart: wk, baseline: state.baseline, target, goal, change, lastWeek: { hit, days: last.length } };
}

/** The step goal for today, from settings (manual) or the weekly plan (auto). */
export const stepGoalNow = (settings, plan) => (settings.activity.stepGoalAuto && plan?.goal ? plan.goal : settings.activity.stepGoal);

/** Loads meta/steps, moves it to this week if needed, and stores the result. */
export async function stepPlan(store, settings, today) {
  const target = stepTarget(settings.profile, today).steps;
  const [state, daily] = await Promise.all([
    store.get('meta', 'steps'),
    store.query('daily', { where: [['day', '>=', addDays(today, -14)]] }),
  ]);
  const byDay = Object.fromEntries(daily.map(d => [d.day, d.steps || 0]));
  const next = stepWeek(state, byDay, target, today);
  if (next.goal && (next.weekStart !== state?.weekStart || next.goal !== state?.goal || next.target !== state?.target)) {
    store.set('meta', 'steps', next);
  }
  return next;
}

/** Protein per day, in grams. ~1.6 g/kg is where gains level off on average; up to 2.2 covers most people. */
export function protein(weightKg, goal) {
  if (!weightKg) return null;
  const [lo, hi] = goal === 'health' ? [1.2, 1.6] : [1.6, 2.2];
  return { low: Math.round((weightKg * lo) / 5) * 5, high: Math.round((weightKg * hi) / 5) * 5, perKg: [lo, hi] };
}

/** Weekly weight change to aim for (kg). Slow loss keeps muscle while you build it. */
export function lossRate(weightKg, goal) {
  if (!weightKg || !(goal === 'recomp' || goal === 'fat')) return null;
  const [lo, hi] = goal === 'recomp' ? [0.25, 0.7] : [0.5, 1.0];
  return { lowKg: (weightKg * lo) / 100, highKg: (weightKg * hi) / 100, pct: [lo, hi] };
}

export const fmtWeight = (kg, units) => (units === 'kg' ? `${(Math.round(kg * 10) / 10).toFixed(1)} kg` : `${Math.round(kg / KG_PER_LB)} lb`);
export const fmtRate = (kg, units) => (units === 'kg' ? `${(Math.round(kg * 10) / 10).toFixed(1)} kg` : `${(Math.round((kg / KG_PER_LB) * 10) / 10).toFixed(1)} lb`);
