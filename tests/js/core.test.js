import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LocalStore, runQuery, DELETE } from '../../web/js/store-core.js';
import * as K from '../../web/js/korean.js';
import * as W from '../../web/js/workout.js';
import { template } from '../../web/js/workout-lib.js';
import { withDefaults, gamingChange, effectiveGaming } from '../../web/js/settings.js';
import { dayKey, dayStart, addDays } from '../../web/js/time.js';

const readWeb = f => readFileSync(new URL('../../web/' + f, import.meta.url), 'utf8');
const settings = () => withDefaults({ workout: { schedule: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(d => [d, 'home'])) } });

// ------------------------------------------------------------------------------------- store
test('runQuery matches Firestore semantics used by the app', () => {
  const docs = [{ id: 'a', due: 5 }, { id: 'b' }, { id: 'c', due: 1 }, { id: 'd', due: null }];
  assert.deepEqual(runQuery(docs, { orderBy: ['due', 'asc'] }).map(d => d.id), ['c', 'a']);
  assert.deepEqual(runQuery(docs, { where: [['due', '<=', 5]] }).map(d => d.id), ['a', 'c']);
});

// ------------------------------------------------------------------------------------- korean
test('decks parse and keys are stable', () => {
  const h = K.parseDeck(readWeb('data/hangul.txt')), s = K.parseDeck(readWeb('data/starter.txt'));
  assert.equal(h.length, 66);
  assert.equal(s.length, 202);
  assert.equal(K.noteKey('vocab', '먹다', 'to eat'), K.noteKey('vocab', ' 먹다 ', 'to eat '));
  assert.equal(K.noteCards(s.find(n => n.deck === 'grammar'), 1, 0).length, 1);   // grammar: no typing card
  const keys = new Set([...h, ...s].map(n => K.noteKey(n.deck, n.ko, n.meaning)));
  assert.equal(keys.size, h.length + s.length);   // no hash collisions in the starter set
});

test('a study day: hangul first, 10 new cards, learning steps, then done', async () => {
  const store = new LocalStore('t:', null), k = withDefaults().korean;
  let now = Date.UTC(2026, 10, 21, 15);
  const start = now - 3600e3;
  const n = await K.seed(store, async f => readWeb(f), now);
  assert.equal(n, 66 + 202 + 66 + 176);   // read cards + typing cards (not for grammar)
  const first = await K.nextCard(store, k, now, start);
  assert.equal(first.ko, 'ㅏ');
  for (let i = 0; i < 200; i++) {
    const c = await K.nextCard(store, k, now, start);
    if (!c) break;
    await K.answer(store, c, 3, k, now);
    now += 20e3;
  }
  const c = await K.counts(store, k, now, start);
  assert.equal(c.newToday, 10); assert.equal(c.newLeft, 0); assert.equal(c.due, 0); assert.ok(c.done);
  assert.equal(c.known, 10);
  const later = await K.counts(store, k, now + 5 * 864e5, start + 5 * 864e5);
  assert.ok(later.due > 0 && later.newLeft === 10);
  // reseeding adds nothing
  assert.equal(await K.seed(store, async f => readWeb(f), now), 0);
});

test('review patch, typing unlock and suspend', async () => {
  const store = new LocalStore('u:', null), k = withDefaults().korean;
  let now = Date.UTC(2026, 10, 21);
  await K.addNote(store, { deck: 'mined', ko: '고양이', meaning: 'cat', exKo: '고양이가 자요.' }, now);
  const id = K.noteKey('mined', '고양이', 'cat');
  let card = await store.get('cards', id + '_r');
  assert.ok(card.newRank > 500 && card.newRank < 1000);
  const { patch } = K.review(card, 3, k, now);
  assert.equal(patch.newRank, DELETE); assert.equal(patch.introducedAt, now); assert.ok(patch.due > now);
  for (let i = 0; i < 8; i++) {
    card = await store.get('cards', id + '_r');
    await K.answer(store, card, 4, k, now);
    now = (await store.get('cards', id + '_r')).due + 60e3;
  }
  const t = await store.get('cards', id + '_t');
  assert.equal(t.status, 'active'); assert.ok(t.due);
  await K.suspend(store, t);
  const s = await store.get('cards', id + '_t');
  assert.equal(s.status, 'suspended'); assert.equal(s.due, undefined);
  assert.equal(await K.addNote(store, { deck: 'mined', ko: '고양이', meaning: 'cat' }, now), false);
});

