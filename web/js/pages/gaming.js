import { fmtDateTime } from '../time.js';
import { effectiveGaming } from '../settings.js';
import { esc, $, pill, check, toast } from '../ui.js';
import { gateInputs } from './today.js';

// The PC guardian enforces the rules and publishes its view in meta/gaming. This page shows it and sends
// session requests (sessionRequests), which the guardian checks against the same rules before starting one.
export async function render(main, ctx) {
  const { store, settings } = ctx;
  const weekAgo = ctx.now() - 14 * 864e5;
  const [sessions, overrides, events, gate] = await Promise.all([
    store.query('sessions', { where: [['startedAt', '>=', weekAgo]] }),
    store.query('overrides', { where: [['at', '>=', weekAgo]] }),
    store.query('events', { where: [['at', '>=', weekAgo]] }),
    gateInputs(ctx),
  ]);
  sessions.sort((a, b) => b.startedAt - a.startedAt);
  overrides.sort((a, b) => b.at - a.at);
  events.sort((a, b) => b.at - a.at);
  const g = effectiveGaming(settings, ctx.today());

  main.innerHTML = `<div id="gm"><h1>Gaming</h1>
    <div class="grid"><div class="card" id="status"><p class="muted">Waiting for the PC guardian…</p></div>
      <div class="card"><h2>Why it works this way</h2>
        <p class="small">You're proactive <i>before</i> gaming and stuck once you start, so the decisions happen before:
          how long, and what comes next. The guardian on your PC carries that decision out.</p>
        <ul class="small">
          <li><b>Pre-commitment</b>: binding your future self while you're thinking clearly (Ariely &amp; Wertenbroch, 2002).</li>
          <li><b>"Then I will…"</b> plans roughly double follow-through (Gollwitzer &amp; Sheeran, 2006).</li>
          <li><b>Workout and study first</b>: making the fun thing depend on the hard thing (Premack principle).</li>
          <li><b>Overrides cost a minute and a reason</b>, and only exist on the PC prompt. Loosening a limit in Settings waits until tomorrow.</li>
        </ul>
        <p class="small muted">Today: cap ${g.dailyCapWeekday} min weekdays / ${g.dailyCapWeekend} weekends · ${g.cooldownMinutes} min cooldown ·
          ${g.overrideMaxPerDay} override/day${settings.gamingPending ? ` · <b>looser limits start ${esc(settings.gamingPending.effective)}</b>` : ''}</p></div></div>
    <div class="card mt"><h2>Sessions, last 2 weeks</h2>
      <table><tr><th>Start</th><th>Played</th><th>Game</th><th>Ended</th><th>Then</th></tr>
      ${sessions.map(s => `<tr><td>${fmtDateTime(s.startedAt)}</td><td>${Math.round(((s.endedAt || Math.min(ctx.now(), s.plannedEnd)) - s.startedAt) / 60e3)} min</td>
        <td>${esc(s.games || '')}</td><td>${esc(s.endReason || 'running')}</td><td class="small">${esc(s.nextAction)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No sessions yet.</td></tr>'}
      </table></div>
    <div class="grid mt"><div class="card"><h2>Overrides</h2>
        ${overrides.map(o => `<div class="check">${pill(o.kind, 'wn')}<div><b>${fmtDateTime(o.at)}</b><br>${esc(o.reason)}</div></div>`).join('') || '<p class="muted small">None. 💪</p>'}</div>
      <div class="card"><h2>Guardian log</h2>
        ${events.slice(0, 30).map(e => `<div class="check">${pill(e.kind.replace('_', ' '), e.kind === 'offline' || e.kind === 'kill_failed' ? 'no' : 'wn')}
          <div class="small"><b>${fmtDateTime(e.at)}</b> ${esc(e.detail || '')}</div></div>`).join('') || '<p class="muted small">Nothing yet.</p>'}</div></div></div>`;

  let last = null;
  const statusEl = $('#status', main);
  let shown = '';
  const draw = st => {
    last = st;
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
      const left = Math.max(0, (st.session.plannedEnd - ctx.now()) / 60e3);
      statusEl.innerHTML = `<h2>Session running</h2><div class="big">${Math.floor(left)}:${String(Math.round((left % 1) * 60)).padStart(2, '0')}</div>
        <p class="muted small">Then: <b>${esc(st.session.nextAction)}</b></p>
        <button class="primary" data-end="${esc(st.session.id)}">End session now</button>
        <p class="small muted">The game gets a "save now" warning before it's closed.</p>`;
      return;
    }
    const choices = st.choices?.length ? st.choices : [];
    statusEl.innerHTML = `<h2>Plan a session</h2>${st.gate.map(i => check(i.ok, i.label, i.detail)).join('')}
      <p class="small">Today: <b>${Math.round(st.used)}</b> / ${st.cap} min${st.cooldownLeft > 0 ? ` · cooldown ${Math.round(st.cooldownLeft)} min` : ''}</p>
      ${st.canStart ? `<form id="plan"><label>How long?</label><div class="row">${choices.map((m, i) =>
        `<label class="plain m0"><input type="radio" class="auto" name="minutes" value="${m}" ${i === Math.min(1, choices.length - 1) ? 'checked' : ''}> ${m} min</label>`).join('')}</div>
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
  const unwatch = store.watch('meta', 'gaming', draw);
  const tick = setInterval(() => { if (last?.session) draw(last); }, 5000);  // countdown only; never redraws the form
  return () => { unwatch(); clearInterval(tick); };
}
