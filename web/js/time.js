// Dates as 'YYYY-MM-DD' keys in local time. A "logical day" starts at settings.dayStartsAtHour,
// so a 1am study session still counts toward the previous day.
export const HOUR = 3600e3, DAY = 86400e3;
export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function parseDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function dayKey(t = Date.now(), startHour = 4) {
  return ymd(new Date(t - startHour * HOUR));
}
/** Epoch ms when a logical day starts (DST-safe). */
export function dayStart(key, startHour = 4) {
  const d = parseDay(key);
  d.setHours(startHour, 0, 0, 0);
  return d.getTime();
}
export function addDays(key, n) {
  const d = parseDay(key);
  d.setDate(d.getDate() + n);
  return ymd(d);
}
export function weekdayKey(key) {
  return DAY_KEYS[(parseDay(key).getDay() + 6) % 7];
}
export function isWeekend(key) {
  const w = parseDay(key).getDay();
  return w === 0 || w === 6;
}
export function calendarDay(t = Date.now()) {
  return ymd(new Date(t));
}
export function fmtDuration(min) {
  if (min == null) return '—';
  const m = Math.round(min);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}
export function fmtClock(t) {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
export function fmtDateTime(t) {
  return new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
