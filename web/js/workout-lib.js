// Exercise library and templates.
//  * Full-body 3-4x/week -> each muscle ~2x/week (Schoenfeld, Ogborn & Krieger 2016).
//  * Sets close to failure; ~6-30 reps all build muscle when effort is high (Schoenfeld et al. 2017).
//  * Double progression: hit the top of the rep range on every set -> more weight / harder variation.
const slot = (key, title, reps, o = {}) => ({ key, title, reps, sets: 3, ladder: [], exercise: '', inc: [5, 2.5], compound: false, cue: '', ...o });

const PUSH = ['Wall push-up', 'Incline push-up (hands on table/counter)', 'Knee push-up', 'Push-up',
  'Decline push-up (feet on chair)', 'Diamond push-up', 'Archer push-up', 'Pseudo-planche push-up'];
const VPUSH = ['Pike push-up (hips high)', 'Elevated pike push-up (feet on chair)', 'Wall-walk hold to pike push-up',
  'Wall handstand push-up negative'];
const ROW_NO_BAR = ["Towel row (towel around a closed door's handles)", 'Table row, knees bent (sturdy table)',
  'Table row, legs straight', 'Table row, feet elevated'];
const PULL_BAR = ['Scapular pull-up', 'Negative pull-up (lower over 4-5 s)', 'Pull-up', 'Chin-up, 3 s lowering',
  'Wide-grip pull-up', 'Archer pull-up'];
const SQUAT = ['Box squat (to chair)', 'Bodyweight squat', 'Split squat', 'Bulgarian split squat (rear foot on chair)',
  'Bulgarian split squat, 3 s lowering', 'Assisted pistol squat (hold door frame)', 'Pistol squat to box', 'Pistol squat'];
const HINGE = ['Glute bridge', 'Single-leg glute bridge', 'Hip thrust (shoulders on couch)',
  'Single-leg hip thrust (shoulders on couch)', 'Single-leg Romanian deadlift (bodyweight, slow)',
  'Nordic curl negative (feet anchored under couch)'];
const CORE_FLOOR = ['Dead bug', 'Reverse crunch', 'Lying leg raise', 'Hollow body rock', 'V-up'];
const CORE_BAR = ['Dead bug', 'Reverse crunch', 'Hanging knee raise', 'Hanging leg raise', 'Toes to bar'];

function home(equipment) {
  const bar = equipment.includes('pullup_bar'), db = equipment.includes('dumbbells');
  return [
    slot('home.push', 'Horizontal push', [8, 15], { ladder: PUSH, cue: 'Body in one straight line, chest to ~fist height, elbows ~45° from your sides.' }),
    slot('home.pull', 'Pull', bar ? [6, 12] : [8, 15], { ladder: bar ? PULL_BAR : ROW_NO_BAR, cue: 'Pull shoulder blades back and down first; control the way down.' }),
    slot('home.squat', 'Squat (per leg on single-leg moves)', [8, 15], { ladder: SQUAT, cue: 'Knees track over toes, whole foot down, go as deep as you can with a neutral back.' }),
    db ? slot('home.hinge_db', 'Hinge', [8, 12], { exercise: 'Dumbbell Romanian deadlift', inc: [5, 2], compound: true, cue: 'Push hips back, soft knees, dumbbells slide down your thighs, flat back.' })
       : slot('home.hinge', 'Hinge (per leg on single-leg moves)', [10, 15], { ladder: HINGE, cue: 'Drive through the heel, squeeze glutes at the top, ribs down.' }),
    slot('home.vpush', 'Vertical push', [6, 12], { sets: 2, ladder: VPUSH, cue: 'Head travels in front of the hands, forming a triangle; elbows not flared.' }),
    slot('home.core', 'Core', [8, 15], { sets: 2, ladder: bar ? CORE_BAR : CORE_FLOOR, cue: 'Lower back stays pressed to the floor (or no swinging on the bar).' }),
  ];
}

