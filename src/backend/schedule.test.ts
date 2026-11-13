import { describe, expect, it } from 'vitest';
import {
  copyDay,
  describeConflict,
  describeDay,
  describeSession,
  emptyWeek,
  nextSession,
  sameSchedule,
  sessionsProblem,
  toHM,
  weeklyProblems,
  type WeeklySchedule,
} from '../domain/schedule';
import { mapAvailability, mapQueueStatus } from './mappers';
import { mapConflicts, mapSchedule, mapTimedSessions, timedSessionsToDto, weeklyToDto } from './scheduleMappers';
import { readAnswer, toFailure } from './rpc';

// The example week from the brief.
const EXAMPLE: WeeklySchedule = {
  1: [{ start: '09:30', end: '12:45' }, { start: '17:30', end: '20:15' }],
  2: [{ start: '10:15', end: '13:30' }],
  3: [],
  4: [{ start: '16:00', end: '21:00' }],
  5: [{ start: '09:00', end: '12:00' }, { start: '18:00', end: '20:30' }],
  6: [{ start: '10:00', end: '14:00' }],
  0: [],
};

describe('OPD timing rules', () => {
  it('accepts the example week, a closed day and a break inside a timing', () => {
    expect(weeklyProblems(EXAMPLE)).toEqual({});
    expect(sessionsProblem([{ start: '10:00', end: '14:00', breakStart: '12:00', breakEnd: '12:30' }])).toBeNull();
    expect(sessionsProblem([])).toBeNull();
  });

  it('accepts timings that touch but do not overlap, entered in any order', () => {
    expect(sessionsProblem([{ start: '10:00', end: '11:00' }, { start: '09:00', end: '10:00' }])).toBeNull();
  });

  it('rejects an end that is not after the start', () => {
    expect(sessionsProblem([{ start: '12:00', end: '11:00' }])).toMatch(/end after/);
    expect(sessionsProblem([{ start: '12:00', end: '12:00' }])).toMatch(/end after/);
  });

  it('rejects overlapping timings, even when entered out of order', () => {
    expect(sessionsProblem([{ start: '10:00', end: '12:00' }, { start: '11:30', end: '13:00' }])).toMatch(/overlap/);
    expect(sessionsProblem([{ start: '16:00', end: '18:00' }, { start: '09:00', end: '12:00' }, { start: '11:00', end: '17:00' }])).toMatch(/overlap/);
  });

  it('rejects empty, malformed and impossible times', () => {
    expect(sessionsProblem([{ start: '', end: '12:00' }])).toMatch(/hours and minutes/);
    expect(sessionsProblem([{ start: '9am', end: '12:00' }])).toMatch(/hours and minutes/);
    expect(sessionsProblem([{ start: '25:00', end: '26:00' }])).toMatch(/hours and minutes/);
  });

  it('checks breaks: both ends, in order, and inside the timing', () => {
    const base = { start: '10:00', end: '14:00' };
    expect(sessionsProblem([{ ...base, breakStart: '12:00', breakEnd: '' }])).toMatch(/both the break/);
    expect(sessionsProblem([{ ...base, breakStart: '12:30', breakEnd: '12:00' }])).toMatch(/break must end after/);
    expect(sessionsProblem([{ ...base, breakStart: '09:00', breakEnd: '10:30' }])).toMatch(/inside/);
    expect(sessionsProblem([{ ...base, breakStart: '13:00', breakEnd: '15:00' }])).toMatch(/inside/);
    expect(sessionsProblem([{ ...base, breakStart: '10:00', breakEnd: '10:30' }])).toMatch(/inside/);
  });

  it('allows at most six timings a day, and a minimum when asked', () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ start: toHM(i * 180), end: toHM(i * 180 + 60) }));
    expect(sessionsProblem(seven)).toMatch(/at most 6/);
    expect(sessionsProblem([], { min: 1 })).toMatch(/at least one/);
  });

  it('reports problems by weekday', () => {
    const week = { ...EXAMPLE, 2: [{ start: '14:00', end: '13:00' }] };
    expect(Object.keys(weeklyProblems(week))).toEqual(['2']);
  });
});

