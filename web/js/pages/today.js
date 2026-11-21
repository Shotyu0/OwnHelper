import { addDays, parseDay, calendarDay, fmtDateTime, fmtDuration } from '../time.js';
import { counts } from '../korean.js';
import { scheduled, streak, consistency, workoutStatus, watchCounts, syncSetPlan, setText, dayLabel } from '../workout.js';
import { summarize } from '../activity.js';
import { effectiveGaming } from '../settings.js';
import { stepPlan, stepGoalNow } from '../targets.js';
import { esc, pill, check, heatmap } from '../ui.js';

/** Inputs for the gate. The PC guardian computes the same thing (helper/gaming/rules.py) to enforce it. */
export async function gateInputs(ctx) {
  const { store, settings } = ctx;
  const today = ctx.today(), start = ctx.dayStart(today), now = ctx.now();
  const [workouts, watchSessions, korean, activityDoc] = await Promise.all([
    store.query('workouts', { where: [['day', '==', today]] }),
    store.query('exercises', { where: [['start', '>=', start]] }),
    counts(store, settings.korean, now, start),
    store.get('activity', calendarDay(now)),
  ]);
  const ws = workoutStatus({ settings, today, workouts, watchSessions });
  const steps = summarize(activityDoc).steps;
  const g = effectiveGaming(settings, today), a = settings.activity;
  const items = [];
  if (g.requireWorkout) {
    const detail = ws.doneAs === 'done' ? 'Done' : ws.doneAs === 'minimum' ? 'Minimum version done'
      : ws.doneAs === 'watch' ? `Watch workout (${fmtDuration(ws.watch.dur / 60)})` : ws.scheduled === 'rest' ? 'Rest day'
        : `Today's ${dayLabel(ws.scheduled)} workout isn't logged yet`;
    items.push({ key: 'workout', label: 'Workout', ok: ws.satisfied, detail, href: '#/workout' });
  }
  if (ws.scheduled === 'rest' && a.restDayStepGoal > 0) {
    items.push({ key: 'steps', label: 'Rest-day walk', ok: steps >= a.restDayStepGoal,
      detail: `${steps.toLocaleString()} / ${a.restDayStepGoal.toLocaleString()} steps`, href: '#/activity' });
  }
  if (g.requireKoreanReviews || g.requireKoreanNewCards) {
    const parts = [];
    if (g.requireKoreanReviews && korean.due) parts.push(`${korean.due} reviews due`);
    if (g.requireKoreanNewCards && korean.newLeft) parts.push(`${korean.newLeft} new cards left`);
    items.push({ key: 'korean', label: 'Korean', ok: !parts.length, detail: parts.join(', ') || 'Done for today', href: '#/study' });
  }
  return { items, ws, korean, steps, activityDoc, watchSessions };
}

