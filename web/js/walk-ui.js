// Start/stop a treadmill-desk walk from the web app (the PC has a pop-up timer and Ctrl+Alt+W for the same thing).
import { startWalk, stopWalk } from './walks.js';
import { fmtClock } from './time.js';
import { toast } from './ui.js';

export function walkButton(open, now) {
  return open
    ? `<button class="primary" data-walk="stop">Stop treadmill walk (${Math.round((now - open.start) / 60e3)} min)</button>`
    : '<button data-walk="start">Start treadmill walk</button>';
}

/** "10:02–10:31 · 2,450 steps (treadmill)" lines for a day's walks. */
export function walkLines(walks = {}) {
  return Object.values(walks).filter(w => !w.open).sort((a, b) => a.s - b.s)
    .map(w => `${fmtClock(w.s)}–${fmtClock(w.e)} · ${w.steps.toLocaleString()} steps ${w.est ? '(estimated)' : '(treadmill)'}`);
}

export function bindWalk(el, ctx, onChange) {
  el?.addEventListener('click', async e => {
    const b = e.target.closest('[data-walk]');
    if (!b) return;
    if (b.dataset.walk === 'start') {
      await startWalk(ctx.store, ctx.now(), 'phone');
      toast('Walk started. Stop it here, or on the PC with Ctrl+Alt+W.', 'ok');
    } else {
      const raw = prompt('Steps shown on the treadmill? Leave empty to estimate from the time.', '');
      if (raw === null) return;
      const n = parseInt(String(raw).replace(/[^0-9]/g, ''), 10);
      const r = await stopWalk(ctx.store, ctx.now(), { steps: n > 0 ? n : null });
      toast(r ? `Walk logged: ${Math.round(r.minutes)} min, ${r.steps.toLocaleString()} steps${r.est ? ' (estimated)' : ''}.`
        : 'Under a minute, so it wasn\'t logged.', 'ok');
    }
    onChange();
  });
}
