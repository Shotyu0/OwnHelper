// Dinner break: once a day, started between dinnerFrom and dinnerTo (local hours), it lasts dinnerMinutes or until
// "done eating". Play during it doesn't count toward the next gaming set, and a set that comes due while you eat
// waits until it ends (postponed, never skipped). Stored in daily/{day}.dinner {start, end, src}.
// Mirrors helper/gaming/rules.py Rules.dinner / start_dinner / end_dinner; the PC guardian applies it to the set clock.

export const hourLabel = h => { const x = Math.floor(h) % 24; return `${x % 12 || 12} ${x < 12 ? 'AM' : 'PM'}`; };

export function dinnerState(g, daily, now = Date.now()) {
  const minutes = g.dinnerMinutes || 0, from = g.dinnerFrom ?? 18, to = g.dinnerTo ?? 21;
  const d = daily?.dinner || {};
  const t = new Date(now), hour = t.getHours() + t.getMinutes() / 60;
  return {
    minutes, from, to, start: d.start || null, end: d.end || null, src: d.src || null,
    active: !!(d.start && d.end && d.start <= now && now < d.end),
    canStart: minutes > 0 && !d.start && hour >= from && hour < to,
  };
}

export async function startDinner(store, day, state, now, src = 'phone') {
  const dinner = { start: now, end: now + state.minutes * 60e3, src };
  await store.update('daily', day, { day, dinner });
  return dinner;
}

export async function endDinner(store, day, state, now) {
  if (state.active) await store.update('daily', day, { dinner: { start: state.start, end: now, src: state.src || 'phone' } });
}
