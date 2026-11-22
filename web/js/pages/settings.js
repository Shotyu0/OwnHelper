import { DAY_KEYS, fmtDateTime } from '../time.js';
import { effectiveGaming, gamingChange } from '../settings.js';
import { DAY_TYPES, parseSetMenu, formatSetMenu, setPlan, toStored } from '../workout.js';
import { esc, $, toast } from '../ui.js';

const COLLECTIONS = ['meta', 'cards', 'reviews', 'daily', 'workouts', 'exerciseState', 'sessions', 'snacks', 'overrides', 'events',
  'exercises', 'activity'];

export async function render(main, ctx) {
  const { settings: s, user, cfg } = ctx;
  const g = effectiveGaming(s, ctx.today());
  const num = (name, value, label, attrs = '') => `<label>${label}</label><input type="number" name="${name}" value="${esc(value)}" ${attrs}>`;
  const box = (name, on, label) => `<label class="plain"><input type="checkbox" class="auto" name="${name}" ${on ? 'checked' : ''}> ${label}</label>`;
  // meta/relay {url, token} is written when the relay is deployed, so the phone can copy them from here.
  const [hook = {}, sync] = (await Promise.all([ctx.store.get('meta', 'relay'), ctx.store.get('meta', 'sync')]).catch(() => [])).map(x => x || undefined);
  const got = sync?.counts ? Object.entries(sync.counts).filter(([, n]) => n > 0) : [];
  const syncLine = !sync ? '<div class="flash wn small">No sync has reached the relay yet.</div>'
    : `<div class="flash ${got.length ? 'ok' : 'wn'} small">Last sync: <b>${fmtDateTime(sync.at)}</b>. ${got.length
      ? 'Received ' + got.map(([k, n]) => `${n} ${esc(k.replace(/_/g, ' '))}`).join(', ') + '.'
      : 'It arrived but was empty: Health Connect had nothing to send. Check step 1 (Google Health → Health Connect) and the permissions in HC Webhook, then sync again.'}</div>`;
  const relay = hook.url || (cfg.relay ? cfg.relay.replace(/\/$/, '') + '/hc' : 'https://<your-worker>.workers.dev/hc');
  const copyValues = { url: relay, name: 'Authorization', header: hook.token ? 'Bearer ' + hook.token : '' };
  const copyBtn = k => (copyValues[k] ? ` <button type="button" class="small" data-copy="${k}">Copy</button>` : '');

  main.innerHTML = `<h1>Settings</h1><form id="f"><div class="grid">
    <div class="card"><h2>Workouts</h2>
      ${DAY_KEYS.map(d => `<div class="row spread"><span>${d[0].toUpperCase() + d.slice(1)}</span>
        <select name="sched_${d}" class="auto">${Object.entries(DAY_TYPES).map(([o, label]) => `<option value="${o}" ${s.workout.schedule[d] === o ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></div>`).join('')}
      <label>Home equipment</label>${box('eq_pullup_bar', s.workout.homeEquipment.includes('pullup_bar'), 'Pull-up bar')}
      ${box('eq_dumbbells', s.workout.homeEquipment.includes('dumbbells'), 'Dumbbells')}
      <label>Units</label><select name="units">${['lb', 'kg'].map(u => `<option ${s.workout.units === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
    <div class="card"><h2>Korean</h2>
      ${num('minutesPerDay', s.korean.minutesPerDay, 'Minutes a day', 'min="5" max="180"')}
      ${box('autoNewCards', s.korean.autoNewCards, 'Size new words to fit those minutes (measured from your own speed)')}
      ${num('newCardsPerDay', s.korean.newCardsPerDay, 'New cards per day (when the box above is off)', 'min="0" max="50"')}
      <label>Target recall</label><select name="desiredRetention">${[0.85, 0.9, 0.95].map(r => `<option value="${r}" ${s.korean.desiredRetention === r ? 'selected' : ''}>${r * 100}%${r === 0.9 ? ' (recommended)' : ''}</option>`).join('')}</select>
      ${num('unlockTypingAfterDays', s.korean.unlockTypingAfterDays, 'Typing cards unlock when memory lasts (days)', 'min="1" max="60"')}
      <label>Day starts at (hour)</label><input type="number" name="dayStartsAtHour" value="${s.dayStartsAtHour}" min="0" max="8"></div>
    <div class="card"><h2>Activity</h2>
      ${box('stepGoalAuto', s.activity.stepGoalAuto, 'Weekly step goal that climbs from my baseline (see Plan)')}
      ${num('stepGoal', s.activity.stepGoal, 'Step goal (when the box above is off, or until there\'s watch data)', 'min="0" step="500"')}
      ${num('restDayStepGoal', s.activity.restDayStepGoal, 'Rest-day step goal for the gaming gate (0 = off)', 'min="0" step="500"')}
      ${box('watchWorkoutCounts', s.activity.watchWorkoutCounts, 'A workout recorded on the watch (not a walk) satisfies the workout gate')}
      ${num('watchWorkoutMinMinutes', s.activity.watchWorkoutMinMinutes, '…if it lasts at least (min)', 'min="5"')}</div>
    <div class="card"><h2>Desk breaks (PC)</h2>
      ${box('moveEnabled', s.moveBreaks.enabled, 'Nudge me to get up and walk')}
      ${box('moveTreadmill', s.moveBreaks.treadmill, 'I have a treadmill under my desk (walk while working)')}
      ${num('moveWalk', s.moveBreaks.walkMinutes, '"Walking now" pauses nudges for (min)', 'min="5" max="120"')}
      ${num('moveEvery', s.moveBreaks.everyMinutes, 'After this long at the desk (min)', 'min="10" max="120"')}
      ${num('moveSnooze', s.moveBreaks.snoozeMinutes, 'Snooze (min)', 'min="5" max="120"')}
      <p class="small muted">Not shown while gaming; the sets cover that.</p></div>
    <div class="card"><h2>Gaming</h2>
      <p class="small muted">Tighter limits apply now. Looser ones start tomorrow, so the decision isn't made mid-urge.</p>
      ${box('requireWorkout', g.requireWorkout, 'Workout before games')}
      ${box('countMinimumWorkout', g.countMinimumWorkout, 'The minimum version counts')}
      ${box('requireKoreanReviews', g.requireKoreanReviews, 'Korean reviews before games')}
      ${box('requireKoreanNewCards', g.requireKoreanNewCards, "Today's new Korean cards before games")}
      ${num('setEveryMinutes', g.setEveryMinutes, 'A set every … minutes of play (0 = off)', 'min="0" max="120"')}
      ${box('setsRequired', g.setsRequired, 'Close the game when a set is overdue')}
      <label>Your sets (one line per set; they take turns. Leave empty to use your workout levels.)</label>
      <textarea name="setMenu" rows="3" placeholder="${esc(formatSetMenu(setPlan(s, {})))}">${esc(formatSetMenu(g.setMenu))}</textarea>
      <p class="small muted">e.g. <code>6 Push-up + 15 Bodyweight squat + Bar curls (stop 2 short of failure)</code></p>
      ${num('dinnerMinutes', g.dinnerMinutes, 'Dinner break: sets wait this long while you eat (min, 0 = off)', 'min="0" max="90"')}
      ${num('dinnerFrom', g.dinnerFrom, '…can start from (hour, 0–23)', 'min="0" max="23"')}
      ${num('dinnerTo', g.dinnerTo, '…until (hour, 1–24)', 'min="1" max="24"')}
      ${num('afkMinutes', g.afkMinutes, 'Away from the PC after … min with no keyboard or mouse: sets pause, and the game isn\'t closed until you\'re back (0 = off)', 'min="0" max="30"')}
      ${num('dailyCapWeekday', g.dailyCapWeekday, 'Daily cap, weekdays (min, 0 = none)', 'min="0"')}
      ${num('dailyCapWeekend', g.dailyCapWeekend, 'Daily cap, weekends (min, 0 = none)', 'min="0"')}
      ${num('cooldownMinutes', g.cooldownMinutes, 'Cooldown between sessions (min)', 'min="0"')}
      <label>Session lengths (min, comma-separated, 0 = no limit)</label><input name="sessionChoices" value="${g.sessionChoices.join(', ')}">
      ${num('overrideMaxPerDay', g.overrideMaxPerDay, 'Overrides per day', 'min="0" max="5"')}
      ${num('overrideWaitSeconds', g.overrideWaitSeconds, 'Override wait (s)', 'min="0"')}
      ${s.gamingPending ? `<div class="flash wn small mt">Looser limits waiting to start on ${esc(s.gamingPending.effective)}.</div>` : ''}</div>
  </div><p><button class="primary">Save settings</button></p></form>

  <div class="grid mt">
    <div class="card" id="watch"><h2>Watch sync</h2>
      ${syncLine}
      <ol class="small">
        <li><b>Pixel Watch:</b> in the <b>Google Health</b> app (formerly Fitbit), turn on sharing with <b>Health Connect</b> and allow all data.
          <b>Galaxy Watch:</b> Samsung Health → Settings → Health Connect. (Or phone Settings → search "Health Connect" → App permissions.)</li>
        <li>Install <b>HC Webhook</b> from Google Play (<a href="https://github.com/mcnaveen/health-connect-webhook" target="_blank" rel="noopener">about it</a>),
          open it, tap <b>Grant permissions</b> and allow: Steps, Heart rate, Exercise, Active calories, Distance, Weight, Resting heart rate, VO2 max, Body fat.</li>
        <li>Add a webhook. URL: <code>${esc(relay)}</code>${copyBtn('url')}</li>
        <li>Add a header. Name: <code>Authorization</code>${copyBtn('name')} Value: <code>${hook.token ? 'Bearer ••••••••' : 'Bearer &lt;your HC_TOKEN&gt;'}</code>${copyBtn('header')}</li>
        <li>Sync mode <b>Interval, 15 min</b>. Save, tap <b>Sync now</b>, then open Activity here.</li>
        <li>Phone Settings → Apps → HC Webhook → Battery → <b>Unrestricted</b>, so Android doesn't pause the syncs.</li>
        <li>Heart rate all day is needed to check your gaming sets: Pixel Watch does this by default; on a Galaxy Watch set it to
          <b>measure continuously</b> (Galaxy Wearable → Watch settings → Samsung Health → Heart rate).</li>
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
    const korean = { minutesPerDay: n('minutesPerDay'), autoNewCards: v('autoNewCards').checked, newCardsPerDay: n('newCardsPerDay'),
      desiredRetention: n('desiredRetention'), unlockTypingAfterDays: n('unlockTypingAfterDays') };
    const activity = { stepGoalAuto: v('stepGoalAuto').checked, stepGoal: n('stepGoal'), restDayStepGoal: n('restDayStepGoal'),
      watchWorkoutCounts: v('watchWorkoutCounts').checked, watchWorkoutMinMinutes: n('watchWorkoutMinMinutes') };
    const moveBreaks = { ...s.moveBreaks, enabled: v('moveEnabled').checked, everyMinutes: n('moveEvery'), snoozeMinutes: n('moveSnooze'),
      treadmill: v('moveTreadmill').checked, walkMinutes: n('moveWalk') };
    const choices = [...new Set(v('sessionChoices').value.split(/[,\s]+/).filter(Boolean).map(Number)
      .filter(x => x === 0 || x >= 5))].sort((a, b) => (a || Infinity) - (b || Infinity));
    const gaming = {
      ...g, requireWorkout: v('requireWorkout').checked, countMinimumWorkout: v('countMinimumWorkout').checked,
      requireKoreanReviews: v('requireKoreanReviews').checked, requireKoreanNewCards: v('requireKoreanNewCards').checked,
      dailyCapWeekday: n('dailyCapWeekday'), dailyCapWeekend: n('dailyCapWeekend'), cooldownMinutes: n('cooldownMinutes'),
      setEveryMinutes: n('setEveryMinutes'), setsRequired: v('setsRequired').checked, setMenu: toStored(parseSetMenu(v('setMenu').value)),
      dinnerMinutes: n('dinnerMinutes'), dinnerFrom: n('dinnerFrom'), dinnerTo: Math.max(n('dinnerTo'), n('dinnerFrom') + 1),
      afkMinutes: n('afkMinutes'),
      sessionChoices: choices.length ? choices : g.sessionChoices, overrideMaxPerDay: n('overrideMaxPerDay'), overrideWaitSeconds: n('overrideWaitSeconds'),
    };
    const { patch, delayed } = gamingChange(s, gaming, ctx.today(), ctx.tomorrow());
    await ctx.saveSettings({ workout, korean, activity, moveBreaks, dayStartsAtHour: n('dayStartsAtHour'), ...patch });
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
  $('#watch', main).addEventListener('click', async e => {
    const k = e.target.closest('[data-copy]')?.dataset.copy;
    if (!k) return;
    try { await navigator.clipboard.writeText(copyValues[k]); toast('Copied.', 'ok'); } catch (_) { prompt('Copy this:', copyValues[k]); }
  });
  const so = $('#signout', main);
  if (so) so.onclick = () => ctx.auth.signOut();
}
