import cfg from '../config.js';
import { LocalStore } from './store-core.js';
import { withDefaults } from './settings.js';
import { dayKey, dayStart, addDays } from './time.js';
import { seed, DECK_VERSION } from './korean.js';
import { esc, toast } from './ui.js';

const PAGES = {
  today: () => import('./pages/today.js'),
  workout: () => import('./pages/workout.js'),
  study: () => import('./pages/study.js'),
  words: () => import('./pages/words.js'),
  activity: () => import('./pages/activity.js'),
  gaming: () => import('./pages/gaming.js'),
  plan: () => import('./pages/plan.js'),
  settings: () => import('./pages/settings.js'),
};
const NAV = [['today', 'Today'], ['workout', 'Workout'], ['study', 'Korean'], ['words', 'Words'],
  ['activity', 'Activity'], ['gaming', 'Gaming'], ['plan', 'Plan'], ['settings', 'Settings']];

const main = document.getElementById('main');
const nav = document.getElementById('nav');
let ctx = null, cleanup = null;

function makeCtx(store, user, auth) {
  const c = {
    cfg, store, user, auth, settings: null,
    now: () => Date.now(),
    today: () => dayKey(Date.now(), c.settings.dayStartsAtHour),
    tomorrow: () => addDays(c.today(), 1),
    dayStart: key => dayStart(key, c.settings.dayStartsAtHour),
    async saveSettings(patch) {
      Object.assign(c.settings, patch);
      await store.update('meta', 'settings', patch);
    },
    toast,
    go: hash => { location.hash = hash; },
  };
  return c;
}

async function prepare(c) {
  c.settings = withDefaults(await c.store.get('meta', 'settings'));
  const state = (await c.store.get('meta', 'state')) || {};
  if ((state.deckVersion || 0) < DECK_VERSION) {
    main.innerHTML = '<p class="muted">Setting up your Korean deck…</p>';
    const fetchText = async f => (await fetch(f, { cache: 'no-cache' })).text();
    await seed(c.store, fetchText, Date.now());
    await c.store.update('meta', 'state', { deckVersion: DECK_VERSION, startedOn: state.startedOn || c.today() });
  }
  c.startedOn = state.startedOn || c.today();
}

async function route() {
  if (!ctx) return;
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const name = PAGES[path] ? path : 'today';
  const params = Object.fromEntries(new URLSearchParams(qs || ''));
  nav.innerHTML = `<a class="brand" href="#/today">Personal Helper</a>` + NAV.map(([k, label]) =>
    `<a href="#/${k}" class="${k === name ? 'on' : ''}">${label}</a>`).join('') +
    (cfg.pcReader ? `<a href="${esc(cfg.pcReader)}" target="_blank" rel="noopener" class="pc-only" title="Runs on your PC">Reader ↗</a>` : '');
  if (cleanup) { try { cleanup(); } catch (_) { /* ignore */ } cleanup = null; }
  main.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const mod = await PAGES[name]();
    cleanup = (await mod.render(main, ctx, params)) || null;
  } catch (e) {
    console.error(e);
    main.innerHTML = `<div class="flash no">Something went wrong: ${esc(e.message || e)}</div>`;
  }
  window.scrollTo(0, 0);
}

function signInScreen(auth, note = '') {
  nav.innerHTML = '<a class="brand">Personal Helper</a>';
  main.innerHTML = `<div class="card signin">
    <h1>Personal Helper</h1><p class="muted">Workouts, Korean and gaming limits, synced to your own Firebase project.</p>
    ${note}<p><button class="primary" id="signin">Sign in with Google</button></p></div>`;
  document.getElementById('signin').onclick = () => auth.signIn().catch(e => toast(e.message, 'bad'));
}

async function start() {
  window.addEventListener('hashchange', route);
  if (!cfg.firebase) {
    ctx = makeCtx(new LocalStore(), { uid: 'local', displayName: 'This browser' }, null);
    await prepare(ctx);
    return route();
  }
  const { initFirebase, FirestoreStore } = await import('./store-firestore.js');
  const auth = initFirebase(cfg.firebase);
  auth.onUser(async user => {
    if (!user) { ctx = null; return signInScreen(auth); }
    const store = new FirestoreStore(user.uid, e => toast('Not saved: ' + (e.code || e.message), 'bad'));
    try {
      await store.get('meta', 'settings');
    } catch (e) {
      if (e.code === 'permission-denied') {
        await auth.signOut();
        return signInScreen(auth, `<div class="flash no">This Google account isn't allowed. Its uid is <code>${esc(user.uid)}</code> —
          put that in firestore.rules (see README) if it's yours.</div>`);
      }
      throw e;
    }
    ctx = makeCtx(store, user, auth);
    await prepare(ctx);
    route();
  });
}

start().catch(e => { main.innerHTML = `<div class="flash no">Couldn't start: ${esc(e.message || e)}</div>`; });
