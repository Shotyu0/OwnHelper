import { addDays, calendarDay, fmtClock, fmtDuration } from '../time.js';
import { plan, scheduled, nextTemplate, finishWorkout, streak, consistency, workoutStatus, TEMPLATE_TITLES } from '../workout.js';
import { heartDuring, exerciseName } from '../activity.js';
import { esc, $, pill } from '../ui.js';

export async function render(main, ctx) {
  const { store, settings } = ctx;
  const today = ctx.today();
  const [recent, statesList, watchToday] = await Promise.all([
    store.query('workouts', { where: [['day', '>=', addDays(today, -120)]] }),
    store.query('exerciseState'),
    store.query('exercises', { where: [['start', '>=', ctx.dayStart(today)]] }),
  ]);
  recent.sort((a, b) => b.startedAt - a.startedAt);
  const states = Object.fromEntries(statesList.map(s => [s.id, s]));
  const current = recent.find(w => w.day === today && w.status === 'in_progress');
  if (current) return activeWorkout(main, ctx, current, states);

  const todays = recent.filter(w => w.day === today);
  const ws = workoutStatus({ settings, today, workouts: todays, watchSessions: watchToday });
  const doneDays = new Set(recent.filter(w => w.status !== 'in_progress').map(w => w.day));
  const st = streak(doneDays, settings, today, ctx.startedOn), cons = consistency(doneDays, settings, today, ctx.startedOn);
  const sched = scheduled(settings, today), other = sched === 'gym' ? 'home' : 'gym';
  const finished = todays.find(w => w.status !== 'in_progress');
  let hr = null;
  if (finished?.finishedAt) {
    const days = {};  // activity docs are keyed by local calendar date
    for (const d of new Set([calendarDay(finished.startedAt), calendarDay(finished.finishedAt)])) days[d] = await store.get('activity', d);
    hr = heartDuring(days, finished.startedAt, finished.finishedAt);
  }

  main.innerHTML = `<h1>Workout</h1><div class="grid">
    <div class="card">${ws.done ? `<h2>Done today ✓</h2>
        ${finished ? `<p>${esc(TEMPLATE_TITLES[finished.template])}${finished.status === 'minimum' ? ' — minimum version. Showing up is what builds the habit.' : ''}</p>` : ''}
        ${ws.doneAs === 'watch' ? `<p>Your watch recorded ${esc(exerciseName(ws.watch.type))} for ${fmtDuration(ws.watch.dur / 60)} — that counts.</p>` : ''}
        ${hr ? `<p class="small">Heart rate during the workout: avg <b>${hr.avg}</b>, max <b>${hr.max}</b> bpm</p>` : ''}
        <form class="row" data-start><button name="loc" value="${esc(sched === 'rest' ? 'home' : sched)}">Log another workout</button></form>`
      : sched === 'rest' ? `<h2>Rest day</h2><p class="muted">Muscles grow while you recover. A walk is a great idea; training is optional.</p>
        <form class="row" data-start><button name="loc" value="home">Train at home anyway</button><button name="loc" value="gym">Train at the gym anyway</button></form>`
      : `<h2>Today: ${esc(sched)} workout</h2>
        <p class="muted small">~45 min. Low on energy? Start anyway and tick "minimum version": one set of each, ~10 min.
          It still counts — showing up on bad days matters more than intensity.</p>
        <form class="row" data-start><button class="primary" name="loc" value="${esc(sched)}">Start ${esc(sched)} workout</button>
          <button name="loc" value="${other}">Do ${other} instead</button></form>`}
      ${watchToday.length ? `<p class="small muted">From your watch today: ${watchToday.map(x => `${esc(exerciseName(x.type))} ${fmtDuration(x.dur / 60)} at ${fmtClock(x.start)}`).join(' · ')}</p>` : ''}
    </div>
    <div class="card"><h2>Consistency</h2><div class="big">${st.streak}</div><div class="muted small">session streak</div>
      ${cons.pct != null ? `<p class="small">Last 4 weeks: ${cons.hit}/${cons.planned} scheduled sessions</p>
      <div class="bar"><div style="width:${cons.pct * 100}%;background:var(--good)"></div></div>` : ''}</div>
  </div>
  ${recent.some(w => w.status !== 'in_progress') ? `<div class="card mt"><h2>Recent</h2>
    ${recent.filter(w => w.status !== 'in_progress').slice(0, 12).map(w => {
      const by = new Map();
      for (const s of w.sets || []) { const x = by.get(s.exercise) || { n: 0, best: 0, w: null }; x.n++; x.best = Math.max(x.best, s.reps); if (s.weight != null) x.w = Math.max(x.w ?? 0, s.weight); by.set(s.exercise, x); }
      return `<div class="check">${pill(w.status, w.status === 'done' ? 'ok' : 'wn')}<div><b>${esc(w.day)}</b> · ${esc(TEMPLATE_TITLES[w.template])}
        <div class="small muted">${[...by].map(([e, x]) => `${esc(e)} ${x.n}×${x.best}${x.w != null ? ' @' + x.w : ''}`).join(' · ')}</div></div></div>`;
    }).join('')}</div>` : ''}`;

  for (const f of main.querySelectorAll('[data-start]')) f.onsubmit = async e => {
    e.preventDefault();
    const loc = e.submitter.value;
    const lastGym = recent.find(w => w.location === 'gym' && w.status !== 'in_progress');
    const id = `${today}-${Date.now().toString(36)}`;
    await store.set('workouts', id, { day: today, location: loc, template: nextTemplate(loc, lastGym?.template), status: 'in_progress', startedAt: ctx.now(), sets: [] });
    render(main, ctx);
  };
}