const GYM_A = [
  slot('gym.squat', 'Squat', [6, 10], { exercise: 'Barbell back squat', inc: [10, 5], compound: true, cue: 'Brace (big breath into belly), break at hips and knees together, depth at least parallel.' }),
  slot('gym.bench', 'Horizontal push', [6, 10], { exercise: 'Bench press', compound: true, cue: 'Shoulder blades pinched, feet planted, bar touches lower chest, press up and slightly back.' }),
  slot('gym.row', 'Horizontal pull', [8, 12], { exercise: 'Seated cable row', cue: "Chest up, pull to belly button, pause, don't lean back to cheat." }),
  slot('gym.rdl', 'Hinge', [8, 12], { exercise: 'Romanian deadlift', inc: [10, 5], compound: true, cue: 'Hips back, bar close to legs, stop when hamstrings are stretched, flat back.' }),
  slot('gym.crunch', 'Core', [10, 15], { sets: 2, exercise: 'Cable crunch', cue: 'Curl ribs toward hips; the hips stay still.' }),
];
const GYM_B = [
  slot('gym.legpress', 'Squat pattern', [10, 15], { exercise: 'Leg press', inc: [20, 10], compound: true, cue: "Lower until hips start to tuck, then press through the whole foot. Don't lock the knees hard." }),
  slot('gym.ohp', 'Vertical push', [6, 10], { exercise: 'Overhead press', compound: true, cue: 'Squeeze glutes, bar path close to the face, head through at the top.' }),
  slot('gym.pulldown', 'Vertical pull', [8, 12], { exercise: 'Lat pulldown', cue: 'Pull elbows down to your sides, bar to upper chest, control the way up.' }),
  slot('gym.legcurl', 'Hamstrings', [10, 15], { exercise: 'Seated leg curl', cue: 'Full range; slow on the way back.' }),
  slot('gym.incline', 'Upper chest', [8, 12], { exercise: 'Incline dumbbell press', inc: [5, 2], cue: 'Bench ~30°, dumbbells lower to upper chest, elbows slightly tucked.' }),
  slot('gym.hang', 'Core', [8, 15], { sets: 2, ladder: ['Hanging knee raise', 'Hanging leg raise', 'Toes to bar'], cue: 'No swinging; curl the pelvis up.' }),
];

// 30-minute lunch sessions: upper and lower days alternate (2x/week each on a 4-day week), each as two supersets.
// Supersets pair muscles that don't compete and rest ~60 s between the two moves, which roughly halves session
// time for the same sets (Iversen et al. 2021). Same exercise slots as the full sessions, so progress carries over.
const pick = (list, key, o) => ({ ...list.find(s => s.key === key), ...o });
const LUNCH_UPPER = [
  pick(GYM_A, 'gym.bench', { pair: 'A1', partner: 'Seated cable row' }),
  pick(GYM_A, 'gym.row', { pair: 'A2', partner: 'Bench press' }),
  pick(GYM_B, 'gym.ohp', { pair: 'B1', partner: 'Lat pulldown' }),
  pick(GYM_B, 'gym.pulldown', { pair: 'B2', partner: 'Overhead press' }),
];
const LUNCH_LOWER = [
  pick(GYM_A, 'gym.squat', { pair: 'A1', partner: 'Seated leg curl' }),
  pick(GYM_B, 'gym.legcurl', { pair: 'A2', partner: 'Barbell back squat', sets: 3 }),
  pick(GYM_A, 'gym.rdl', { pair: 'B1', partner: 'Cable crunch' }),
  pick(GYM_A, 'gym.crunch', { pair: 'B2', partner: 'Romanian deadlift', sets: 3 }),
];

export const TEMPLATE_TITLES = {
  home: 'Home full-body', gym_a: 'Gym full-body A', gym_b: 'Gym full-body B',
  lunch_upper: 'Lunch upper (30 min)', lunch_lower: 'Lunch lower (30 min)',
};

export function template(name, equipment = []) {
  if (name === 'home') return home(equipment);
  if (name === 'gym_a') return GYM_A;
  if (name === 'gym_b') return GYM_B;
  if (name === 'lunch_upper') return LUNCH_UPPER;
  if (name === 'lunch_lower') return LUNCH_LOWER;
  throw new Error('Unknown template ' + name);
}