test('study time: sittings, breaks and the daily minutes', async () => {
  const t0 = Date.UTC(2026, 10, 26, 3), min = 60e3;
  const rs = Array.from({ length: 15 }, (_, i) => ({ at: t0 + i * min, ms: min }));   // a 15-minute sitting
  rs.push({ at: t0 + 15 * min, ms: 10 * min });                                        // left open: counts 90 s
  assert.deepEqual(K.studyTime(rs, t0 + 16 * min), { total: 16.5 * min, chunk: 16.5 * min });
  assert.deepEqual(K.studyTime(rs, t0 + 31 * min), { total: 16.5 * min, chunk: 0 });   // 15 min away: next sitting
  rs.push({ at: t0 + 60 * min, ms: 0.5 * min });
  assert.deepEqual(K.studyTime(rs, t0 + 61 * min), { total: 17 * min, chunk: 0.5 * min });

  const store = new LocalStore('st:', null), k = { ...withDefaults().korean, autoNewCards: false };
  await store.set('cards', 'x_r', { kind: 'read', status: 'active', due: t0 });
  await store.set('cards', 'y_r', { kind: 'read', status: 'new', newRank: 1 });
  const add = async (n, from) => { for (let i = 0; i < n; i++) await store.set('reviews', `r${from + i}`, { at: t0 + (from + i) * min, ms: 1.5 * min }); };
  for (const [i, r] of rs.entries()) await store.set('reviews', `a${i}`, r);
  await add(14, 60);      // 17 + 21 = 38 min today, 21.5 in this sitting
  let c = await K.counts(store, k, t0 + 74 * min, t0 - 120 * min);
  assert.ok(c.breakDue && !c.timeUp && !c.done && c.newLeft === 1);
  await add(2, 74);       // 41 min: done for today, the review still due waits
  c = await K.counts(store, k, t0 + 76 * min, t0 - 120 * min);
  assert.ok(c.timeUp && c.done && !c.breakDue && c.newLeft === 0 && c.due === 1);
});

test('typing check works letter by letter', () => {
  assert.ok(K.checkTyped('공부하다', '공부하다').correct);
  const r = K.checkTyped('공부하다', '공부허다');
  assert.equal(r.distance, 1); assert.equal(r.suggested, 2);
  assert.ok(K.checkTyped('은/는', '는').correct);
  assert.ok(K.checkTyped('커피', '커피.').correct);
  assert.equal(K.checkTyped('커피', '컴퓨터').suggested, 1);
});

test('a missed spelling names the rule behind it', () => {
  assert.deepEqual(K.blockParts('임'), ['ㅇ', 'ㅣ', 'ㅁ']);
  assert.deepEqual(K.blockParts('게'), ['ㄱ', 'ㅔ', '']);
  assert.equal(K.blockParts('ㄱ'), null);
  assert.equal(K.linked('한국어'), '한구거');
  assert.equal(K.linked('좋아요'), '조아요');
  assert.equal(K.linked('강아지'), '강아지');   // final ㅇ stays
  const game = K.spellingTips('게임', '그미');
  assert.equal(game.length, 2);
  assert.match(game.join(' '), /임 = ㅇ\+ㅣ\+ㅁ/);
  assert.match(game.join(' '), /ㅔ is "e", ㅡ is "eu"/);
  assert.match(K.spellingTips('한국어', '한구거')[0], /written 한국어/);
  assert.match(K.spellingTips('개', '게')[0], /sound the same/);
  assert.match(K.spellingTips('옷', '옫')[0], /sound like "t"/);
  assert.deepEqual(K.spellingTips('커피', '거피'), ['ㅋ is "k", ㄱ is "g".']);
  assert.deepEqual(K.spellingTips('피아노', '비안요'), [
    'ㅍ is "p", ㅂ is "b".',
    'ㄴ starts the next block (아노, not 안요): a consonant between two vowels goes with the vowel after it. Type the letters in the order you hear them and the keyboard groups them for you.',
    'ㅗ is "o", ㅛ is "yo".',
  ]);
  assert.deepEqual(K.spellingTips('게임', '거임'), ['ㅔ is "e", ㅓ is "eo".']);
  assert.deepEqual(K.spellingTips('게임', '게임'), []);
  assert.deepEqual(K.spellingTips('게임', ''), []);
});

// ------------------------------------------------------------------------------------- workout
test('double progression: weight, deload, ladder', () => {
  const bench = template('gym_a').find(s => s.key === 'gym.bench');
  const top = [10, 10, 10].map(reps => ({ reps, weight: 100, exercise: 'Bench press' }));
  assert.equal(W.progress(bench, top, null, 'lb').weight, 105);
  assert.equal(W.progress(bench, top, null, 'kg').weight, 102.5);
  let st = W.progress(bench, [{ reps: 4, weight: 105 }], null, 'lb');
  assert.equal(st.weight, 105); assert.equal(st.stalls, 1);
  st = W.progress(bench, [{ reps: 4, weight: 105 }], st, 'lb');
  assert.equal(st.weight, 90); assert.match(st.lastChange, /deload/);
  const push = template('home').find(s => s.key === 'home.push');
  const lv = W.progress(push, [15, 15, 15].map(reps => ({ reps, exercise: push.ladder[0] })), null, 'lb');
  assert.equal(lv.level, 1); assert.match(lv.lastChange, /Level up/);
});

