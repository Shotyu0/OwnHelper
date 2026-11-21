import { calendarDay, fmtDateTime, DAY_KEYS } from '../time.js';
import { GOALS, SOURCES, KG_PER_LB, bodyNow, stepTarget, stepPlan, stepGoalNow, protein, lossRate, fmtWeight, fmtRate, ageOn } from '../targets.js';
import { koreanPlan, LEARN_AHEAD } from '../korean.js';
import { syncSetPlan, setText, dayLabel } from '../workout.js';
import { esc, $, toast } from '../ui.js';

const cite = keys => `<span class="small muted">${keys.map(k => `<a href="${SOURCES[k][1]}" target="_blank" rel="noopener">${esc(SOURCES[k][0].split(' — ')[0])}</a>`).join(' · ')}</span>`;

export async function render(main, ctx) {
  const { store, settings: s } = ctx;
  const now = ctx.now(), today = ctx.today(), cal = calendarDay(now);
  const units = s.workout.units;
  const [watch, steps, variants, reviews, due, daily] = await Promise.all([
    store.get('meta', 'body'),
    stepPlan(store, s, cal),
    syncSetPlan(store, s),
    store.query('reviews', { where: [['at', '>=', now - 7 * 864e5]] }),
    store.count('cards', [['due', '<=', now + LEARN_AHEAD]]),
    store.get('daily', today),
  ]);
  const p = s.profile;
  const body = bodyNow(p, watch || {}, now);
  const target = stepTarget(p, cal);
  const goal = stepGoalNow(s, steps);
  const prot = protein(body.weightKg, p.goal);
  const loss = lossRate(body.weightKg, p.goal);
  const k = koreanPlan(reviews, s.korean, due);
  const sessionsPerWeek = Object.values(s.workout.schedule).filter(x => x !== 'rest').length;
  const lunchDays = Object.values(s.workout.schedule).filter(x => x === 'gym30').length;
  const restDays = DAY_KEYS.filter(d => s.workout.schedule[d] === 'rest');
  const g = s.gaming;
  const wInput = p.weightKg ? (units === 'kg' ? Math.round(p.weightKg * 10) / 10 : Math.round(p.weightKg / KG_PER_LB)) : '';
  const age = ageOn(p, today);
  const stepChange = {
    start: `Starts 1,000 above your baseline of ${steps.baseline?.toLocaleString()} a day.`,
    up: `You hit last week's goal on ${steps.lastWeek?.hit} days, so it went up 1,000.`,
    down: `Last week's goal was hit on only ${steps.lastWeek?.hit} days, so it eased off 500.`,
    hold: `Same as last week (hit on ${steps.lastWeek?.hit ?? 0} days; 5 moves it up).`,
    'at-target': "You're at the target. Keep it there.",
  }[steps.change] || '';

  main.innerHTML = `<h1>Plan</h1>
    <p class="muted">Your targets, worked out from your profile, your watch and the research below. They adjust as data comes in.</p>
    <div class="grid">
      <div class="card"><h2>You</h2>
        <form id="pf">
          <label>Goal</label><select name="goal">${Object.entries(GOALS).map(([v, l]) => `<option value="${v}" ${p.goal === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
          <label>Birth year</label><input type="number" name="birthYear" min="1930" max="2015" value="${p.birthYear || ''}" placeholder="e.g. 1998">
          <label>Weight (${units})${body.weightFrom === 'watch' ? ' <span class="small muted">— the watch reading is used while it\'s recent</span>' : ''}</label>
          <input type="number" name="weight" step="0.1" min="30" max="700" value="${wInput}">
          <p><button class="primary">Save</button></p></form>
        <h3 class="mt">From your watch</h3>
        ${watch ? `<table class="small">
          ${row('Weight', watch.weightKg, v => fmtWeight(v, units))}
          ${row('Body fat', watch.bodyFat, v => v.toFixed(1) + '%')}
          ${row('Resting heart rate', watch.restingHr, v => Math.round(v) + ' bpm')}
          ${row('VO2 max', watch.vo2max, v => v.toFixed(1) + ' ml/kg/min')}</table>
          <p class="small muted">Resting HR going down and VO2 max going up are the clearest signs your fitness is improving. VO2 max is one of the strongest predictors of long-term health.</p>`
        : `<p class="small muted">Nothing yet. In HC Webhook, also tick <b>Weight</b>, <b>Resting heart rate</b>, <b>VO2 max</b> and <b>Body fat</b>.</p>`}
      </div>

      <div class="card"><h2>Steps</h2>
        ${s.activity.stepGoalAuto
          ? steps.goal ? `<div class="big">${steps.goal.toLocaleString()}<span class="muted unit"> / day this week</span></div>
              <p class="small">Heading to <b>${target.steps.toLocaleString()}</b>. ${esc(stepChange)}</p>`
            : `<div class="big">${goal.toLocaleString()}<span class="muted unit"> for now</span></div>
              <p class="small">Measuring your baseline: ${steps.measuring || 0} of 4 days of watch data so far. Then the goal starts just above
              what you already do and climbs 1,000 a week when you hit it on 5 days, up to <b>${target.steps.toLocaleString()}</b>.</p>`
          : `<div class="big">${goal.toLocaleString()}</div><p class="small">Set by hand in Settings.</p>`}
        <p class="small muted">${esc(target.why)} Small steps up from your own baseline, because sticking with the goal is what predicted results.</p>
        ${cite(target.sources)}</div>

      ${s.moveBreaks.treadmill ? `<div class="card"><h2>Treadmill desk</h2>
        <div class="big">${s.moveBreaks.enabled ? `walk after ${s.moveBreaks.everyMinutes} min sitting` : 'nudges off'}</div>
        <p class="small">After ${s.moveBreaks.everyMinutes} minutes of sitting at the PC, a nudge: raise the desk and walk for ${s.moveBreaks.walkMinutes}+ minutes.
          "Walking now" pauses the nudges while you walk. Walk for calls, meetings, reading, email and code review; sit for hard focused coding.
          About 1.5 mph (2.4 km/h) while typing, faster on calls. At that pace you take roughly 80–100 steps a minute, so 15 minutes is ~1,300 steps
          and a few blocks a day cover most of the step goal.
          ${daily?.moveNudges ? `<br>Today: walked after <b>${daily.moveBreaks || 0}</b> of ${daily.moveNudges} nudges.` : ''}</p>
        <p class="small muted">Walk, don't just stand: 5 minutes of easy walking every 30 minutes cut blood-sugar spikes after meals by about 58% and lowered blood pressure,
          while in a large study, standing more did not lower heart-disease risk (and over 2 hours a day was linked to circulation problems).
          Studies on working while walking are mixed: some found no loss in typing or thinking, one found typing a bit slower at 1.5 mph.</p>
        ${cite(['duran2023', 'ahmadi2024', 'desk2020', 'desk2015'])}</div>`
      : `<div class="card"><h2>Desk breaks</h2>
        <div class="big">${s.moveBreaks.enabled ? `every ${s.moveBreaks.everyMinutes} min` : 'off'}</div>
        <p class="small">After ${s.moveBreaks.everyMinutes} minutes at the PC, a small nudge: walk for 3–5 minutes. It clears itself once you've been away ${s.moveBreaks.awayMinutes} minutes.
          ${daily?.moveNudges ? `<br>Today: got up after <b>${daily.moveBreaks || 0}</b> of ${daily.moveNudges} nudges.` : ''}</p>
        <p class="small muted">In a lab trial, 5 minutes of easy walking every 30 minutes cut blood-sugar spikes after meals by about 58% and lowered blood
          pressure; every dose tried lowered blood pressure. A day of programming has ~16 of these slots, and they add up to a lot of the step goal.</p>
        ${cite(['duran2023'])}</div>`}

      <div class="card"><h2>Sets while gaming</h2>
        <div class="big">${g.setEveryMinutes > 0 ? `every ${g.setEveryMinutes} min` : 'off'}<span class="muted unit"> of play</span></div>
        <p class="small">Alternating:<br>A: <b>${esc(setText(variants[0]))}</b><br>B: <b>${esc(setText(variants[1]))}</b></p>
        <p class="small">Sized from your home-workout levels at about 70% of the bottom of the rep range, so it stays well short of failure and
          doesn't hurt your next workout. When you level up in a workout, the sets follow.
          ${g.setsRequired ? 'If a set is overdue, the game is closed until you log it.' : 'Overdue sets only remind you.'}</p>
        <p class="small muted">Brief "exercise snacks" through the day build strength and fitness; with weekly volume equal, splitting it into more,
          smaller bouts works about as well; 1–2 minute bursts of vigorous effort in daily life are linked to lower mortality.
          Your watch checks each set afterwards by looking for a heart-rate rise. It can't unlock the game itself, because it syncs in batches every 15+ minutes.</p>
        ${cite(['minDose2024', 'freq2019', 'daily2022', 'vilpa2022'])}</div>

      <div class="card"><h2>Training &amp; food</h2>
        <table class="small">${DAY_KEYS.map(d => `<tr><td>${d[0].toUpperCase() + d.slice(1)}</td><td>${esc(dayLabel(s.workout.schedule[d]))}</td></tr>`).join('')}</table>
        ${lunchDays ? `<p class="small"><b>Lunch sessions (30 min)</b> alternate <b>upper</b> (bench press + cable row, overhead press + lat pulldown) and
          <b>lower</b> (squat + leg curl, Romanian deadlift + cable crunch), so each muscle is trained twice a week. Each pair is a superset:
          alternate the two moves with ${s.workout.restSuperset} s rest, 3 rounds, after 1–2 light warm-up sets. That's 12 hard sets in about 25 minutes.</p>` : ''}
        <p class="small">${sessionsPerWeek} lifting sessions a week with progressive overload (more reps, then more weight). For <b>${esc(GOALS[p.goal] || '')}</b>,
          lifting is what tells your body to keep and build muscle while you lose fat. The sets during gaming add push, squat and hinge volume on top.</p>
        ${restDays.some(d => d === 'sat' || d === 'sun') ? `<p class="small"><b>Weekends:</b> no lifting (four sessions is plenty to recover from). Do one
          45–60 minute <b>brisk</b> walk or hike, or incline walking on the treadmill: brisk means about 100+ steps a minute, where talking gets
          a little harder. Lunch lifting and slow desk walking don't count as cardio. This brings you toward the 150+ minutes of moderate activity a week
          that guidelines recommend, and is what raises VO2 max. Missed a lunch? The 10-minute minimum version at home still counts.</p>` : ''}
        ${prot ? `<p class="small">Protein: <b>${prot.low}–${prot.high} g a day</b> (${prot.perKg[0]}–${prot.perKg[1]} g per kg).</p>`
          : '<p class="small muted">Add your weight for a protein target.</p>'}
        ${loss ? `<p class="small">Weight change: lose about <b>${fmtRate(loss.lowKg, units)}–${fmtRate(loss.highKg, units)} a week</b>
          (${loss.pct[0]}–${loss.pct[1]}% of body weight). Faster loss costs muscle. If you're new to lifting, you can gain muscle even while losing slowly.</p>` : ''}
        <p class="small muted">Weekly sets per muscle drive growth (more sets, more growth, up to a point). Protein gains level off around 1.6 g/kg on average,
          and up to 2.2 g/kg covers almost everyone. Athletes losing 0.7% a week kept more muscle and strength than at 1.4%.</p>
        ${cite(['iversen2021', 'volume2017', 'who2020', 'cadence2018', 'protein2018', 'garthe2011'])}</div>

      <div class="card"><h2>Korean</h2>
        <div class="big">${s.korean.autoNewCards ? k.newPerDay : s.korean.newCardsPerDay}<span class="muted unit"> new words today</span></div>
        <p class="small">${s.korean.autoNewCards ? `Sized for <b>${s.korean.minutesPerDay} min a day</b>: each new word adds about ${k.perWordMin} min to your daily
          reviews once things settle, so ${k.steady} a day fills the budget. ${k.newPerDay < k.steady ? `Fewer today because ${k.dueNow} reviews are already due.` : ''}`
          : 'Set by hand in Settings.'}</p>
        <p class="small muted">Your speed: ${k.secRead}s per reading review${k.measured.read ? '' : ' (estimate)'}, ${k.secType}s per typing review${k.measured.type ? '' : ' (estimate)'},
          ${k.secNew}s per new card${k.measured.fresh ? '' : ' (estimate)'}. Estimates are replaced by your own medians once there are 10+ answers of a kind.</p>
        <p class="small muted">Spaced reviews beat cramming, and recalling beats re-reading. FSRS times each review for ${Math.round(s.korean.desiredRetention * 100)}% recall.
          Typing unlocks after a word's reading memory lasts ${s.korean.unlockTypingAfterDays} days, because recognizing a word comes before producing it.</p>
        ${cite(['cepeda2006', 'fsrs'])}</div>
    </div>
    <div class="card mt"><h2>Research</h2><ul class="small">
      ${Object.values(SOURCES).map(([t, u]) => `<li><a href="${u}" target="_blank" rel="noopener">${esc(t)}</a></li>`).join('')}</ul>
      <p class="small muted">${age ? `Age ${age}. ` : ''}Numbers that depend on your data say so. Everything else is a population average, used as a starting point.</p></div>`;

  function row(label, v, f) {
    return v ? `<tr><td>${label}</td><td><b>${esc(f(v[0]))}</b></td><td class="muted">${fmtDateTime(v[1])}</td></tr>` : '';
  }

  $('#pf', main).onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const w = Number(f.weight.value);
    const profile = {
      ...p, goal: f.goal.value, birthYear: Number(f.birthYear.value) || null,
      weightKg: w ? Math.round((units === 'kg' ? w : w * KG_PER_LB) * 10) / 10 : null,
    };
    await ctx.saveSettings({ profile });
    toast('Saved.', 'ok');
    render(main, ctx);
  };
}
