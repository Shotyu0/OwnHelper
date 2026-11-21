import { fmtDateTime, calendarDay, addDays } from '../time.js';
import { effectiveGaming, sessionLabel } from '../settings.js';
import { verifySet } from '../activity.js';
import { setText, syncSetPlan } from '../workout.js';
import { esc, $, pill, check, toast } from '../ui.js';
import { gateInputs } from './today.js';

// The PC guardian enforces the rules and publishes its view in meta/gaming. This page shows it, sends session
// requests (sessionRequests) that the guardian checks against the same rules, and logs sets (snacks).
const clock = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const VERIFY = { ok: ['watch saw it', 'ok'], low: ['no HR rise seen', 'wn'], nodata: ['no watch data yet', ''] };

export async function render(main, ctx) {
  const { store, settings } = ctx;
  const now = ctx.now(), weekAgo = now - 14 * 864e5, dayStart = ctx.dayStart(ctx.today());
  const [sessions, overrides, events, gate, setsToday, variants] = await Promise.all([
    store.query('sessions', { where: [['startedAt', '>=', weekAgo]] }),
    store.query('overrides', { where: [['at', '>=', weekAgo]] }),
    store.query('events', { where: [['at', '>=', weekAgo]] }),
    gateInputs(ctx),
    store.query('snacks', { where: [['at', '>=', dayStart]] }),
    syncSetPlan(store, settings),
  ]);
  const days = [...new Set(setsToday.map(x => calendarDay(x.at)).flatMap(d => [d, addDays(d, -1)]))];
  const activity = Object.fromEntries((await Promise.all(days.map(d => store.get('activity', d)))).map((d, i) => [days[i], d]));
  sessions.sort((a, b) => b.startedAt - a.startedAt);
  overrides.sort((a, b) => b.at - a.at);
  events.sort((a, b) => b.at - a.at);
  setsToday.sort((a, b) => b.at - a.at);
  const g = effectiveGaming(settings, ctx.today());
  const caps = g.dailyCapWeekday > 0 || g.dailyCapWeekend > 0
    ? `cap ${g.dailyCapWeekday || '∞'} min weekdays / ${g.dailyCapWeekend || '∞'} weekends` : 'no daily cap';

  main.innerHTML = `<div id="gm"><h1>Gaming</h1>
    <div class="grid"><div class="card" id="status"><p class="muted">Waiting for the PC guardian…</p></div>
      <div class="card" id="sets"></div></div>
    <div class="card mt"><h2>How it works</h2>
      <ul class="small">
        <li><b>Decide before you play</b>: what you'll do right after, and (if you like) how long. "Then I will…" plans roughly double
          follow-through (Gollwitzer &amp; Sheeran, 2006); deciding in advance beats deciding mid-game (Ariely &amp; Wertenbroch, 2002).</li>
        <li><b>A set every ${g.setEveryMinutes || '—'} minutes of play</b> is the stop point: you get up, move, and choose again with a clear head.
          ${g.setsRequired ? 'An overdue set closes the game until it\'s logged.' : 'Overdue sets only remind you.'} It's also free training volume (<a href="#/plan">Plan</a> has the research).</li>
        <li><b>Workout and Korean first</b>: the fun thing comes after the hard thing (Premack principle).</li>
        <li><b>Overrides cost a minute and a reason</b>, and only exist on the PC prompt. Loosening a rule in Settings waits until tomorrow.</li>
      </ul>
      <p class="small muted">Today: ${caps} · ${g.overrideMaxPerDay} override/day${settings.gamingPending ? ` · <b>looser rules start ${esc(settings.gamingPending.effective)}</b>` : ''}</p></div>
    <div class="card mt"><h2>Sessions, last 2 weeks</h2>
      <table><tr><th>Start</th><th>Played</th><th>Game</th><th>Ended</th><th>Then</th></tr>
      ${sessions.map(s => `<tr><td>${fmtDateTime(s.startedAt)}</td><td>${Math.round(((s.endedAt || Math.min(ctx.now(), s.plannedEnd || Infinity)) - s.startedAt) / 60e3)} min</td>
        <td>${esc(s.games || '')}</td><td>${esc(s.endReason || 'running')}</td><td class="small">${esc(s.nextAction)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No sessions yet.</td></tr>'}
      </table></div>
    <div class="grid mt"><div class="card"><h2>Overrides</h2>
        ${overrides.map(o => `<div class="check">${pill(o.kind, 'wn')}<div><b>${fmtDateTime(o.at)}</b><br>${esc(o.reason)}</div></div>`).join('') || '<p class="muted small">None. 💪</p>'}</div>
      <div class="card"><h2>Guardian log</h2>
        ${events.slice(0, 30).map(e => `<div class="check">${pill(e.kind.replace('_', ' '), ['offline', 'kill_failed', 'set_missed'].includes(e.kind) ? 'no' : 'wn')}
          <div class="small"><b>${fmtDateTime(e.at)}</b> ${esc(e.detail || '')}</div></div>`).join('') || '<p class="muted small">Nothing yet.</p>'}</div></div></div>`;

  let last = null;
  const statusEl = $('#status', main), setsEl = $('#sets', main);
  let shown = '';

  // ---- sets card: next set, a timer to do it, and today's sets checked against the watch
  let timer = null, timerEnd = 0;
  const nextItems = () => last?.sets?.next || variants[setsToday.length % variants.length];
  const drawSets = () => {
    const st = last?.sets;
    const due = st?.dueAt ? st.dueAt - ctx.now() : null;
    setsEl.innerHTML = `<h2>Sets</h2>
      ${due != null ? `<div class="big">${due > 0 ? clock(due) : 'now'}</div><div class="muted small">${due > 0 ? 'until the next set' : g.setsRequired ? 'set due: the game is closed until it\'s logged' : 'set overdue'}</div>`
        : `<p class="small">One every <b>${g.setEveryMinutes} min</b> of play.</p>`}
      <p>Next: <b>${esc(setText(nextItems()))}</b></p>
      <p id="setbtn">${timer ? `<button disabled>Doing it… ${Math.ceil((timerEnd - Date.now()) / 1000)}s</button>`
        : timerEnd && Date.now() >= timerEnd ? '<button class="primary" data-done>Done ✓ log it</button>' : '<button data-start>Start a set</button>'}</p>
      <p class="small muted">Do it any time in the last few minutes before it's due, between matches. Logging it here unlocks the PC within seconds.</p>
      <h3>Today</h3>
      ${setsToday.map(x => { const v = VERIFY[verifySet(activity, x.at).status]; return `<div class="check">${pill(v[0], v[1])}
        <div class="small"><b>${fmtDateTime(x.at)}</b> ${esc(setText(x.items))} <span class="muted">(${esc(x.source)})</span></div></div>`; }).join('')
        || '<p class="small muted">None yet.</p>'}
      ${setsToday.length ? '<p class="small muted">The watch check needs continuous heart-rate measuring and a sync after the set.</p>' : ''}`;
  };
  setsEl.addEventListener('click', async e => {
    if (e.target.closest('[data-start]')) {
      timerEnd = Date.now() + (g.setMinSeconds || 30) * 1000;
      timer = setInterval(() => { if (Date.now() >= timerEnd) { clearInterval(timer); timer = null; } drawSets(); }, 500);
      drawSets();
    } else if (e.target.closest('[data-done]')) {
      const items = nextItems(), id = String(Date.now());
      const doc = { at: ctx.now(), day: ctx.today(), items, source: 'phone', session: last?.session?.id || null };
      await store.set('snacks', id, doc);
      setsToday.unshift({ id, ...doc });
      timerEnd = 0;
      toast('Set logged.', 'ok');
      drawSets();
    }
  });

  // ---- status card: session or plan form (redrawn from meta/gaming)
  const draw = st => {
    last = st;
    if (!timer) drawSets();
    const fresh = st && ctx.now() - st.at < 3 * 60e3;
    // The guardian refreshes its status every minute; don't wipe the form unless something that matters changed.
    const sig = JSON.stringify([fresh, st?.session?.id, st?.canStart, st?.blockers, st?.choices]);
    if (sig === shown && !st?.session && $('#plan', statusEl)) return;
    shown = sig;
    if (!fresh) {
      statusEl.innerHTML = `<h2>Plan a session</h2>${gate.items.map(i => check(i.ok, i.label, i.detail)).join('')}
        <div class="flash wn mt">The PC guardian is offline. Start it on your PC (start.bat) — sessions are planned through it.</div>`;
      return;
    }
    if (st.session) {
      const end = st.session.plannedEnd;
      statusEl.innerHTML = `<h2>Session running</h2>
        ${end ? `<div class="big">${clock(end - ctx.now())}</div><div class="muted small">left</div>`
          : `<div class="big">${Math.round(st.used)}<span class="muted unit"> min today</span></div><div class="muted small">no time limit</div>`}
        <p class="muted small">Then: <b>${esc(st.session.nextAction)}</b></p>
        <button class="primary" data-end="${esc(st.session.id)}">End session now</button>
        <p class="small muted">The game gets a "save now" warning before it's closed.</p>`;
      return;
    }
    const choices = st.choices?.length ? st.choices : [];
    const pick = choices[0] === 0 ? 0 : Math.min(1, choices.length - 1);
    statusEl.innerHTML = `<h2>Plan a session</h2>${st.gate.map(i => check(i.ok, i.label, i.detail)).join('')}
      <p class="small">Today: <b>${Math.round(st.used)}</b>${st.cap ? ` / ${st.cap}` : ''} min${st.cooldownLeft > 0 ? ` · cooldown ${Math.round(st.cooldownLeft)} min` : ''}</p>
      ${st.canStart ? `<form id="plan"><label>How long?</label><div class="row">${choices.map((m, i) =>
        `<label class="plain m0"><input type="radio" class="auto" name="minutes" value="${m}" ${i === pick ? 'checked' : ''}> ${sessionLabel(m)}</label>`).join('')}</div>
        <label>Right after, I will:</label><input name="next" required placeholder="go to bed / make dinner / 20 min of Korean reading">
        <p><button class="primary">Start session</button></p></form>`
        : `<div class="flash no small">Locked: ${esc(st.blockers.join('; '))}</div>
           <p class="small muted">Overrides happen on the PC prompt when you launch a game (a 60-second wait and a written reason).</p>`}
      <p class="small muted">Launching a Steam game without a session closes it and asks the same thing on your desktop.</p>`;
    const form = $('#plan', statusEl);
    if (form) form.onsubmit = async e => {
      e.preventDefault();
      const id = String(Date.now());
      await store.set('sessionRequests', id, { minutes: +form.minutes.value, nextAction: form.next.value.trim(), at: ctx.now(), status: 'pending' });
      toast('Sent to your PC…');
      const stop = store.watch('sessionRequests', id, r => {
        if (!r || r.status === 'pending') return;
        stop();
        toast(r.status === 'ok' ? 'Session started — have fun.' : r.message, r.status === 'ok' ? 'ok' : 'bad');
      });
    };
  };
  statusEl.addEventListener('click', async e => {
    const id = e.target.closest('[data-end]')?.dataset.end;
    if (id && confirm('End the session now?')) {
      await store.update('sessions', id, { open: false, endedAt: ctx.now(), endReason: 'manual' });
      toast('Ending — the game will be asked to close.');
    }
  });
  drawSets();
  const unwatch = store.watch('meta', 'gaming', draw);
  // Countdowns only; never redraws the plan form.
  const tick = setInterval(() => { if (last?.session) draw(last); else if (last?.sets?.dueAt && !timer) drawSets(); }, 5000);
  return () => { unwatch(); clearInterval(tick); if (timer) clearInterval(timer); };
}
