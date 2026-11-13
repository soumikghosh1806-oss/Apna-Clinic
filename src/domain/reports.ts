// Report numbers. Everything is counted from the token records, nothing is typed in by hand.

import { addDays } from './dates';
import type { AppState, DateKey, Token } from './types';

export type DoctorFilter = string | 'all';

export interface DayStats {
  date: DateKey;
  /** Tokens issued that day, not counting cancelled ones. */
  total: number;
  completed: number;
  noShow: number;
  cancelled: number;
  /** Whole minutes from arrival to being called. Null when no token has both times. */
  averageWaitMinutes: number | null;
  /** How many tokens the average was calculated from. */
  waitSamples: number;
}

function tokensOnDay(state: AppState, date: DateKey, doctor: DoctorFilter): Token[] {
  return state.tokens.filter((t) => t.date === date && (doctor === 'all' || t.doctorId === doctor));
}

/** Minutes between arrival and the doctor calling the patient. Calls made without a recorded arrival are left out. */
export function waitMinutes(token: Token): number | null {
  if (!token.arrivedAt || !token.startedAt || token.arrivalSource === 'doctor_call') return null;
  const minutes = (new Date(token.startedAt).getTime() - new Date(token.arrivedAt).getTime()) / 60000;
  return Math.max(0, minutes);
}

export function dayStats(state: AppState, date: DateKey, doctor: DoctorFilter): DayStats {
  const tokens = tokensOnDay(state, date, doctor);
  const issued = tokens.filter((t) => t.status !== 'cancelled');
  const waits = issued.map(waitMinutes).filter((m): m is number => m !== null);
  const average = waits.length === 0 ? null : Math.round(waits.reduce((a, b) => a + b, 0) / waits.length);
  return {
    date,
    total: issued.length,
    completed: issued.filter((t) => t.status === 'completed').length,
    noShow: issued.filter((t) => t.status === 'no_show').length,
    cancelled: tokens.length - issued.length,
    averageWaitMinutes: average,
    waitSamples: waits.length,
  };
}

/** The seven days ending on `endDate`, oldest first. */
export function lastSevenDays(endDate: DateKey): DateKey[] {
  return Array.from({ length: 7 }, (_, i) => addDays(endDate, i - 6));
}

export function weekSeries(state: AppState, endDate: DateKey, doctor: DoctorFilter): DayStats[] {
  return lastSevenDays(endDate).map((d) => dayStats(state, d, doctor));
}

function csvCell(value: string | number): string {
  const text = String(value);
  // A leading = + - or @ can be run as a formula by spreadsheet programs, so it is neutralised.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface CsvDayRow {
  date: string;
  opd: string;
  total: number;
  completed: number;
  noShow: number;
  cancelled: number;
  averageWaitMinutes: number | null;
}

export const CSV_HEADER = ['date', 'opd', 'tokens_issued', 'completed', 'no_show', 'cancelled', 'average_wait_minutes'];

/** The same file as monthlyCsv, built from rows a server already counted. */
export function rowsToCsv(rows: CsvDayRow[]): string {
  return [
    CSV_HEADER.join(','),
    ...rows.map((r) =>
      [r.date, r.opd, r.total, r.completed, r.noShow, r.cancelled, r.averageWaitMinutes ?? ''].map(csvCell).join(','),
    ),
  ].join('\n');
}

/** One row per OPD per day for a month (YYYY-MM). Covers only the days present in the demo data. */
export function monthlyCsv(state: AppState, month: string): string {
  const header = ['date', 'opd', 'tokens_issued', 'completed', 'no_show', 'cancelled', 'average_wait_minutes'];
  const dates = [...new Set(state.tokens.map((t) => t.date).filter((d) => d.startsWith(month)))].sort();
  const rows: string[] = [header.join(',')];
  for (const date of dates) {
    for (const doctor of state.doctors) {
      const stats = dayStats(state, date, doctor.id);
      if (stats.total === 0 && stats.cancelled === 0) continue;
      rows.push(
        [
          date,
          doctor.opd,
          stats.total,
          stats.completed,
          stats.noShow,
          stats.cancelled,
          stats.averageWaitMinutes ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }
  return rows.join('\n');
}
