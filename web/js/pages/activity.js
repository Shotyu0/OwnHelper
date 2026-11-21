import { addDays, calendarDay, fmtDateTime, fmtDuration, parseDay } from '../time.js';
import { summarize, heartSeries, exerciseName } from '../activity.js';
import { esc, lineChart, bars } from '../ui.js';
import { watchCounts } from '../workout.js';

export async function render(main, ctx, params) {
  const { store, settings } = ctx;
  const day = params.day || calendarDay(ctx.now());
  const from = addDays(day, -29);
  const [doc, exercises, daily] = await Promise.all([
    store.get('activity', day),
    store.query('exercises', { where: [['day', '>=', addDays(day, -13)]] }),
    store.query('daily', { where: [['day', '>=', from]] }),
  ]);
  const todays = exercises.filter(x => x.day === day);
  const s = summarize(doc, todays);
  const goal = settings.activity.stepGoal;
  const byDay = Object.fromEntries(daily.map(d => [d.day, d]));
  const stepBars = [];
  for (let d = from; d <= day; d = addDays(d, 1)) stepBars.push({ v: byDay[d]?.steps || 0, tip: `${d}: ${(byDay[d]?.steps || 0).toLocaleString()} steps` });
  const avgSteps = Math.round(stepBars.reduce((n, b) => n + b.v, 0) / Math.max(1, stepBars.filter(b => b.v).length));

  // 5-minute averages keep the chart readable.
  const buckets = new Map();
  for (const p of heartSeries(doc)) {
    const k = Math.floor(p.minute / 5) * 5, b = buckets.get(k) || [0, 0];
    buckets.set(k, [b[0] + p.avg, b[1] + 1]);
  }
  const hrPts = [...buckets].map(([m, [sum, n]]) => ({ x: m, y: Math.round(sum / n) }));
  const label = parseDay(day).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });

  main.innerHTML = `<div class="spread"><h1>Activity</h1>
      <span class="row"><a class="btn" href="#/activity?day=${addDays(day, -1)}">‹</a><b>${esc(label)}</b>
      ${day < calendarDay(ctx.now()) ? `<a class="btn" href="#/activity?day=${addDays(day, 1)}">›</a>` : ''}</span></div>
    ${!doc && !exercises.length ? `<div class="flash wn">No watch data yet. Set up the HC Webhook app on your phone — Settings has the steps.</div>` : ''}
    <div class="grid">
      <div class="card"><h2>Steps</h2><div class="big">${s.steps.toLocaleString()}</div>
        <div class="bar"><div style="width:${Math.min(100, (s.steps / goal) * 100)}%;background:var(--good)"></div></div>
        <p class="small muted">Goal ${goal.toLocaleString()}. Benefits for health and lifespan level off around
          7,000–8,000 steps a day (Paluch et al., 2022).</p></div>
      <div class="card"><h2>Active</h2><div class="big">${s.activeMinutes}<span class="muted unit"> min</span></div>
        <p class="small">${s.kcal ? `${s.kcal} active kcal · ` : ''}${s.km ? `${s.km.toFixed(1)} km` : ''}</p>
        <p class="small muted">Recorded workouts. Guidelines: 150+ min of moderate activity a week, plus strength training twice a week.</p></div>
      <div class="card"><h2>Heart rate</h2><div class="big">${s.restingHr ?? '—'}<span class="muted unit"> bpm lowest</span></div>
        <p class="small muted">${s.updatedAt ? 'Synced ' + fmtDateTime(s.updatedAt) : ''}</p></div>
    </div>
    <div class="card mt"><h2>Heart rate through the day</h2>
      ${lineChart(hrPts, { xMin: 0, xMax: 1440, label: v => v + '' })}
      <div class="spread small muted"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>12am</span></div></div>
    <div class="card mt"><h2>Steps, last 30 days <span class="muted small">avg ${avgSteps.toLocaleString()}</span></h2>${bars(stepBars, { goal })}</div>
    <div class="card mt"><h2>Watch workouts, last 2 weeks</h2>
      ${exercises.length ? `<table><tr><th>When</th><th>Type</th><th>Duration</th><th></th></tr>
        ${exercises.sort((a, b) => b.start - a.start).map(x => `<tr><td>${fmtDateTime(x.start)}</td><td>${esc(exerciseName(x.type))}</td>
          <td>${fmtDuration(x.dur / 60)}</td><td class="small muted">${x.steps ? x.steps.toLocaleString() + ' steps' : ''}
          ${watchCounts(x, settings.activity) ? '<span class="pill ok">counts as workout</span>' : ''}</td></tr>`).join('')}
        </table>` : '<p class="muted small">None yet.</p>'}
      <p class="small muted">Watch workouts of ${settings.activity.watchWorkoutMinMinutes}+ min (not walks) count toward the workout gate
        (change in Settings).</p></div>`;
}
