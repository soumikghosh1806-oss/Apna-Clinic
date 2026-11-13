import type { DateKey } from './types';

const pad = (n: number) => String(n).padStart(2, '0');

export function toDateKey(d: Date): DateKey {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight of a date key. */
export function fromDateKey(key: DateKey): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key: DateKey, days: number): DateKey {
  const d = fromDateKey(key);
  d.setDate(d.getDate() + days);
  return toDateKey(d);
}

export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** "10:30" to 630. Returns NaN for anything that is not HH:MM. */
export function parseHM(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return NaN;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return NaN;
  return h * 60 + m;
}

const timeFormat = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
const timeSecondsFormat = new Intl.DateTimeFormat('en-IN', {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});
const dateFormat = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const shortDateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });
const weekdayFormat = new Intl.DateTimeFormat('en-IN', { weekday: 'short' });

export function formatTime(d: Date): string {
  return timeFormat.format(d);
}

export function formatTimeWithSeconds(d: Date): string {
  return timeSecondsFormat.format(d);
}

/** Minutes after midnight to "10:00 am". */
export function formatMinutes(min: number): string {
  const d = new Date(2000, 0, 1, Math.floor(min / 60), min % 60);
  return timeFormat.format(d);
}

export function formatDate(key: DateKey): string {
  return dateFormat.format(fromDateKey(key));
}

export function formatShortDate(key: DateKey): string {
  return shortDateFormat.format(fromDateKey(key));
}

export function formatWeekday(key: DateKey): string {
  return weekdayFormat.format(fromDateKey(key));
}

/** Words for today and tomorrow, plain date otherwise. */
export function relativeDayLabel(key: DateKey, today: DateKey): string {
  if (key === today) return 'Today';
  if (key === addDays(today, 1)) return 'Tomorrow';
  return formatDate(key);
}
