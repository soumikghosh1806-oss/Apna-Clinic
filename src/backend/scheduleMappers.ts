// Turns the database's schedule answers into the app's own shapes. Pure, so it is covered by unit tests.

import type { DateKey, OpdSession, ScheduleConflict, TimedSession } from '../domain/types';
import {
  emptyWeek,
  type DoctorSchedule,
  type ExceptionKind,
  type ScheduleException,
  type WeekdayNumber,
  type WeeklySchedule,
} from '../domain/schedule';

type Dto = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const day = (v: unknown): DateKey => str(v).slice(0, 10);
/** The database may answer "09:30:00". The screens use "09:30". */
const hm = (v: unknown): string => str(v).slice(0, 5);

export function mapTimedSessions(v: unknown): TimedSession[] {
  if (!Array.isArray(v)) return [];
  return v.map((raw) => {
    const s = raw as Dto;
    const out: TimedSession = { start: hm(s.start), end: hm(s.end) };
    if (typeof s.break_start === 'string' && s.break_start && typeof s.break_end === 'string' && s.break_end) {
      out.breakStart = hm(s.break_start);
      out.breakEnd = hm(s.break_end);
    }
    return out;
  });
}

/** What the screens hold, back into what the database takes. Empty break fields are left out. */
export function timedSessionsToDto(sessions: readonly TimedSession[]): Dto[] {
  return sessions.map((s) => ({
    start: s.start,
    end: s.end,
    ...(s.breakStart && s.breakEnd ? { break_start: s.breakStart, break_end: s.breakEnd } : {}),
  }));
}

export function weeklyToDto(weekly: WeeklySchedule): Dto {
  const out: Dto = {};
  for (const d of [0, 1, 2, 3, 4, 5, 6] as WeekdayNumber[]) out[String(d)] = timedSessionsToDto(weekly[d]);
  return out;
}

export function mapConflicts(v: unknown): ScheduleConflict[] {
  if (!Array.isArray(v)) return [];
  return v.map((raw) => {
    const c = raw as Dto;
    const out: ScheduleConflict = {
      doctorId: str(c.doctor_id),
      doctor: str(c.doctor),
      date: day(c.date),
      tokens: typeof c.tokens === 'number' ? c.tokens : 0,
      reason: c.reason === 'closed' ? 'closed' : 'session_changed',
    };
    if (c.closed_reason === 'leave' || c.closed_reason === 'holiday' || c.closed_reason === 'weekly_off') out.closedReason = c.closed_reason;
    if (c.session && typeof c.session === 'object') {
      const session: OpdSession = { start: hm((c.session as Dto).start), end: hm((c.session as Dto).end) };
      out.session = session;
    }
    return out;
  });
}

export function mapException(dto: Dto): ScheduleException {
  const kind: ExceptionKind = dto.kind === 'override' || dto.kind === 'special' ? dto.kind : 'closed';
  const out: ScheduleException = {
    id: str(dto.id),
    kind,
    startDate: day(dto.start_date),
    endDate: day(dto.end_date),
    sessions: mapTimedSessions(dto.sessions),
    clinicWide: dto.clinic_wide === true,
  };
  const reason = str(dto.reason);
  if (reason) out.reason = reason;
  return out;
}

export function mapSchedule(dto: Dto): DoctorSchedule {
  const weekly = emptyWeek();
  const raw = (dto.weekly ?? {}) as Dto;
  for (const d of [0, 1, 2, 3, 4, 5, 6] as WeekdayNumber[]) weekly[d] = mapTimedSessions(raw[String(d)]);
  const doctor = (dto.doctor ?? {}) as Dto;
  return {
    doctorId: str(doctor.id),
    doctorName: str(doctor.name),
    opd: str(doctor.opd),
    timezone: str(dto.timezone, 'Asia/Kolkata'),
    today: day(dto.today),
    weekly,
    exceptions: (Array.isArray(dto.exceptions) ? (dto.exceptions as Dto[]) : []).map(mapException),
  };
}