export async function render(main, ctx) {
  const { store, settings } = ctx;
  const today = ctx.today();
  const weeks = 16;
  const first = addDays(today, -((parseDay(today).getDay() + 6) % 7) - 7 * (weeks - 1));
  const since = addDays(today, -180) > ctx.startedOn ? addDays(today, -180) : ctx.startedOn;
  const weekAgo = ctx.now() - 7 * 864e5;
  const [gate, daily, workouts, exercises, overrides, events, gaming, steps] = await Promise.all([
    gateInputs(ctx),
    store.query('daily', { where: [['day', '>=', first]] }),
    store.query('workouts', { where: [['day', '>=', first < since ? first : since]] }),
    store.query('exercises', { where: [['day', '>=', first]] }),
    store.query('overrides', { where: [['at', '>=', weekAgo]] }),
    store.query('events', { where: [['at', '>=', weekAgo]] }),
    store.get('meta', 'gaming'),
    stepPlan(store, settings, calendarDay(ctx.now())),
  ]);
  syncSetPlan(store, settings).catch(e => console.warn('set plan', e));   // the PC guardian reads it
  const a = settings.activity;
  const stepGoal = stepGoalNow(settings, steps);
  const doneDays = new Set(workouts.filter(w => w.status === 'done' || w.status === 'minimum').map(w => w.day));
  for (const x of exercises) if (watchCounts(x, a)) doneDays.add(x.day);
  const st = streak(doneDays, settings, today, ctx.startedOn);
  const cons = consistency(doneDays, settings, today, ctx.startedOn);
  const act = summarize(gate.activityDoc, gate.watchSessions);
  const byDay = Object.fromEntries(daily.map(d => [d.day, d]));
  const wkByDay = {};
  for (const w of workouts) if (w.status !== 'in_progress') wkByDay[w.day] = wkByDay[w.day] === 'done' ? 'done' : w.status;
  for (const x of exercises) if (!wkByDay[x.day] && watchCounts(x, a)) wkByDay[x.day] = 'watch';

  const g = gaming && ctx.now() - gaming.at < 3 * 60e3 ? gaming : null;
  const gateOk = gate.items.every(i => i.ok);
  const days = [];
  for (let d = first; d <= addDays(today, 6 - ((parseDay(today).getDay() + 6) % 7)); d = addDays(d, 1)) days.push(d);
  const cells = fn => days.map(day => ({ day, future: day > today || day < ctx.startedOn, ...fn(day, byDay[day] || {}) }));
  const cap = g?.cap || null;
  const sets = g?.sets;
  const mins = t => Math.max(0, Math.round((t - ctx.now()) / 60e3));

  main.innerHTML = `
  <div class="spread"><h1>${parseDay(today).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</h1>
    ${g ? pill('Guardian on', 'ok') : pill('PC guardian offline', 'wn')}</div>
  <div class="card mb">
    <div class="spread"><h2 class="m0">Before games</h2>
      ${g?.session ? pill('Session running', 'wn') : gateOk ? pill('Games unlocked', 'ok') : pill('Games locked', 'no')}</div>
    ${gate.items.map(i => check(i.ok, i.label, i.detail, i.ok ? '' : `<a class="btn primary" href="${i.href}">Go</a>`)).join('')}
  </div>
  <div class="grid">
    <div class="card">
      <h2>Workout</h2>
      <div class="big">${st.streak}</div><div class="muted small">session streak (rest days don't count against you)</div>
      <p class="small">Today: <b>${esc(dayLabel(scheduled(settings, today)))}</b> ${gate.ws.done ? pill(gate.ws.doneAs === 'watch' ? 'watch' : 'done', 'ok') : ''}
        <br>Last 4 weeks: ${cons.pct == null ? '—' : `<b>${cons.hit}/${cons.planned}</b> sessions (${Math.round(cons.pct * 100)}%)`}</p>
      ${st.missedLast && gate.ws.scheduled !== 'rest' && !gate.ws.done ? `<div class="flash wn small">You missed the last session.
        Missing once doesn't matter — just don't miss twice. The 10-minute minimum version counts.</div>` : ''}
    </div>
    <div class="card">
      <h2>Korean</h2>
      <div class="big">${gate.korean.known}</div><div class="muted small">cards learning</div>
      <p class="small">Due now: <b>${gate.korean.due}</b> · New left today: <b>${gate.korean.newLeft}</b><br>Reviewed today: ${gate.korean.reviewedToday}</p>
      <a class="btn ${gate.korean.done ? '' : 'primary'}" href="#/study">${gate.korean.done ? 'Done — review ahead?' : 'Study'}</a>
    </div>
    <div class="card">
      <h2>Activity</h2>
      <div class="big">${act.steps.toLocaleString()}<span class="muted unit"> / ${stepGoal.toLocaleString()} steps</span></div>
      <div class="bar"><div style="width:${Math.min(100, (act.steps / stepGoal) * 100)}%;background:var(--good)"></div></div>
      ${a.stepGoalAuto && steps.goal && steps.target > steps.goal ? `<p class="small muted m0">This week's goal, on the way to ${steps.target.toLocaleString()} (<a href="#/plan">why</a>)</p>` : ''}
      <p class="small">${act.activeMinutes ? `Active: <b>${act.activeMinutes} min</b> · ` : ''}${act.restingHr ? `Lowest HR: ${act.restingHr} bpm` : ''}
        ${act.updatedAt ? `<br><span class="muted">Watch synced ${fmtDateTime(act.updatedAt)}</span>` : '<br><span class="muted">No watch data yet — see Settings</span>'}</p>
    </div>
    <div class="card">
      <h2>Gaming</h2>
      ${g?.session ? (g.session.plannedEnd ? `<div class="big">${mins(g.session.plannedEnd)}m</div>
          <div class="muted small">left · then: ${esc(g.session.nextAction)}</div>`
          : `<div class="big">${Math.round(g.used || 0)}<span class="muted unit"> min today</span></div><div class="muted small">open session · then: ${esc(g.session.nextAction)}</div>`)
          + (sets?.dueAt ? `<p class="small">Next set ${sets.dueAt > ctx.now() ? `in <b>${mins(sets.dueAt)} min</b>` : '<b>now</b>'}: ${esc(setText(sets.next))}</p>` : '')
        : `<div class="big">${Math.round(g?.used || byDay[today]?.gameMinutes || 0)}<span class="muted unit"> ${cap ? `/ ${cap} ` : ''}min</span></div>
          ${cap ? `<div class="bar"><div style="width:${Math.min(100, ((g?.used || 0) / cap) * 100)}%"></div></div>` : '<div class="muted small">no daily cap</div>'}
          ${sets ? `<p class="small">${sets.today} set${sets.today === 1 ? '' : 's'} today · one every ${sets.every} min of play</p>` : ''}
          ${g?.cooldownLeft > 0 ? `<p class="small">Cooldown: ${Math.round(g.cooldownLeft)} min</p>` : ''}`}
      <p><a class="btn" href="#/gaming">${g?.session ? 'Session' : 'Plan a session'}</a></p>
    </div>
  </div>
  <div class="card mt">
    <h2>Last ${weeks} weeks</h2>
    <div class="small muted hl">Workouts</div>
    ${heatmap(cells((d, x) => {
      const w = wkByDay[d];
      return { cls: w === 'done' || w === 'watch' ? 'w2' : w === 'minimum' ? 'w1' : scheduled(settings, d) === 'rest' ? 'rest' : '', tip: w || (scheduled(settings, d) === 'rest' ? 'rest day' : 'missed') };
    }))}
    <div class="small muted hl">Korean reviews</div>
    ${heatmap(cells((d, x) => ({ cls: x.reviews >= 60 ? 'k3' : x.reviews >= 25 ? 'k2' : x.reviews > 0 ? 'k1' : '', tip: `${x.reviews || 0} reviews` })))}
    <div class="small muted hl">Steps</div>
    ${heatmap(cells((d, x) => ({ cls: x.steps >= stepGoal ? 'w2' : x.steps >= stepGoal / 2 ? 'w1' : '', tip: `${(x.steps || 0).toLocaleString()} steps` })))}
    <div class="small muted hl">Gaming</div>
    ${heatmap(cells((d, x) => ({ cls: x.gameMinutes > (cap || 180) ? 'g3' : x.gameMinutes >= 60 ? 'g2' : x.gameMinutes > 0 ? 'g1' : '', tip: `${Math.round(x.gameMinutes || 0)} min` })))}
  </div>
  ${overrides.length || events.some(e => !['blocked', 'closed'].includes(e.kind)) ? `<div class="card mt"><h2>Accountability</h2>
    ${overrides.map(o => `<div class="check">${pill('override', 'wn')}<div><b>${fmtDateTime(o.at)}</b> — ${esc(o.reason)}
      <span class="muted small">(${esc(o.detail || '')})</span></div></div>`).join('')}
    ${events.filter(e => ['offline', 'kill_failed', 'set_missed'].includes(e.kind)).map(e => `<div class="check">${pill(e.kind.replace('_', ' '), 'no')}
      <div><b>${fmtDateTime(e.at)}</b> — ${esc(e.detail)}</div></div>`).join('')}</div>` : ''}`;
}
