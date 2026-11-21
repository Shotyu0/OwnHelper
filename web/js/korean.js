// Korean spaced repetition with FSRS (ts-fsrs, the reference JS implementation).
//
// Each note becomes two cards in users/{uid}/cards:
//   <key>_r  read  (Korean -> meaning)       introduced in newRank order, newQuota() per day
//   <key>_t  type  (meaning -> type Korean)  locked until the read card's memory lasts unlockTypingAfterDays
// Field conventions (the PC guardian counts these, see helper/gaming/rules.py):
//   due          ms; present only on cards that are being reviewed
//   newRank      present only on read cards not yet introduced (lower = sooner)
//   introducedAt ms; set when a read card is first answered
import { fsrs, createEmptyCard, State } from 'ts-fsrs';
import { DELETE } from './store-core.js';
import { ymd } from './time.js';

export const LEARN_AHEAD = 20 * 60e3;
export const NO_TYPING = new Set(['grammar']);
export const DECK_LABEL = { hangul: 'Hangul', vocab: 'Word', grammar: 'Grammar', mined: 'Mined' };
export const DECK_FILES = [['data/hangul.txt', 0], ['data/starter.txt', 1000]];
export const DECK_VERSION = 1;

export function parseDeck(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const p = line.split('|');
    if (p.length !== 6) throw new Error('Bad deck line: ' + line);
    out.push({ deck: p[0], ko: p[1], meaning: p[2], hint: p[3], exKo: p[4], exEn: p[5] });
  }
  return out;
}

