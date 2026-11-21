// Summaries of watch data written by the relay (see relay/hc.js for the document format).

/**
 * Sum interval records without double counting. Health Connect can hold the same steps from the watch and
 * the phone; raw records are summed per source app and the largest source wins. Aggregate buckets
 * (already de-duplicated by Health Connect) are used when present, skipping overlaps.
 */
export function sumIntervals(map = {}) {
  const items = Object.entries(map).map(([k, v]) => ({ k, ...v }));
  const agg = items.filter(x => x.k.startsWith('a_')).sort((a, b) => a.s - b.s);
  if (agg.length) {
    let total = 0, end = -Infinity;
    for (const b of agg) if (b.s >= end) { total += b.c; end = b.e; }
    return total;
  }
  const bySource = new Map();
  for (const x of items) bySource.set(x.o, (bySource.get(x.o) || 0) + x.c);
  return bySource.size ? Math.max(...bySource.values()) : 0;
}

export function heartSeries(doc) {
  return Object.entries(doc?.hr || {})
    .map(([k, [avg, min, max]]) => ({ minute: +k.slice(1, 3) * 60 + +k.slice(3, 5), avg, min, max }))
    .sort((a, b) => a.minute - b.minute);
}

export function summarize(doc, exercises = []) {
  const hr = heartSeries(doc);
  return {
    steps: Math.round(sumIntervals(doc?.steps)),
    kcal: Math.round(sumIntervals(doc?.cal)),
    km: sumIntervals(doc?.dist) / 1000,
    restingHr: hr.length ? Math.min(...hr.map(x => x.min)) : null,
    activeMinutes: Math.round(exercises.reduce((n, x) => n + (x.dur || 0), 0) / 60),
    hr, updatedAt: doc?.updatedAt || null,
  };
}

/** Heart rate during a time window (e.g. a logged workout), from the day docs covering it. */
export function heartDuring(docsByDay, start, end) {
  const pts = [];
  for (let t = start - (start % 60000); t <= end; t += 60000) {
    const d = new Date(t);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const v = docsByDay[day]?.hr?.['m' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0')];
    if (v) pts.push({ t, avg: v[0], max: v[2] });
  }
  if (!pts.length) return null;
  return { avg: Math.round(pts.reduce((n, p) => n + p.avg, 0) / pts.length), max: Math.max(...pts.map(p => p.max)), points: pts };
}

const TYPE_NAMES = {
  strength_training: 'Strength training', weightlifting: 'Weightlifting', running: 'Run', walking: 'Walk',
  biking: 'Ride', cycling: 'Ride', hiking: 'Hike', swimming_pool: 'Swim', swimming_open_water: 'Swim',
  high_intensity_interval_training: 'HIIT', calisthenics: 'Calisthenics', yoga: 'Yoga', other_workout: 'Workout',
};
export function exerciseName(type) {
  const k = String(type || '').toLowerCase().replace(/^exercise_type_/, '');
  return TYPE_NAMES[k] || k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) || 'Workout';
}
