// Treadmill-desk walks. A wrist watch barely counts steps while your hands rest on the desk (no arm swing), so a
// walk is logged with its start and end, and inside that window the walk's steps replace the watch's
// (activity.js stepsWithWalks; the relay does the same for daily/{day}.steps). Mirrored in helper/walks.py.
//
//   meta/walk       {start: ms | null, src}       the walk in progress, if any
//   meta/walkStats  {cadence}                     your steps per minute, learned from treadmill readings
//   daily/{day}.walks.<start ms>  {s, e, steps, est, src}   day = calendar day the walk started
import { calendarDay } from './time.js';

export const DEFAULT_CADENCE = 85;    // steps/min at ~1.5 mph; replaced by yours once you type in treadmill readings
export const MAX_WALK_MIN = 240;

export async function openWalk(store) {
  const w = await store.get('meta', 'walk');
  return w?.start ? w : null;
}

export async function cadence(store) {
  return (await store.get('meta', 'walkStats'))?.cadence || DEFAULT_CADENCE;
}

export async function startWalk(store, now, src = 'phone') {
  await store.set('meta', 'walk', { start: now, src });
}

/** Ends the open walk at `end` and stores it. `steps` from the treadmill display, or null to estimate. */
export async function stopWalk(store, now, { end = now, steps = null } = {}) {
  const w = await openWalk(store);
  if (!w) return null;
  end = Math.min(end, w.start + MAX_WALK_MIN * 60e3);
  const minutes = Math.max(0, (end - w.start) / 60e3);
  let walk = null;
  if (minutes >= 1) {
    const est = steps == null || !(steps > 0);
    if (est) steps = Math.round(minutes * (await cadence(store)));
    else {
      const c = steps / minutes;   // learn your cadence (only from plausible walking readings)
      if (c >= 40 && c <= 140) await store.set('meta', 'walkStats', { cadence: Math.round(0.7 * (await cadence(store)) + 0.3 * c) });
    }
    const day = calendarDay(w.start);
    const walks = { ...((await store.get('daily', day))?.walks || {}) };
    walk = { s: w.start, e: end, steps: Math.round(steps), est, src: w.src || 'phone' };
    walks[String(w.start)] = walk;
    await store.update('daily', day, { day, walks });
  }
  // Cleared last, so the walk is always findable (the PC's set clock pauses while you walk).
  await store.set('meta', 'walk', { start: null, src: w.src });
  return walk && { ...walk, minutes };
}

/** The walks of a day, plus the one in progress (estimated up to now) so today's steps stay live. */
export function walksFor(daily, open, now, cad = DEFAULT_CADENCE) {
  const out = { ...(daily?.walks || {}) };
  if (open?.start && calendarDay(open.start) === calendarDay(now)) {
    out.open = { s: open.start, e: now, steps: Math.round(((now - open.start) / 60e3) * cad), est: true, open: true };
  }
  return out;
}