test('finishing: minimum version counts but does not progress; gym alternates', () => {
  const s = settings();
  const w = { template: 'home', sets: [{ slot: 'home.push', exercise: 'Wall push-up', reps: 15 }] };
  assert.deepEqual(W.finishWorkout(w, s, {}, true), { states: {}, notes: [] });
  assert.equal(W.nextTemplate('gym', 'gym_a'), 'gym_b');
  assert.equal(W.nextTemplate('gym', undefined), 'gym_a');
  assert.equal(W.nextTemplate('home', 'gym_a'), 'home');
});

test('streaks start on day one and watch workouts count for the gate', () => {
  const s = settings(), today = '2026-11-21';
  assert.deepEqual(W.streak(new Set(), s, today, today), { streak: 0, missedLast: false });
  assert.equal(W.consistency(new Set(), s, today, today).pct, null);
  assert.equal(W.streak(new Set(['2026-11-19', '2026-11-20']), s, today, '2026-11-01').streak, 2);
  assert.ok(W.streak(new Set(['2026-11-18']), s, today, '2026-11-01').missedLast);
  const ws = W.workoutStatus({ settings: s, today, workouts: [], watchSessions: [{ dur: 25 * 60, type: 'running' }] });
  assert.equal(ws.doneAs, 'watch');
  const short = W.workoutStatus({ settings: s, today, workouts: [], watchSessions: [{ dur: 5 * 60 }] });
  assert.ok(!short.done);
  const min = W.workoutStatus({ settings: s, today, workouts: [{ status: 'minimum' }], watchSessions: [] });
  assert.equal(min.doneAs, 'minimum');
});

// ------------------------------------------------------------------------------------- settings / time
test('loosening gaming limits waits until tomorrow, tightening is immediate', () => {
  const s = withDefaults({ gaming: { dailyCapWeekday: 120, sessionChoices: [30, 60] } });   // a capped setup
  const looser = gamingChange(s, { ...s.gaming, dailyCapWeekday: 240 }, '2026-11-21', '2026-11-22');
  assert.ok(looser.delayed); assert.equal(looser.patch.gaming.dailyCapWeekday, 120);
  const pend = { ...s, ...looser.patch };
  assert.equal(effectiveGaming(pend, '2026-11-21').dailyCapWeekday, 120);
  assert.equal(effectiveGaming(pend, '2026-11-22').dailyCapWeekday, 240);
  const tighter = gamingChange(s, { ...s.gaming, dailyCapWeekday: 60, requireWorkout: true }, '2026-11-21', '2026-11-22');
  assert.ok(!tighter.delayed); assert.equal(tighter.patch.gaming.dailyCapWeekday, 60);
  assert.ok(gamingChange(s, { ...s.gaming, requireKoreanReviews: false }, 'a', 'b').delayed);
  assert.ok(gamingChange(s, { ...s.gaming, lunchWorkoutAt: 13 }, 'a', 'b').delayed);     // a longer open morning
  assert.ok(!gamingChange(s, { ...s.gaming, lunchWorkoutAt: 0 }, 'a', 'b').delayed);     // locked all day: tighter
  assert.ok(gamingChange(s, { ...s.gaming, sessionChoices: [30, 120] }, 'a', 'b').delayed);
});

test('logical day rolls over at 4am', () => {
  const t = new Date(2026, 10, 22, 1, 30).getTime();   // 1:30am local
  assert.equal(dayKey(t, 4), '2026-11-21');
  assert.equal(dayKey(new Date(2026, 10, 22, 4, 1).getTime(), 4), '2026-11-22');
  assert.equal(dayStart('2026-11-21', 4), new Date(2026, 10, 21, 4).getTime());
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
});

test('walks never count as the workout', () => {
  const a = withDefaults().activity;
  assert.ok(W.watchCounts({ dur: 3600, type: 'strength_training' }, a));
  assert.ok(!W.watchCounts({ dur: 3600, type: 'walking' }, a));
  assert.ok(!W.watchCounts({ dur: 3600, type: 'EXERCISE_TYPE_WALKING' }, a));
  assert.ok(!W.watchCounts({ dur: 600, type: 'running' }, a));
  assert.ok(!W.watchCounts({ dur: 3600, type: 'running' }, { ...a, watchWorkoutCounts: false }));
});