describe('editing helpers', () => {
  it('copies one day onto others without touching the source or other days', () => {
    const next = copyDay(EXAMPLE, 2, [3, 0]);
    expect(next[3]).toEqual(EXAMPLE[2]);
    expect(next[0]).toEqual(EXAMPLE[2]);
    expect(next[1]).toEqual(EXAMPLE[1]);
    // A copy, not a shared list.
    next[3]![0]!.start = '08:00';
    expect(next[2]![0]!.start).toBe('10:15');
  });

  it('knows when a week has not changed, whatever the order of timings', () => {
    const shuffled: WeeklySchedule = { ...EXAMPLE, 1: [...EXAMPLE[1]].reverse() };
    expect(sameSchedule(EXAMPLE, shuffled)).toBe(true);
    expect(sameSchedule(EXAMPLE, { ...EXAMPLE, 4: [{ start: '16:00', end: '20:00' }] })).toBe(false);
  });

  it('offers a sensible next timing', () => {
    expect(nextSession([])).toEqual({ start: '09:00', end: '13:00' });
    expect(nextSession([{ start: '09:00', end: '12:00' }])).toEqual({ start: '13:00', end: '16:00' });
    expect(nextSession([{ start: '09:00', end: '23:00' }])).toEqual({ start: '17:00', end: '20:00' });
  });

  it('writes times for people', () => {
    expect(describeDay([])).toBe('Closed');
    expect(describeSession({ start: '09:30', end: '12:45' })).toMatch(/9:30.*12:45/);
    expect(describeSession({ start: '10:00', end: '14:00', breakStart: '12:00', breakEnd: '12:30' })).toMatch(/break/);
    expect(toHM(630)).toBe('10:30');
    expect(toHM(-5)).toBe('00:00');
    expect(toHM(99999)).toBe('23:59');
  });

  it('explains a conflict in one line, naming the doctor, day and number of patients', () => {
    const line = describeConflict(
      { doctorId: 'd', doctor: 'Dr Sen', date: '2026-03-11', tokens: 2, reason: 'closed', session: { start: '10:00', end: '14:00' } },
      (d) => d,
    );
    expect(line).toContain('Dr Sen');
    expect(line).toContain('2026-03-11');
    expect(line).toContain('2 booked patients');
    expect(line).toContain('the day will be closed');
    expect(describeConflict({ doctorId: 'd', doctor: 'Dr Sen', date: '2026-03-11', tokens: 1, reason: 'session_changed' }, (d) => d)).toContain('1 booked patient,');
  });
});

