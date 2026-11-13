// Doctor schedules: the rules for OPD timings, shared by the editor (instant feedback) and the tests.
// The database applies the same rules again, so nothing here is trusted on its own.
// Times are wall clock times (HH:MM, 24 hour) in the clinic's own time zone.

import { formatMinutes, parseHM } from './dates';
import type { DateKey, ScheduleConflict, TimedSession } from './types';

/** 0 is Sunday, as in the database. */
export type WeekdayNumber = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type WeeklySchedule = Record<WeekdayNumber, TimedSession[]>;

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
/** Weeks start on Monday in India. */
export const WEEK_ORDER: readonly WeekdayNumber[] = [1, 2, 3, 4, 5, 6, 0];
export const MAX_SESSIONS_PER_DAY = 6;
export const REASON_MAX = 120;

export type ExceptionKind = 'closed' | 'override' | 'special';

export interface ScheduleException {
  id: string;
  kind: ExceptionKind;
  startDate: DateKey;
  endDate: DateKey;
  sessions: TimedSession[];
  /** A private note for staff. Patients never see it. */
  reason?: string;
  /** True when it applies to every doctor of the clinic. */
  clinicWide: boolean;
}

export interface DoctorSchedule {
  doctorId: string;
  doctorName: string;
  opd: string;
  timezone: string;
  today: DateKey;
  weekly: WeeklySchedule;
  exceptions: ScheduleException[];
}

export function emptyWeek(): WeeklySchedule {
  return { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
}

/** The first thing wrong with one day's timings, in plain words, or null when they are fine. Mirrors the database. */
export function sessionsProblem(sessions: readonly TimedSession[], { min = 0, max = MAX_SESSIONS_PER_DAY } = {}): string | null {
  if (sessions.length < min) return 'Add at least one OPD timing.';
  if (sessions.length > max) return `Use at most ${max} timings in one day.`;
  for (const s of sessions) {
    const start = parseHM(s.start);
    const end = parseHM(s.end);
    if (Number.isNaN(start) || Number.isNaN(end)) return 'Enter every OPD time as hours and minutes.';
    if (end <= start) return 'Each OPD timing must end after it starts.';
    const hasStart = Boolean(s.breakStart);
    const hasEnd = Boolean(s.breakEnd);
    if (hasStart !== hasEnd) return 'Enter both the break start and the break end, or neither.';
    if (hasStart && hasEnd) {
      const bs = parseHM(s.breakStart!);
      const be = parseHM(s.breakEnd!);
      if (Number.isNaN(bs) || Number.isNaN(be)) return 'Enter break times as hours and minutes.';
      if (be <= bs) return 'A break must end after it starts.';
      if (bs <= start || be >= end) return 'A break must fall inside the OPD timing.';
    }
  }
  const sorted = [...sessions].sort((a, b) => parseHM(a.start) - parseHM(b.start));
  for (let i = 1; i < sorted.length; i += 1) {
    if (parseHM(sorted[i]!.start) < parseHM(sorted[i - 1]!.end)) return 'OPD timings must not overlap.';
  }
  return null;
}

/** Problems by weekday. An empty object means the week can be saved. */
export function weeklyProblems(weekly: WeeklySchedule): Partial<Record<WeekdayNumber, string>> {
  const out: Partial<Record<WeekdayNumber, string>> = {};
  for (const day of WEEK_ORDER) {
    const problem = sessionsProblem(weekly[day]);
    if (problem) out[day] = problem;
  }
  return out;
}

export function sortSessions(sessions: readonly TimedSession[]): TimedSession[] {
  return [...sessions].sort((a, b) => parseHM(a.start) - parseHM(b.start));
}

/** "9:30 am to 12:45 pm", with the break when there is one. */
export function describeSession(s: TimedSession): string {
  const base = `${formatMinutes(parseHM(s.start))} to ${formatMinutes(parseHM(s.end))}`;
  return s.breakStart && s.breakEnd ? `${base} (break ${formatMinutes(parseHM(s.breakStart))} to ${formatMinutes(parseHM(s.breakEnd))})` : base;
}

export function describeDay(sessions: readonly TimedSession[]): string {
  return sessions.length === 0 ? 'Closed' : sortSessions(sessions).map(describeSession).join(' and ');
}

/** Copies one day's timings onto other days. The source day is left alone. */
export function copyDay(weekly: WeeklySchedule, from: WeekdayNumber, to: readonly WeekdayNumber[]): WeeklySchedule {
  const next: WeeklySchedule = { ...weekly };
  for (const day of to) if (day !== from) next[day] = weekly[from].map((s) => ({ ...s }));
  return next;
}

export function sameSchedule(a: WeeklySchedule, b: WeeklySchedule): boolean {
  return WEEK_ORDER.every((d) => JSON.stringify(sortSessions(a[d])) === JSON.stringify(sortSessions(b[d])));
}

/** One line for the confirmation dialog: "Wed 11 Mar: 2 booked patients (10:00 am to 2:00 pm session)". */
export function describeConflict(c: ScheduleConflict, formatDay: (d: DateKey) => string): string {
  const who = `${c.tokens} booked ${c.tokens === 1 ? 'patient' : 'patients'}`;
  const where = c.session ? ` in the ${describeSession(c.session)} session` : '';
  const why = c.reason === 'closed' ? 'the day will be closed' : 'that session is no longer on the timetable';
  return `${c.doctor}, ${formatDay(c.date)}: ${who}${where}, because ${why}.`;
}

/** 630 to "10:30". */
export function toHM(minutes: number): string {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** A sensible timing to offer when "Add timing" is pressed: an hour after the last one ends, three hours long. */
export function nextSession(existing: readonly TimedSession[]): TimedSession {
  const ends = existing.map((s) => parseHM(s.end)).filter((n) => !Number.isNaN(n));
  if (ends.length === 0) return { start: '09:00', end: '13:00' };
  const start = Math.max(...ends) + 60;
  if (start > 21 * 60) return { start: '17:00', end: '20:00' }; // no room after the last one; the editor will point out an overlap
  return { start: toHM(start), end: toHM(Math.min(start + 180, 24 * 60 - 1)) };
}
