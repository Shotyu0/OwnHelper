import { DAY_KEYS } from '../time.js';
import { effectiveGaming, gamingChange } from '../settings.js';
import { esc, $, toast } from '../ui.js';

const COLLECTIONS = ['meta', 'cards', 'reviews', 'daily', 'workouts', 'exerciseState', 'sessions', 'overrides', 'events', 'exercises'];

export async function render(main, ctx) {
  const { settings: s, user, cfg } = ctx;
  const g = effectiveGaming(s, ctx.today());
  const num = (name, value, label, attrs = '') => `<label>${label}</label><input type="number" name="${name}" value="${esc(value)}" ${attrs}>`;
  const box = (name, on, label) => `<label class="plain"><input type="checkbox" class="auto" name="${name}" ${on ? 'checked' : ''}> ${label}</label>`;
  const relay = cfg.relay ? cfg.relay.replace(/\/$/, '') + '/hc' : 'https://<your-worker>.workers.dev/hc';

  main.innerHTML = `<h1>Settings</h1><form id="f"><div class="grid">
    <div class="card"><h2>Workouts</h2>
      ${DAY_KEYS.map(d => `<div class="row spread"><span>${d[0].toUpperCase() + d.slice(1)}</span>
        <select name="sched_${d}" class="auto">${['gym', 'home', 'rest'].map(o => `<option ${s.workout.schedule[d] === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`).join('')}
      <label>Home equipment</label>${box('eq_pullup_bar', s.workout.homeEquipment.includes('pullup_bar'), 'Pull-up bar')}
      ${box('eq_dumbbells', s.workout.homeEquipment.includes('dumbbells'), 'Dumbbells')}
      <label>Units</label><select name="units">${['lb', 'kg'].map(u => `<option ${s.workout.units === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
    <div class="card"><h2>Korean</h2>
      ${num('newCardsPerDay', s.korean.newCardsPerDay, 'New cards per day', 'min="0" max="50"')}
      <p class="small muted">10/day ≈ 15–20 min of reviews once things settle.</p>
      <label>Target recall</label><select name="desiredRetention">${[0.85, 0.9, 0.95].map(r => `<option value="${r}" ${s.korean.desiredRetention === r ? 'selected' : ''}>${r * 100}%${r === 0.9 ? ' (recommended)' : ''}</option>`).join('')}</select>
      ${num('unlockTypingAfterDays', s.korean.unlockTypingAfterDays, 'Typing cards unlock when memory lasts (days)', 'min="1" max="60"')}
      <label>Day starts at (hour)</label><input type="number" name="dayStartsAtHour" value="${s.dayStartsAtHour}" min="0" max="8"></div>
    <div class="card"><h2>Activity</h2>
      ${num('stepGoal', s.activity.stepGoal, 'Daily step goal', 'min="0" step="500"')}
      ${num('restDayStepGoal', s.activity.restDayStepGoal, 'Rest-day step goal for the gaming gate (0 = off)', 'min="0" step="500"')}
      ${box('watchWorkoutCounts', s.activity.watchWorkoutCounts, 'A workout recorded on the watch (not a walk) satisfies the workout gate')}
      ${num('watchWorkoutMinMinutes', s.activity.watchWorkoutMinMinutes, '…if it lasts at least (min)', 'min="5"')}</div>
    <div class="card"><h2>Gaming</h2>
      <p class="small muted">Tighter limits apply now. Looser ones start tomorrow, so the decision isn't made mid-urge.</p>
      ${box('requireWorkout', g.requireWorkout, 'Workout before games')}
      ${box('countMinimumWorkout', g.countMinimumWorkout, 'The minimum version counts')}
      ${box('requireKoreanReviews', g.requireKoreanReviews, 'Korean reviews before games')}
      ${box('requireKoreanNewCards', g.requireKoreanNewCards, "Today's new Korean cards before games")}
      ${num('dailyCapWeekday', g.dailyCapWeekday, 'Daily cap, weekdays (min)', 'min="0"')}
      ${num('dailyCapWeekend', g.dailyCapWeekend, 'Daily cap, weekends (min)', 'min="0"')}
      ${num('cooldownMinutes', g.cooldownMinutes, 'Cooldown between sessions (min)', 'min="0"')}
      <label>Session lengths (min, comma-separated)</label><input name="sessionChoices" value="${g.sessionChoices.join(', ')}">
      ${num('overrideMaxPerDay', g.overrideMaxPerDay, 'Overrides per day', 'min="0" max="5"')}
      ${num('overrideWaitSeconds', g.overrideWaitSeconds, 'Override wait (s)', 'min="0"')}
      ${s.gamingPending ? `<div class="flash wn small mt">Looser limits waiting to start on ${esc(s.gamingPending.effective)}.</div>` : ''}</div>
  </div><p><button class="primary">Save settings</button></p></form>

  <div class="grid mt">
    <div class="card"><h2>Watch sync (Galaxy / Pixel / Wear OS)</h2>
      <ol class="small">
        <li>Make sure your watch app (Samsung Health / Fitbit) shares data with <b>Health Connect</b> (phone Settings → Health Connect → App permissions).</li>
        <li>Install <b>HC Webhook</b> (<a href="https://github.com/mcnaveen/health-connect-webhook" target="_blank" rel="noopener">github.com/mcnaveen/health-connect-webhook</a>, also on Google Play) and grant it read access.</li>
        <li>Webhook URL: <code>${esc(relay)}</code></li>
        <li>Add a header <code>Authorization</code> = <code>Bearer &lt;your HC_TOKEN&gt;</code> (the secret you gave the Worker).</li>
        <li>Data: Steps, Heart rate (1-minute), Exercise, Active calories, Distance. Sync every 30–60 min.</li>
        <li>Tap <b>Sync now</b>, then open Activity here.</li>
      </ol></div>
    <div class="card"><h2>Account &amp; data</h2>
      <p class="small">${esc(user.displayName || '')} ${user.email ? `(${esc(user.email)})` : ''}<br>uid: <code>${esc(user.uid)}</code>
        <br><span class="muted">The uid goes in firestore.rules, relay/wrangler.toml and the PC's config.toml.</span></p>
      <p class="row"><button id="export">Download a backup (JSON)</button>${ctx.auth ? '<button id="signout">Sign out</button>' : ''}</p>
      ${!cfg.firebase ? '<div class="flash wn small">Firebase isn\'t set up, so data stays in this browser only. See README.</div>' : ''}</div>
  </div>`;

  const f = $('#f', main);
  f.onsubmit = async e => {
    e.preventDefault();
    const v = n => f.elements[n];
    const n = name => Number(v(name).value);
    const workout = {
      ...s.workout, units: v('units').value,
      schedule: Object.fromEntries(DAY_KEYS.map(d => [d, v('sched_' + d).value])),
      homeEquipment: ['pullup_bar', 'dumbbells'].filter(x => v('eq_' + x).checked),
    };
    const korean = { newCardsPerDay: n('newCardsPerDay'), desiredRetention: n('desiredRetention'), unlockTypingAfterDays: n('unlockTypingAfterDays') };
    const activity = { stepGoal: n('stepGoal'), restDayStepGoal: n('restDayStepGoal'), watchWorkoutCounts: v('watchWorkoutCounts').checked, watchWorkoutMinMinutes: n('watchWorkoutMinMinutes') };
    const choices = v('sessionChoices').value.split(/[,\s]+/).map(Number).filter(x => x >= 5).sort((a, b) => a - b);
    const gaming = {
      ...g, requireWorkout: v('requireWorkout').checked, countMinimumWorkout: v('countMinimumWorkout').checked,
      requireKoreanReviews: v('requireKoreanReviews').checked, requireKoreanNewCards: v('requireKoreanNewCards').checked,
      dailyCapWeekday: n('dailyCapWeekday'), dailyCapWeekend: n('dailyCapWeekend'), cooldownMinutes: n('cooldownMinutes'),
      sessionChoices: choices.length ? choices : g.sessionChoices, overrideMaxPerDay: n('overrideMaxPerDay'), overrideWaitSeconds: n('overrideWaitSeconds'),
    };
    const { patch, delayed } = gamingChange(s, gaming, ctx.today(), ctx.tomorrow());
    await ctx.saveSettings({ workout, korean, activity, dayStartsAtHour: n('dayStartsAtHour'), ...patch });
    toast(delayed ? 'Saved. Looser gaming limits start tomorrow.' : 'Saved.', 'ok');
    render(main, ctx);
  };
  $('#export', main).onclick = async () => {
    const out = {};
    for (const c of COLLECTIONS) out[c] = await ctx.store.query(c);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }));
    a.download = `personal-helper-${ctx.today()}.json`;
    a.click();
  };
  const so = $('#signout', main);
  if (so) so.onclick = () => ctx.auth.signOut();
}