describe('schedule answers from the database', () => {
  it('reads a stored week, including breaks and closed days, and writes it back unchanged', () => {
    const dto = {
      ok: true,
      doctor: { id: 'd1', name: 'Dr Sen', opd: 'General OPD' },
      timezone: 'Asia/Kolkata',
      today: '2026-03-10',
      weekly: {
        '0': [],
        '1': [{ start: '09:30', end: '12:45', break_start: '11:00', break_end: '11:15' }],
        '2': [{ start: '10:15:00', end: '13:30:00' }],
        '3': [], '4': [], '5': [], '6': [],
      },
      exceptions: [
        { id: 'e1', kind: 'closed', start_date: '2026-03-11', end_date: '2026-03-14', sessions: [], reason: 'Conference', clinic_wide: false },
        { id: 'e2', kind: 'special', start_date: '2026-03-12', end_date: '2026-03-12', sessions: [{ start: '18:00', end: '19:30' }], clinic_wide: true },
      ],
    };
    const schedule = mapSchedule(dto);
    expect(schedule.weekly[1]).toEqual([{ start: '09:30', end: '12:45', breakStart: '11:00', breakEnd: '11:15' }]);
    expect(schedule.weekly[2]).toEqual([{ start: '10:15', end: '13:30' }]);
    expect(schedule.weekly[0]).toEqual([]);
    expect(schedule.exceptions[0]).toMatchObject({ kind: 'closed', startDate: '2026-03-11', endDate: '2026-03-14', reason: 'Conference', clinicWide: false });
    expect(schedule.exceptions[1]).toMatchObject({ kind: 'special', clinicWide: true });
    expect(schedule.exceptions[1]!.reason).toBeUndefined();

    const back = weeklyToDto(schedule.weekly);
    expect(back['1']).toEqual([{ start: '09:30', end: '12:45', break_start: '11:00', break_end: '11:15' }]);
    expect(back['0']).toEqual([]);
    expect(Object.keys(back)).toHaveLength(7);
  });

  it('leaves empty break fields out when sending', () => {
    expect(timedSessionsToDto([{ start: '09:00', end: '10:00', breakStart: '', breakEnd: '' }])).toEqual([{ start: '09:00', end: '10:00' }]);
    expect(timedSessionsToDto([{ start: '09:00', end: '10:00', breakStart: '09:30', breakEnd: '09:40' }])).toEqual([
      { start: '09:00', end: '10:00', break_start: '09:30', break_end: '09:40' },
    ]);
  });

  it('survives missing or odd data', () => {
    expect(mapTimedSessions(undefined)).toEqual([]);
    expect(mapTimedSessions('x')).toEqual([]);
    expect(mapSchedule({}).weekly).toEqual(emptyWeek());
    expect(mapConflicts(undefined)).toEqual([]);
  });

  it('turns a schedule_conflict answer into a failure that carries the affected patients', () => {
    const failure = toFailure({
      ok: false,
      code: 'schedule_conflict',
      message: 'This change affects 2 booked patients.',
      conflicts: [
        { doctor_id: 'd1', doctor: 'Dr Sen', date: '2026-03-10', tokens: 2, reason: 'session_changed', session: { start: '10:00', end: '14:00' } },
        { doctor_id: 'd1', doctor: 'Dr Sen', date: '2026-03-11', tokens: 1, reason: 'closed', closed_reason: 'leave' },
      ],
    });
    expect(failure.code).toBe('schedule_conflict');
    expect(failure.conflicts).toEqual([
      { doctorId: 'd1', doctor: 'Dr Sen', date: '2026-03-10', tokens: 2, reason: 'session_changed', session: { start: '10:00', end: '14:00' } },
      { doctorId: 'd1', doctor: 'Dr Sen', date: '2026-03-11', tokens: 1, reason: 'closed', closedReason: 'leave' },
    ]);
    expect(readAnswer({ data: { ok: false, code: 'schedule_conflict', message: 'm', conflicts: [] }, error: null })).toMatchObject({ ok: false, code: 'schedule_conflict' });
  });
});

describe('booking answers with sessions', () => {
  it('reads closed and ended days, the reason, and the sessions that can still be booked', () => {
    expect(mapAvailability({ open: false, reason: 'closed', closed_reason: 'holiday', issued: 0, limit: 100, sessions: [] })).toEqual({
      open: false, reason: 'closed', closedReason: 'holiday', issued: 0, limit: 100, sessions: [],
    });
    const today = mapAvailability({
      open: true, issued: 3, limit: 100,
      sessions: [{ start: '10:15:00', end: '13:30:00', open: false, issued: 2 }, { start: '16:00', end: '19:00', open: true, issued: 1 }],
    });
    expect(today.sessions).toEqual([
      { start: '10:15', end: '13:30', open: false, issued: 2 },
      { start: '16:00', end: '19:00', open: true, issued: 1 },
    ]);
    expect(mapAvailability({ open: false, reason: 'ended', issued: 0, limit: 5 }).reason).toBe('ended');
    // An unknown reason is ignored rather than shown.
    expect(mapAvailability({ open: false, reason: 'something_new', issued: 0, limit: 5 }).reason).toBeUndefined();
    // The demo has no sessions: the field stays absent.
    expect(mapAvailability({ open: true, issued: 0, limit: 5 }).sessions).toBeUndefined();
  });

  it('knows the closed queue status', () => {
    expect(mapQueueStatus({ code: 'closed', label: 'The clinic is closed on Wednesday, 11 Mar.' })).toEqual({
      code: 'closed', label: 'The clinic is closed on Wednesday, 11 Mar.',
    });
  });
});