function fnv(s) {
  let h = 0x811c9dc5;
  for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
export function noteKey(deck, ko, meaning) {
  return `${deck}-${fnv(ko.trim() + '|' + meaning.trim())}`;
}

/** Mined words go after Hangul but before the starter deck, in the order you add them. */
export function minedRank(now) {
  return 500 + (now - 1.7e12) / 1e12;
}

export function noteCards(note, rank, now, source = 'starter') {
  const key = noteKey(note.deck, note.ko, note.meaning);
  const base = {
    nk: key, deck: note.deck, ko: note.ko.trim(), meaning: note.meaning.trim(), hint: note.hint || '',
    exKo: note.exKo || '', exEn: note.exEn || '', source, createdAt: now,
  };
  const cards = [{ id: key + '_r', data: { ...base, kind: 'read', status: 'new', newRank: rank } }];
  if (!NO_TYPING.has(note.deck)) cards.push({ id: key + '_t', data: { ...base, kind: 'type', status: 'locked' } });
  return cards;
}

// ------------------------------------------------------------------------------------------- scheduling
const schedulers = new Map();
function scheduler(retention) {
  if (!schedulers.has(retention)) schedulers.set(retention, fsrs({ request_retention: retention, enable_fuzz: true }));
  return schedulers.get(retention);
}
function toCard(s, now) {
  if (!s) return createEmptyCard(new Date(now));
  return { ...s, due: new Date(s.due), last_review: s.last_review ? new Date(s.last_review) : undefined };
}
function fromCard(c) {
  return {
    due: c.due.getTime(), stability: c.stability, difficulty: c.difficulty, scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps, reps: c.reps, lapses: c.lapses, state: c.state,
    last_review: c.last_review ? c.last_review.getTime() : null,
  };
}

export function intervalLabel(ms) {
  const s = ms / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  if (s < 86400 * 365) return `${(s / 86400 / 30).toFixed(1)}mo`;
  return `${(s / 86400 / 365).toFixed(1)}y`;
}

export function previews(card, retention, now) {
  const log = scheduler(retention).repeat(toCard(card.fsrs, now), new Date(now));
  const out = {};
  for (const g of [1, 2, 3, 4]) out[g] = intervalLabel(log[g].card.due.getTime() - now);
  return out;
}

/** Returns the card patch to save, plus whether the matching typing card should unlock. */
export function review(card, rating, korean, now) {
  const { card: next } = scheduler(korean.desiredRetention).next(toCard(card.fsrs, now), new Date(now), rating);
  const patch = { status: 'active', fsrs: fromCard(next), due: next.due.getTime(), stab: next.stability };
  if (card.status === 'new') {
    patch.newRank = DELETE;
    if (card.kind === 'read') patch.introducedAt = now;
  }
  const unlock = card.kind === 'read' && next.state === State.Review && next.stability >= korean.unlockTypingAfterDays;
  return { patch, unlock };
}

// ------------------------------------------------------------------------------------------- daily size
// How many reviews a card needs in its first year, by target recall. Estimated from FSRS default parameters
// (intervals of roughly 1, 3, 10, 25, 60, 140, 300 days at 90%, plus relearning after lapses).
const REVIEWS_PER_CARD = r => (r >= 0.95 ? 14 : r >= 0.9 ? 9 : 7);

/**
 * New words per day so the long-run daily load fits korean.minutesPerDay. Each word brings a reading card and
 * later a typing card; both get ~REVIEWS_PER_CARD reviews in their first year, so the steady daily load is about
 * newPerDay x (reviews x seconds per review). Seconds come from your own answers (median of the last week) once
 * there are 10+ of a kind. If today's due reviews already fill the budget, fewer (or no) new words today.
 */
export function koreanPlan(reviews, korean, dueNow) {
  const secs = pred => {
    const v = reviews.filter(r => r.ms > 0 && pred(r)).map(r => Math.min(60, Math.max(1.5, r.ms / 1000))).sort((a, b) => a - b);
    return v.length >= 10 ? Math.round(v[Math.floor(v.length / 2)] * 10) / 10 : null;
  };
  const typing = r => String(r.card).endsWith('_t');
  const measured = { read: secs(r => !typing(r) && !r.isNew), type: secs(r => typing(r) && !r.isNew), fresh: secs(r => !!r.isNew) };
  const secRead = measured.read ?? 8, secType = measured.type ?? 15, secNew = measured.fresh ?? 20;
  const k = REVIEWS_PER_CARD(korean.desiredRetention);
  const perWord = k * (secRead + secType) + 2 * secNew;
  const budget = korean.minutesPerDay * 60;
  const steady = Math.max(3, Math.min(30, Math.round(budget / perWord)));
  const room = Math.max(0, budget - dueNow * (secRead + secType) / 2);
  const newPerDay = Math.min(steady, Math.floor(room / (secNew + 2 * secRead)));
  return { newPerDay, steady, perWordMin: Math.round((perWord / 60) * 10) / 10, secRead, secType, secNew, k, dueNow,
    measured: Object.fromEntries(Object.entries(measured).map(([key, v]) => [key, v != null])) };
}

let quotaCache = null;

/** Today's new-card quota. Auto mode computes it once a day and stores it in meta/korean (the PC reads it too). */
export async function newQuota(store, korean, now, todayStart) {
  if (!korean.autoNewCards) return korean.newCardsPerDay;
  const day = ymd(new Date(todayStart));
  const sig = `${day}|${korean.minutesPerDay}|${korean.desiredRetention}`;
  if (quotaCache?.sig === sig) return quotaCache.n;
  const saved = await store.get('meta', 'korean');
  if (saved?.sig === sig) {
    quotaCache = { sig, n: saved.newPerDay };
    return saved.newPerDay;
  }
  const [reviews, due] = await Promise.all([
    store.query('reviews', { where: [['at', '>=', now - 7 * 864e5]] }),
    store.count('cards', [['due', '<=', now + LEARN_AHEAD]]),
  ]);
  const plan = koreanPlan(reviews, korean, due);
  store.set('meta', 'korean', { ...plan, day, sig, at: now, minutes: korean.minutesPerDay });
  quotaCache = { sig, n: plan.newPerDay };
  return plan.newPerDay;
}

// ------------------------------------------------------------------------------------------- queue
export async function counts(store, korean, now, todayStart) {
  const quota = await newQuota(store, korean, now, todayStart);
  const [due, newToday, newAvailable, reviewedToday, known] = await Promise.all([
    store.count('cards', [['due', '<=', now + LEARN_AHEAD]]),
    store.count('cards', [['introducedAt', '>=', todayStart]]),
    store.count('cards', [['newRank', '>=', 0]]),
    store.count('reviews', [['at', '>=', todayStart]]),
    store.count('cards', [['kind', '==', 'read'], ['status', '==', 'active']]),
  ]);
  const newLeft = Math.max(0, Math.min(quota - newToday, newAvailable));
  return { due, newToday, newAvailable, newLeft, reviewedToday, known, quota, done: due === 0 && newLeft === 0 };
}

export async function nextCard(store, korean, now, todayStart) {
  let [c] = await store.query('cards', { where: [['due', '<=', now]], orderBy: ['due', 'asc'], limit: 1 });
  if (!c) {
    const k = await counts(store, korean, now, todayStart);
    if (k.newLeft > 0) [c] = await store.query('cards', { where: [['newRank', '>=', 0]], orderBy: ['newRank', 'asc'], limit: 1 });
  }
  if (!c) [c] = await store.query('cards', { where: [['due', '<=', now + LEARN_AHEAD]], orderBy: ['due', 'asc'], limit: 1 });
  return c || null;
}

export async function answer(store, card, rating, korean, now, extra = {}) {
  const { patch, unlock } = review(card, rating, korean, now);
  const ops = [
    { op: 'update', col: 'cards', id: card.id, data: patch },
    { op: 'set', col: 'reviews', id: `${now}-${card.id}`, data: { card: card.id, kind: card.kind, isNew: card.status === 'new', rating, at: now, ...extra } },
  ];
  if (unlock) {
    const typeId = card.nk + '_t';
    const t = await store.get('cards', typeId);
    if (t && t.status === 'locked') ops.push({ op: 'update', col: 'cards', id: typeId, data: { status: 'active', due: now, unlockedAt: now } });
  }
  await store.batch(ops);
  return { patch, unlocked: unlock };
}

export async function suspend(store, card) {
  await store.update('cards', card.id, { status: 'suspended', due: DELETE, newRank: DELETE });
}

/** Load the bundled decks into a new account (or add notes from a newer deck version). */
export async function seed(store, fetchText, now) {
  const existing = new Set((await store.query('cards', { where: [['kind', '==', 'read']] })).map(c => c.id));
  const ops = [];
  for (const [file, base] of DECK_FILES) {
    parseDeck(await fetchText(file)).forEach((note, i) => {
      for (const c of noteCards(note, base + i, now)) {
        if (c.data.kind === 'read' && existing.has(c.id)) return;
        ops.push({ op: 'set', col: 'cards', id: c.id, data: c.data });
      }
    });
  }
  for (let i = 0; i < ops.length; i += 400) await store.batch(ops.slice(i, i + 400));
  return ops.length;
}

export async function addNote(store, note, now, source = 'mined') {
  const cards = noteCards(note, minedRank(now), now, source);
  if (await store.get('cards', cards[0].id)) return false;
  await store.batch(cards.map(c => ({ op: 'set', col: 'cards', id: c.id, data: c.data })));
  return true;
}

// ------------------------------------------------------------------------------------------- typing check
const norm = s => [...(s || '').normalize('NFC')].filter(ch => /[\p{L}\p{N}]/u.test(ch)).join('');
const jamo = s => s.normalize('NFD');

export function editDistance(a, b) {
  a = [...a]; b = [...b];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1])));
    prev = cur;
  }
  return prev[b.length];
}

/** Accepts any '/'-separated alternative. Distance is measured in jamo, so ㅏ vs ㅓ counts as one letter. */
export function checkTyped(expected, typed) {
  const options = expected.split('/').map(norm).filter(Boolean);
  const got = norm(typed);
  if (!options.length) return { correct: false, distance: 99, suggested: 1 };
  const dist = Math.min(...options.map(o => editDistance(jamo(got), jamo(o))));
  if (dist === 0) return { correct: true, distance: 0, suggested: 3 };
  return { correct: false, distance: dist, suggested: dist === 1 ? 2 : 1 };
}