function activeWorkout(main, ctx, w, states) {
  const { store, settings } = ctx;
  const units = settings.workout.units;
  const slots = plan(w, settings, states);
  const reps = {}, weights = {}, chosen = {};
  let minimum = false, timer = null;

  main.innerHTML = `<div id="wk"><div class="spread"><h1>${esc(TEMPLATE_TITLES[w.template])}</h1>
      <label class="row small m0 plain"><input type="checkbox" id="minimum" class="auto"> Minimum version (1 set each)</label></div>
    <div id="ex"></div>
    <div class="card row" style="justify-content:space-between"><button id="cancel">Cancel workout</button><button class="primary" id="finish">Finish workout</button></div>
    <div class="timer" id="timer"></div></div>`;
  const root = $('#wk', main);  // listeners go on this wrapper so they vanish with the page

  const save = () => store.update('workouts', w.id, { sets: w.sets });
  function draw() {
    $('#ex', main).innerHTML = slots.map((s, i) => {
      const target = minimum ? 1 : s.sets;
      s.logged = w.sets.filter(x => x.slot === s.key);
      const last = s.logged[s.logged.length - 1];
      reps[s.key] ??= last ? last.reps : s.reps[0];
      weights[s.key] ??= last ? last.weight : s.weight;
      const ex = chosen[s.key] || s.exerciseName;
      return `<div class="card ex ${s.logged.length >= target ? 'dim' : ''}">
        <div class="spread"><span class="small muted">${esc(s.title)}</span><span class="small"><b>${s.logged.length}/${target}</b> sets · ${s.reps[0]}–${s.reps[1]} reps</span></div>
        ${s.ladder.length ? `<select data-i="${i}" class="variation">${s.ladder.map(v => `<option ${v === ex ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`
          : `<h3>${esc(ex)}</h3>`}
        ${s.lastChange ? `<div class="small" style="color:var(--good)">${esc(s.lastChange)}</div>` : ''}
        ${s.weighted && s.weight == null && !s.logged.length ? `<div class="small muted">First time: pick a weight you could lift for about
          2 more reps than the top of the range. The app takes it from there.</div>` : ''}
        <details><summary>Form cues</summary><div class="small">${esc(s.cue)}</div></details>
        <div class="sets">${s.logged.map(l => `<span class="set ${l.reps >= s.reps[1] ? 'top' : l.reps < s.reps[0] ? 'low' : ''}"
          data-del="${l.at}" title="Tap to delete">${l.reps}${l.weight != null ? ' × ' + l.weight : ''}</span>`).join('')}</div>
        <div class="row"><div class="stepper"><button data-bump="${i}" data-d="-1">−</button>
          <input type="number" inputmode="numeric" value="${reps[s.key]}" data-reps="${i}"><button data-bump="${i}" data-d="1">+</button></div>
          <span class="muted small">reps</span>
          ${s.weighted ? `<input type="number" inputmode="decimal" step="any" class="weight" placeholder="weight" value="${weights[s.key] ?? ''}" data-weight="${i}">
            <span class="muted small">${units}</span>` : ''}
          <button class="primary push" data-log="${i}">Log set</button></div></div>`;
    }).join('');
  }

  root.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.reps) reps[slots[t.dataset.reps].key] = +t.value;
    if (t.dataset.weight) weights[slots[t.dataset.weight].key] = t.value;
  });
  root.addEventListener('change', e => { if (e.target.classList.contains('variation')) chosen[slots[e.target.dataset.i].key] = e.target.value; });
  root.addEventListener('click', e => {
    const t = e.target.closest('button, .set');
    if (!t) return;
    if (t.dataset.bump) {
      const s = slots[t.dataset.bump];
      reps[s.key] = Math.max(0, (reps[s.key] || 0) + +t.dataset.d);
      main.querySelector(`[data-reps="${t.dataset.bump}"]`).value = reps[s.key];
    } else if (t.dataset.log) {
      const s = slots[t.dataset.log];
      const weight = s.weighted ? weights[s.key] : null;
      if (s.weighted && (weight === '' || weight == null)) return alert('Enter the weight first.');
      w.sets.push({ slot: s.key, exercise: chosen[s.key] || s.exerciseName, reps: reps[s.key], weight: weight == null ? null : +weight, at: Date.now() });
      save(); draw(); startTimer(s.rest);
    } else if (t.dataset.del && confirm('Delete this set?')) {
      w.sets = w.sets.filter(x => String(x.at) !== t.dataset.del); save(); draw();
    }
  });
  $('#minimum', main).onchange = e => { minimum = e.target.checked; draw(); };
  $('#cancel', main).onclick = async () => { if (confirm('Discard this workout?')) { await store.del('workouts', w.id); render(main, ctx); } };
  $('#finish', main).onclick = async () => {
    if (!w.sets.length && !confirm('No sets logged. Finish anyway?')) return;
    const res = finishWorkout(w, settings, states, minimum);
    const ops = [{ op: 'update', col: 'workouts', id: w.id, data: { status: minimum ? 'minimum' : 'done', finishedAt: ctx.now(), sets: w.sets } }];
    for (const [slot, st] of Object.entries(res.states)) ops.push({ op: 'set', col: 'exerciseState', id: slot, data: { ...st, updatedAt: ctx.now() } });
    await store.batch(ops);
    if (res.notes.length) alert('Next time:\n\n' + res.notes.join('\n'));
    render(main, ctx);
  };

  function startTimer(sec) {
    const el = $('#timer', main);
    clearInterval(timer);
    const end = Date.now() + sec * 1000;
    el.style.display = 'block';
    el.onclick = () => { clearInterval(timer); el.style.display = 'none'; };
    const tick = () => {
      const left = Math.round((end - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(timer); el.textContent = 'Rest over — next set'; beep(); navigator.vibrate?.([200, 100, 200]);
        setTimeout(() => { el.style.display = 'none'; }, 6000); return;
      }
      el.textContent = `Rest ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}  (tap to skip)`;
    };
    tick(); timer = setInterval(tick, 250);
  }
  draw();
  return () => clearInterval(timer);
}

function beep() {
  try { const a = new AudioContext(), o = a.createOscillator(); o.connect(a.destination); o.frequency.value = 880; o.start(); o.stop(a.currentTime + 0.25); } catch (_) { /* no audio */ }
}
