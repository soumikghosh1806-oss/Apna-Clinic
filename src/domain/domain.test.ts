import { describe, expect, it } from 'vitest';
import { addDays, toDateKey } from './dates';
import { can } from './permissions';
import {
  CALL_COOLDOWN_SECONDS,
  bookingAvailability,
  callNext,
  cancelToken,
  completeToken,
  createToken,
  currentToken,
  estimateClockTime,
  getToken,
  holdToken,
  issuedCount,
  markArrived,
  markNoShow,
  ordinal,
  queueStatus,
  queueView,
  requeueToken,
  resumeToken,
  saveVisit,
  searchPatients,
  skipToken,
  tokensFor,
  upcomingTokens,
  visitNumber,
  visitsFor,
} from './queue';
import { receptionRows, type StatusFilter } from './reception';
import { dayStats, monthlyCsv, weekSeries } from './reports';
import { CHILD_DOCTOR_ID, GENERAL_DOCTOR_ID, createSeed } from './seed';
import { addDoctor, removeDoctor, updateDoctor, updateSettings } from './settings';
import type { AppState, Outcome } from './types';
import { normalizePhone, validateName, validatePhone, validateSessions } from './validation';

const NOW = new Date(2026, 9, 30, 16, 55, 0);
const TODAY = toDateKey(NOW);
const TOMORROW = addDays(TODAY, 1);
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

function seed(): AppState {
  return createSeed(NOW);
}

/** Unwraps a successful outcome so a test fails loudly when a rule rejects something it should accept. */
function ok<T>(outcome: Outcome<T>): { state: AppState; value: T } {
  if (!outcome.result.ok) throw new Error(`Expected success, got ${outcome.result.code}: ${outcome.result.message}`);
  return { state: outcome.state, value: outcome.result.value };
}

function code(outcome: Outcome<unknown>): string {
  return outcome.result.ok ? 'ok' : outcome.result.code;
}

const number = (state: AppState, id: string) => getToken(state, id)!.number;

describe('demo data', () => {
  const state = seed();

  it('has unique token numbers per doctor and day', () => {
    const seen = new Set<string>();
    for (const t of state.tokens) {
      const key = `${t.doctorId}|${t.date}|${t.number}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('has at most one patient with each doctor at a time', () => {
    for (const doctor of state.doctors) {
      expect(state.tokens.filter((t) => t.doctorId === doctor.id && t.date === TODAY && t.status === 'in_progress').length).toBeLessThanOrEqual(1);
    }
  });

  it('only refers to patients and doctors that exist', () => {
    for (const t of state.tokens) {
      expect(state.patients.some((p) => p.id === t.patientId)).toBe(true);
      expect(state.doctors.some((d) => d.id === t.doctorId)).toBe(true);
    }
    for (const v of state.visits) expect(state.patients.some((p) => p.id === v.patientId)).toBe(true);
  });

  it('gives every completed token a visit record', () => {
    for (const t of state.tokens.filter((x) => x.status === 'completed')) {
      expect(state.visits.some((v) => v.tokenId === t.id)).toBe(true);
    }
  });

  it('is identical for the same date', () => {
    expect(JSON.stringify(seed())).toBe(JSON.stringify(seed()));
  });

  it('has a parent and child sharing one phone number', () => {
    const matches = searchPatients(state, '9000000001');
    expect(matches.map((m) => m.patient.name).sort()).toEqual(['Aarav Kapoor', 'Meera Kapoor']);
  });

  it('contains no seeded data in the future', () => {
    for (const t of state.tokens.filter((x) => x.date <= TODAY)) {
      if (t.startedAt) expect(new Date(t.startedAt).getTime()).toBeLessThanOrEqual(NOW.getTime());
    }
  });
});

describe('validation', () => {
  it('accepts common ways of writing an Indian mobile number', () => {
    expect(normalizePhone('98765 43210')).toBe('9876543210');
    expect(normalizePhone('+91 98765-43210')).toBe('9876543210');
    expect(normalizePhone('09876543210')).toBe('9876543210');
  });

  it('rejects bad numbers with a message', () => {
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('5876543210')).toBeNull();
    expect(validatePhone('')).toMatch(/Enter a mobile number/);
    expect(validatePhone('abc')).toMatch(/valid 10 digit/);
  });

  it('checks names', () => {
    expect(validateName('A')).not.toBeNull();
    expect(validateName('R2D2')).not.toBeNull();
    expect(validateName("Asha D'Souza-Rao")).toBeNull();
    expect(validateName('  Sunita   Devi ')).toBeNull();
  });

  it('checks OPD sessions', () => {
    expect(validateSessions([{ start: '10:00', end: '14:00' }])).toBeNull();
    expect(validateSessions([{ start: '14:00', end: '10:00' }])).toMatch(/end after/);
    expect(
      validateSessions([
        { start: '10:00', end: '14:00' },
        { start: '13:00', end: '15:00' },
      ]),
    ).toMatch(/overlap/);
    expect(validateSessions([])).toMatch(/at least one/);
  });
});

describe('booking tokens', () => {
  it('gives the next number for that doctor and day', () => {
    const { state, value } = ok(
      createToken(seed(), { name: 'Test Patient', phone: '9111111111', doctorId: GENERAL_DOCTOR_ID, date: TODAY, source: 'online' }, NOW),
    );
    expect(value.number).toBe(18);
    expect(value.status).toBe('waiting');
    expect(value.source).toBe('online');
    expect(issuedCount(state, GENERAL_DOCTOR_ID, TODAY)).toBe(18);
  });

  it('numbers each day separately', () => {
    const { value } = ok(
      createToken(seed(), { name: 'Test Patient', phone: '9111111111', doctorId: GENERAL_DOCTOR_ID, date: TOMORROW, source: 'online' }, NOW),
    );
    expect(value.number).toBe(4);
  });

  it('never repeats a number, even when tokens are cancelled', () => {
    let state = seed();
    const first = ok(createToken(state, { name: 'Test One', phone: '9111111111', doctorId: GENERAL_DOCTOR_ID, date: TODAY, source: 'online' }, NOW));
    state = ok(cancelToken(first.state, first.value.id)).state;
    const second = ok(createToken(state, { name: 'Test Two', phone: '9222222222', doctorId: GENERAL_DOCTOR_ID, date: TODAY, source: 'online' }, NOW));
    expect(second.value.number).toBe(first.value.number + 1);
  });

  it('puts online and walk-in tokens in the same queue', () => {
    let state = seed();
    state = ok(createToken(state, { name: 'Online Person', phone: '9111111111', doctorId: GENERAL_DOCTOR_ID, date: TODAY, source: 'online' }, NOW)).state;
    const walkIn = ok(createToken(state, { name: 'Walk In Person', phone: '9222222222', doctorId: GENERAL_DOCTOR_ID, date: TODAY, source: 'walk_in' }, NOW));
    expect(walkIn.value.number).toBe(19);
    expect(walkIn.value.arrivedAt).toBeDefined();
    const waiting = tokensFor(walkIn.state, GENERAL_DOCTOR_ID, TODAY).filter((t) => t.status === 'waiting').map((t) => t.number);
    expect(waiting.slice(-2)).toEqual([18, 19]);
  });

  it('reuses a patient record for the same name and number', () => {
    const state = seed();
    const before = state.patients.length;
    const { state: next } = ok(
      createToken(state, { name: 'rahul sen', phone: '9000000003', doctorId: CHILD_DOCTOR_ID, date: TOMORROW, source: 'online' }, NOW),
    );
    expect(next.patients.length).toBe(before);
  });

  it('refuses a second active token for the same patient, doctor and day', () => {
    const first = ok(createToken(seed(), { name: 'Test Patient', phone: '9111111111', doctorId: GENERAL_DOCTOR_ID, date: TODAY, source: 'online' }, NOW));
    const again = createToken(first.state, { name: 'Test  Patient', phone: '+91 9111111111', doctorId: GENERAL_DOCTOR_ID, date: TODAY, source: 'online' }, NOW);
    expect(code(again)).toBe('duplicate');
    expect(!again.result.ok && again.result.existingTokenId).toBe(first.value.id);
    expect(again.state).toBe(first.state);
  });

  it('allows family members with different names on one phone', () => {
    const state = seed();
    expect(code(createToken(state, { name: 'Kapoor Cousin', phone: '9000000001', doctorId: GENERAL_DOCTOR_ID, date: TODAY, source: 'online' }, NOW))).toBe('ok');
  });

  it('returns field errors for bad input and changes nothing', () => {
    const state = seed();
    const out = createToken(state, { name: '', phone: '123', doctorId: GENERAL_DOCTOR_ID, date: TODAY, source: 'online' }, NOW);
    expect(code(out)).toBe('invalid_input');
    expect(!out.result.ok && Object.keys(out.result.fieldErrors ?? {}).sort()).toEqual(['name', 'phone']);
    expect(out.state).toBe(state);
  });

  it('only books today or tomorrow online', () => {
    const out = createToken(seed(), { name: 'Test Patient', phone: '9111111111', doctorId: GENERAL_DOCTOR_ID, date: addDays(TODAY, 2), source: 'online' }, NOW);
    expect(code(out)).toBe('invalid_date');
    const past = createToken(seed(), { name: 'Test Patient', phone: '9111111111', doctorId: GENERAL_DOCTOR_ID, date: addDays(TODAY, -1), source: 'online' }, NOW);
    expect(code(past)).toBe('invalid_date');
  });

  it('closes booking when the daily limit is reached, per doctor and day', () => {
    let state = seed();
    const issued = issuedCount(state, GENERAL_DOCTOR_ID, TODAY);
    state = ok(updateDoctor(state, GENERAL_DOCTOR_ID, { name: 'Dr. Asha Verma', opd: 'General OPD', sessions: state.doctors[0].sessions, dailyLimit: issued, minutesPerPatient: null })).state;
    expect(bookingAvailability(state, GENERAL_DOCTOR_ID, TODAY)).toMatchObject({ open: false, reason: 'full' });
    expect(bookingAvailability(state, GENERAL_DOCTOR_ID, TOMORROW).open).toBe(true);
    expect(bookingAvailability(state, CHILD_DOCTOR_ID, TODAY).open).toBe(true);
    const out = createToken(state, { name: 'Test Patient', phone: '9111111111', doctorId: GENERAL_DOCTOR_ID, date: TODAY, source: 'online' }, NOW);
    expect(code(out)).toBe('full');
  });

  it('lets reception go over the limit only when asked to', () => {
    let state = seed();
    const issued = issuedCount(state, GENERAL_DOCTOR_ID, TODAY);
    state = ok(updateDoctor(state, GENERAL_DOCTOR_ID, { name: 'Dr. Asha Verma', opd: 'General OPD', sessions: state.doctors[0].sessions, dailyLimit: issued, minutesPerPatient: null })).state;
    const input = { name: 'Walk In Person', phone: '9222222222', doctorId: GENERAL_DOCTOR_ID, date: TODAY, source: 'walk_in' as const };
    expect(code(createToken(state, input, NOW))).toBe('full');
    expect(code(createToken(state, { ...input, allowOverLimit: true }, NOW))).toBe('ok');
  });

  it('stops online booking when switched off but still allows walk-ins', () => {
    let state = seed();
    state = ok(updateSettings(state, { ...state.settings, onlineBookingEnabled: false })).state;
    expect(bookingAvailability(state, GENERAL_DOCTOR_ID, TODAY)).toMatchObject({ open: false, reason: 'online_disabled' });
    expect(code(createToken(state, { name: 'Test Patient', phone: '9111111111', doctorId: GENERAL_DOCTOR_ID, date: TODAY, source: 'online' }, NOW))).toBe('online_disabled');
    expect(code(createToken(state, { name: 'Test Patient', phone: '9111111111', doctorId: GENERAL_DOCTOR_ID, date: TODAY, source: 'walk_in' }, NOW))).toBe('ok');
  });

  it('only issues walk-in tokens for today', () => {
    const out = createToken(seed(), { name: 'Test Patient', phone: '9111111111', doctorId: GENERAL_DOCTOR_ID, date: TOMORROW, source: 'walk_in' }, NOW);
    expect(code(out)).toBe('invalid_date');
  });

  it('refuses a removed doctor', () => {
    let state = seed();
    state = ok(updateSettings(state, state.settings)).state;
    const added = ok(addDoctor(state, { name: 'Dr. Temp Person', opd: 'Temp OPD', sessions: [{ start: '10:00', end: '12:00' }], dailyLimit: null, minutesPerPatient: null }));
    const removed = ok(removeDoctor(added.state, added.value.id, NOW));
    expect(code(createToken(removed.state, { name: 'Test Patient', phone: '9111111111', doctorId: added.value.id, date: TODAY, source: 'online' }, NOW))).toBe('doctor_unavailable');
  });
});

describe('queue movement', () => {
  const state = seed();
  const current = currentToken(state, GENERAL_DOCTOR_ID, TODAY)!;

  it('starts with token 10 with the doctor and token 12 next in line', () => {
    expect(current.number).toBe(10);
    expect(upcomingTokens(state, GENERAL_DOCTOR_ID, TODAY, 3).map((t) => t.number)).toEqual([12, 14, 15]);
  });

  it('NEXT completes the current patient, records a visit and calls the next waiting token', () => {
    const { state: next, value } = ok(callNext(state, GENERAL_DOCTOR_ID, current.id, later(60)));
    expect(value.completed?.number).toBe(10);
    expect(value.called?.number).toBe(12);
    expect(currentToken(next, GENERAL_DOCTOR_ID, TODAY)?.number).toBe(12);
    expect(getToken(next, current.id)?.status).toBe('completed');
    expect(next.visits.some((v) => v.tokenId === current.id)).toBe(true);
    expect(getToken(next, value.called!.id)?.startedAt).toBeDefined();
  });

  it('ignores a NEXT press made from an out of date screen', () => {
    const first = ok(callNext(state, GENERAL_DOCTOR_ID, current.id, later(60)));
    const stale = callNext(first.state, GENERAL_DOCTOR_ID, current.id, later(120));
    expect(code(stale)).toBe('stale');
    expect(stale.state).toBe(first.state);
  });

  it('does not let a quick second press advance the patient who was just called', () => {
    const first = ok(callNext(state, GENERAL_DOCTOR_ID, current.id, later(60)));
    const calledId = first.value.called!.id;
    const quick = callNext(first.state, GENERAL_DOCTOR_ID, calledId, later(60 + CALL_COOLDOWN_SECONDS - 1));
    expect(code(quick)).toBe('too_soon');
    expect(getToken(quick.state, calledId)?.status).toBe('in_progress');
    const patient = callNext(first.state, GENERAL_DOCTOR_ID, calledId, later(60 + CALL_COOLDOWN_SECONDS + 1));
    expect(code(patient)).toBe('ok');
  });

  it('reports an empty queue', () => {
    let s = state;
    for (const t of s.tokens.filter((x) => x.doctorId === GENERAL_DOCTOR_ID && x.date === TODAY && x.status === 'waiting')) {
      s = ok(markNoShow(s, t.id)).state;
    }
    s = ok(completeToken(s, current.id, later(60))).state;
    expect(code(callNext(s, GENERAL_DOCTOR_ID, null, later(120)))).toBe('empty');
  });

  it('completes the last patient when nobody is waiting', () => {
    let s = state;
    for (const t of s.tokens.filter((x) => x.doctorId === GENERAL_DOCTOR_ID && x.date === TODAY && x.status === 'waiting')) {
      s = ok(markNoShow(s, t.id)).state;
    }
    const out = ok(callNext(s, GENERAL_DOCTOR_ID, current.id, later(60)));
    expect(out.value.completed?.number).toBe(10);
    expect(out.value.called).toBeUndefined();
    expect(currentToken(out.state, GENERAL_DOCTOR_ID, TODAY)).toBeUndefined();
  });

  it('marks a patient called without a recorded arrival as arrived by the doctor', () => {
    const not = tokensFor(state, GENERAL_DOCTOR_ID, TODAY).find((t) => t.number === 14)!;
    expect(not.arrivedAt).toBeUndefined();
    let s = ok(skipToken(state, number(state, current.id) === 10 ? current.id : '')).state;
    s = ok(markNoShow(s, tokensFor(s, GENERAL_DOCTOR_ID, TODAY).find((t) => t.number === 12)!.id)).state;
    const out = ok(callNext(s, GENERAL_DOCTOR_ID, null, later(60)));
    expect(out.value.called?.number).toBe(14);
    expect(getToken(out.state, not.id)?.arrivalSource).toBe('doctor_call');
  });

  it('skips the current patient and lets reception put them at the end of the line', () => {
    const skipped = ok(skipToken(state, current.id));
    expect(getToken(skipped.state, current.id)?.status).toBe('skipped');
    expect(currentToken(skipped.state, GENERAL_DOCTOR_ID, TODAY)).toBeUndefined();
    const back = ok(requeueToken(skipped.state, current.id));
    const waiting = upcomingTokens(back.state, GENERAL_DOCTOR_ID, TODAY, 20).map((t) => t.number);
    expect(waiting[waiting.length - 1]).toBe(10);
  });

  it('holds the current patient and resumes them to the front of the line', () => {
    const held = ok(holdToken(state, current.id));
    expect(getToken(held.state, current.id)?.status).toBe('on_hold');
    expect(upcomingTokens(held.state, GENERAL_DOCTOR_ID, TODAY, 3).map((t) => t.number)).toEqual([12, 14, 15]);
    const resumed = ok(resumeToken(held.state, current.id));
    expect(upcomingTokens(resumed.state, GENERAL_DOCTOR_ID, TODAY, 3).map((t) => t.number)).toEqual([10, 12, 14]);
    const called = ok(callNext(resumed.state, GENERAL_DOCTOR_ID, null, later(60)));
    expect(called.value.called?.number).toBe(10);
  });

  it('resumes the patient left on hold in the demo data', () => {
    const held = tokensFor(state, GENERAL_DOCTOR_ID, TODAY).find((t) => t.status === 'on_hold')!;
    const resumed = ok(resumeToken(state, held.id));
    expect(upcomingTokens(resumed.state, GENERAL_DOCTOR_ID, TODAY, 1)[0].id).toBe(held.id);
  });

  it('refuses moves that do not make sense', () => {
    const waiting = tokensFor(state, GENERAL_DOCTOR_ID, TODAY).find((t) => t.status === 'waiting')!;
    expect(code(completeToken(state, waiting.id, NOW))).toBe('invalid_transition');
    expect(code(holdToken(state, waiting.id))).toBe('invalid_transition');
    expect(code(resumeToken(state, waiting.id))).toBe('invalid_transition');
    expect(code(requeueToken(state, waiting.id))).toBe('invalid_transition');
    expect(code(markNoShow(state, current.id))).toBe('invalid_transition');
    expect(code(cancelToken(state, current.id))).toBe('invalid_transition');
    expect(code(skipToken(state, 'missing'))).toBe('not_found');
  });

  it('marks arrival once', () => {
    const notArrived = tokensFor(state, GENERAL_DOCTOR_ID, TODAY).find((t) => t.number === 14)!;
    const first = ok(markArrived(state, notArrived.id, NOW));
    expect(first.value.arrivedAt).toBeDefined();
    expect(code(markArrived(first.state, notArrived.id, NOW))).toBe('invalid_transition');
  });

  it('lets a late arrival return after being marked no-show', () => {
    const noShow = tokensFor(state, GENERAL_DOCTOR_ID, TODAY).find((t) => t.status === 'no_show')!;
    const back = ok(requeueToken(state, noShow.id));
    expect(back.value.status).toBe('waiting');
  });

  it('keeps the other doctor queue untouched', () => {
    const child = tokensFor(state, CHILD_DOCTOR_ID, TODAY).map((t) => t.status);
    const next = ok(callNext(state, GENERAL_DOCTOR_ID, current.id, later(60))).state;
    expect(tokensFor(next, CHILD_DOCTOR_ID, TODAY).map((t) => t.status)).toEqual(child);
  });
});

describe('estimates', () => {
  const state = seed();

  it('counts the patient with the doctor as ahead', () => {
    const t17 = tokensFor(state, GENERAL_DOCTOR_ID, TODAY).find((t) => t.number === 17)!;
    const view = queueView(state, t17, NOW)!;
    expect(view.patientsAhead).toBe(5);
    expect(view.estimatedWaitMinutes).toBe(25);
    expect(view.minutesPerPatient).toBe(5);
  });

  it('reduces the count when the queue moves', () => {
    const t17 = tokensFor(state, GENERAL_DOCTOR_ID, TODAY).find((t) => t.number === 17)!;
    const current = currentToken(state, GENERAL_DOCTOR_ID, TODAY)!;
    const next = ok(callNext(state, GENERAL_DOCTOR_ID, current.id, later(60))).state;
    expect(queueView(next, getToken(next, t17.id)!, NOW)!.patientsAhead).toBe(4);
  });

  it('uses a doctor specific minutes per patient', () => {
    const doctor = state.doctors[0];
    const s = ok(updateDoctor(state, doctor.id, { name: doctor.name, opd: doctor.opd, sessions: doctor.sessions, dailyLimit: null, minutesPerPatient: 10 })).state;
    const t17 = tokensFor(s, GENERAL_DOCTOR_ID, TODAY).find((t) => t.number === 17)!;
    expect(queueView(s, t17, NOW)!.estimatedWaitMinutes).toBe(50);
  });

  it('gives no estimate once a token is no longer queued', () => {
    const done = tokensFor(state, GENERAL_DOCTOR_ID, TODAY).find((t) => t.status === 'completed')!;
    const view = queueView(state, done, NOW)!;
    expect(view.patientsAhead).toBeNull();
    expect(view.estimatedTime).toBeNull();
  });

  it('counts only OPD hours when working out a clock time', () => {
    const sessions = [
      { start: '10:00', end: '14:00' },
      { start: '17:00', end: '21:00' },
    ];
    const at = (h: number, m: number) => new Date(2026, 9, 30, h, m);
    expect(estimateClockTime(sessions, TODAY, at(11, 0), 40).at.getHours()).toBe(11);
    expect(estimateClockTime(sessions, TODAY, at(11, 0), 40).at.getMinutes()).toBe(40);
    // 13:50 plus 20 minutes: 10 minutes left in the morning, 10 minutes into the evening.
    const jump = estimateClockTime(sessions, TODAY, at(13, 50), 20);
    expect([jump.at.getHours(), jump.at.getMinutes(), jump.outsideHours]).toEqual([17, 10, false]);
    // Between sessions the clock waits for the evening session.
    const gap = estimateClockTime(sessions, TODAY, at(15, 0), 0);
    expect([gap.at.getHours(), gap.at.getMinutes()]).toEqual([17, 0]);
    // Past closing time.
    const late = estimateClockTime(sessions, TODAY, at(20, 50), 30);
    expect(late.outsideHours).toBe(true);
    // Tomorrow starts when the doctor opens, not at the current time.
    const tomorrow = estimateClockTime(sessions, TOMORROW, at(16, 55), 0);
    expect([tomorrow.at.getHours(), tomorrow.at.getMinutes()]).toEqual([10, 0]);
  });
});

describe('patients and visits', () => {
  const state = seed();

  it('searches by part of a name, ignoring case', () => {
    const names = searchPatients(state, 'kapo').map((m) => m.patient.name);
    expect(names).toEqual(['Aarav Kapoor', 'Meera Kapoor']);
  });

  it('searches by phone digits and ignores spaces', () => {
    expect(searchPatients(state, '90000 00003').map((m) => m.patient.name)).toEqual(['Rahul Sen']);
  });

  it('does not search on a single character', () => {
    expect(searchPatients(state, 'a')).toEqual([]);
    expect(searchPatients(state, '')).toEqual([]);
  });

  it('counts visits and finds the last visit date', () => {
    const meera = searchPatients(state, 'Meera')[0];
    expect(meera.visitCount).toBe(3);
    expect(meera.lastVisitDate).toBe(addDays(TODAY, -12));
  });

  it('saves a consultation note and shows it first in the history', () => {
    const meera = searchPatients(state, 'Meera')[0].patient;
    const { state: next, value } = ok(
      saveVisit(state, { patientId: meera.id, doctorId: GENERAL_DOCTOR_ID, date: TODAY, title: 'Check-up', notes: 'Sample note', advice: 'Sample advice', attachments: ['report.pdf'] }, NOW),
    );
    expect(value.sample).toBe(false);
    expect(visitsFor(next, meera.id)[0].id).toBe(value.id);
    expect(visitsFor(next, meera.id)).toHaveLength(4);
  });

  it('updates the empty visit created when a consultation is completed', () => {
    const current = currentToken(state, GENERAL_DOCTOR_ID, TODAY)!;
    const done = ok(completeToken(state, current.id, NOW)).state;
    const visit = done.visits.find((v) => v.tokenId === current.id)!;
    expect(visit.notes).toBe('');
    const { state: next } = ok(
      saveVisit(done, { visitId: visit.id, patientId: visit.patientId, doctorId: visit.doctorId, date: visit.date, title: 'Throat pain', notes: 'Sample note', advice: '', attachments: [] }, NOW),
    );
    expect(visitsFor(next, visit.patientId).filter((v) => v.tokenId === current.id)).toHaveLength(1);
    expect(next.visits.find((v) => v.id === visit.id)?.title).toBe('Throat pain');
  });

  it('rejects an empty note and a future date', () => {
    const meera = searchPatients(state, 'Meera')[0].patient;
    const empty = saveVisit(state, { patientId: meera.id, doctorId: GENERAL_DOCTOR_ID, date: TODAY, title: 'Check-up', notes: '', advice: '', attachments: [] }, NOW);
    expect(code(empty)).toBe('invalid_input');
    const future = saveVisit(state, { patientId: meera.id, doctorId: GENERAL_DOCTOR_ID, date: TOMORROW, title: 'Check-up', notes: 'x', advice: '', attachments: [] }, NOW);
    expect(!future.result.ok && future.result.fieldErrors?.date).toBeDefined();
  });
});

describe('queue status', () => {
  const state = seed();

  it('says who the doctor is seeing', () => {
    expect(queueStatus(state, GENERAL_DOCTOR_ID, TODAY, TODAY)).toEqual({ code: 'running', label: 'Doctor is seeing token #10' });
  });

  it('describes a queue between patients', () => {
    const current = currentToken(state, GENERAL_DOCTOR_ID, TODAY)!;
    const next = ok(completeToken(state, current.id, NOW)).state;
    expect(queueStatus(next, GENERAL_DOCTOR_ID, TODAY, TODAY).code).toBe('between');
  });

  it('describes tomorrow as not yet open', () => {
    expect(queueStatus(state, GENERAL_DOCTOR_ID, TOMORROW, TODAY).code).toBe('scheduled');
  });

  it('finishes when every token is done', () => {
    let s = state;
    for (const t of s.tokens.filter((x) => x.doctorId === CHILD_DOCTOR_ID && x.date === TODAY && x.status !== 'completed')) {
      s = { ...s, tokens: s.tokens.map((x) => (x.id === t.id ? { ...x, status: 'completed' as const } : x)) };
    }
    expect(queueStatus(s, CHILD_DOCTOR_ID, TODAY, TODAY).code).toBe('finished');
  });

  it('reports a queue that has not started', () => {
    const fresh = ok(createToken({ ...state, tokens: [] }, { name: 'Test Patient', phone: '9111111111', doctorId: CHILD_DOCTOR_ID, date: TODAY, source: 'online' }, NOW)).state;
    expect(queueStatus(fresh, CHILD_DOCTOR_ID, TODAY, TODAY).code).toBe('not_started');
    expect(queueStatus({ ...state, tokens: [] }, CHILD_DOCTOR_ID, TODAY, TODAY).label).toBe('No tokens issued yet');
  });
});

describe('reception list', () => {
  const state = seed();
  const rows = (query: string, doctorId: string = 'all', status: StatusFilter = 'all') =>
    receptionRows(state, TODAY, { query, doctorId, status });

  it('lists every token for today across doctors', () => {
    const all = rows('');
    expect(all).toHaveLength(17 + 6);
    expect(all[0].token.number).toBe(1);
  });

  it('finds a token by number with or without a hash, and not by partial digits', () => {
    expect(rows('#12', GENERAL_DOCTOR_ID).map((r) => r.token.number)).toEqual([12]);
    expect(rows('1', GENERAL_DOCTOR_ID).map((r) => r.token.number)).toEqual([1]);
  });

  it('finds by name and by phone number', () => {
    const meera = rows('meera');
    expect(meera).toHaveLength(1);
    expect(meera[0].patient.phone).toBe('9000000001');
    expect(rows('9000000001').map((r) => r.patient.name)).toEqual(['Meera Kapoor', 'Aarav Kapoor']);
  });

  it('filters by doctor', () => {
    expect(rows('', CHILD_DOCTOR_ID)).toHaveLength(6);
  });

  it('filters by status, treating arrived and not arrived as waiting patients', () => {
    expect(rows('', GENERAL_DOCTOR_ID, 'in_progress').map((r) => r.token.number)).toEqual([10]);
    expect(rows('', GENERAL_DOCTOR_ID, 'on_hold').map((r) => r.token.number)).toEqual([11]);
    expect(rows('', GENERAL_DOCTOR_ID, 'skipped').map((r) => r.token.number)).toEqual([13]);
    expect(rows('', GENERAL_DOCTOR_ID, 'no_show').map((r) => r.token.number)).toEqual([9]);
    expect(rows('', GENERAL_DOCTOR_ID, 'arrived').map((r) => r.token.number)).toEqual([12, 15, 16]);
    expect(rows('', GENERAL_DOCTOR_ID, 'not_arrived').map((r) => r.token.number)).toEqual([14, 17]);
  });
});

describe('visit numbers', () => {
  const state = seed();

  it('counts earlier visits plus this one', () => {
    const meera = tokensFor(state, GENERAL_DOCTOR_ID, TODAY).find((t) => t.number === 12)!;
    expect(visitNumber(state, meera)).toBe(4);
  });

  it('does not count the visit created from the same token twice', () => {
    const current = currentToken(state, GENERAL_DOCTOR_ID, TODAY)!;
    const before = visitNumber(state, current);
    const done = ok(completeToken(state, current.id, NOW)).state;
    expect(visitNumber(done, getToken(done, current.id)!)).toBe(before);
  });

  it('writes numbers as ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
  });
});

describe('reports', () => {
  const state = seed();

  it('counts today from the token records', () => {
    const stats = dayStats(state, TODAY, GENERAL_DOCTOR_ID);
    expect(stats).toMatchObject({ total: 17, completed: 8, noShow: 1, cancelled: 0, waitSamples: 10, averageWaitMinutes: 14 });
  });

  it('covers every doctor when asked for all', () => {
    const all = dayStats(state, TODAY, 'all');
    const parts = state.doctors.map((d) => dayStats(state, TODAY, d.id).total);
    expect(all.total).toBe(parts.reduce((a, b) => a + b, 0));
  });

  it('builds seven days ending today', () => {
    const series = weekSeries(state, TODAY, 'all');
    expect(series).toHaveLength(7);
    expect(series[6].date).toBe(TODAY);
    expect(series[0].date).toBe(addDays(TODAY, -6));
    expect(series.every((d) => d.total > 0)).toBe(true);
  });

  it('changes when the queue changes', () => {
    const before = dayStats(state, TODAY, 'all');
    const current = currentToken(state, GENERAL_DOCTOR_ID, TODAY)!;
    const next = ok(callNext(state, GENERAL_DOCTOR_ID, current.id, later(60))).state;
    const after = dayStats(next, TODAY, 'all');
    expect(after.completed).toBe(before.completed + 1);
    const booked = ok(createToken(next, { name: 'Test Patient', phone: '9111111111', doctorId: CHILD_DOCTOR_ID, date: TODAY, source: 'walk_in' }, later(90))).state;
    expect(dayStats(booked, TODAY, 'all').total).toBe(after.total + 1);
  });

  it('leaves cancelled tokens out of the totals but counts them', () => {
    const waiting = tokensFor(state, GENERAL_DOCTOR_ID, TODAY).find((t) => t.status === 'waiting')!;
    const next = ok(cancelToken(state, waiting.id)).state;
    const stats = dayStats(next, TODAY, GENERAL_DOCTOR_ID);
    expect(stats.total).toBe(16);
    expect(stats.cancelled).toBe(1);
  });

  it('exports a CSV with a header and one row per OPD per day, and neutralises formulas', () => {
    let s = state;
    const doctor = s.doctors[1];
    s = ok(updateDoctor(s, doctor.id, { name: doctor.name, opd: '=HYPERLINK("x")', sessions: doctor.sessions, dailyLimit: null, minutesPerPatient: null })).state;
    const csv = monthlyCsv(s, TODAY.slice(0, 7));
    const lines = csv.split('\n');
    expect(lines[0]).toBe('date,opd,tokens_issued,completed,no_show,cancelled,average_wait_minutes');
    expect(lines.length).toBeGreaterThan(2);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });
});

describe('settings', () => {
  const state = seed();

  it('validates clinic settings', () => {
    const bad = updateSettings(state, { clinicName: 'A', onlineBookingEnabled: true, defaultDailyLimit: 0, defaultMinutesPerPatient: 99 });
    expect(code(bad)).toBe('invalid_input');
    expect(!bad.result.ok && Object.keys(bad.result.fieldErrors ?? {}).sort()).toEqual(['clinicName', 'defaultDailyLimit', 'defaultMinutesPerPatient']);
    const good = ok(updateSettings(state, { clinicName: 'City Clinic', onlineBookingEnabled: false, defaultDailyLimit: 30, defaultMinutesPerPatient: 8 }));
    expect(good.state.settings.defaultDailyLimit).toBe(30);
  });

  it('applies the clinic limit unless a doctor has their own', () => {
    let s = ok(updateSettings(state, { ...state.settings, defaultDailyLimit: 17 })).state;
    expect(bookingAvailability(s, GENERAL_DOCTOR_ID, TODAY).open).toBe(false);
    expect(bookingAvailability(s, CHILD_DOCTOR_ID, TODAY).open).toBe(true);
    const doctor = s.doctors[0];
    s = ok(updateDoctor(s, doctor.id, { name: doctor.name, opd: doctor.opd, sessions: doctor.sessions, dailyLimit: 25, minutesPerPatient: null })).state;
    expect(bookingAvailability(s, GENERAL_DOCTOR_ID, TODAY).open).toBe(true);
  });

  it('refuses to remove a doctor who still has open tokens', () => {
    const out = removeDoctor(state, CHILD_DOCTOR_ID, NOW);
    expect(code(out)).toBe('invalid_transition');
    expect(!out.result.ok && out.result.message).toMatch(/open token/);
  });

  it('removes a doctor with no open tokens and keeps the record for reports', () => {
    const added = ok(addDoctor(state, { name: 'Dr. Temp Person', opd: 'Temp OPD', sessions: [{ start: '10:00', end: '12:00' }], dailyLimit: null, minutesPerPatient: null }));
    const removed = ok(removeDoctor(added.state, added.value.id, NOW));
    expect(removed.state.doctors.find((d) => d.id === added.value.id)?.active).toBe(false);
    expect(removed.state.doctors).toHaveLength(3);
  });

  it('keeps at least one doctor', () => {
    let s = state;
    const added = ok(addDoctor(s, { name: 'Dr. Temp Person', opd: 'Temp OPD', sessions: [{ start: '10:00', end: '12:00' }], dailyLimit: null, minutesPerPatient: null }));
    s = added.state;
    // Close every open token so removal is not blocked by them.
    for (const t of s.tokens.filter((x) => x.date >= TODAY)) {
      s = { ...s, tokens: s.tokens.map((x) => (x.id === t.id ? { ...x, status: 'completed' as const } : x)) };
    }
    s = ok(removeDoctor(s, GENERAL_DOCTOR_ID, NOW)).state;
    s = ok(removeDoctor(s, CHILD_DOCTOR_ID, NOW)).state;
    expect(code(removeDoctor(s, added.value.id, NOW))).toBe('invalid_transition');
  });

  it('validates doctor details', () => {
    const out = addDoctor(state, { name: 'D', opd: '', sessions: [], dailyLimit: 0, minutesPerPatient: 100 });
    expect(code(out)).toBe('invalid_input');
    expect(!out.result.ok && Object.keys(out.result.fieldErrors ?? {}).sort()).toEqual(['dailyLimit', 'minutesPerPatient', 'name', 'opd', 'sessions']);
  });
});

describe('permissions', () => {
  it('keeps each role to its own actions', () => {
    expect(can('patient', 'booking.create')).toBe(true);
    expect(can('patient', 'queue.callNext')).toBe(false);
    expect(can('reception', 'walkin.create')).toBe(true);
    expect(can('reception', 'queue.callNext')).toBe(false);
    expect(can('reception', 'history.read')).toBe(false);
    expect(can('doctor', 'queue.callNext')).toBe(true);
    expect(can('doctor', 'settings.write')).toBe(false);
    expect(can('doctor', 'report.read')).toBe(true);
    expect(can('owner', 'settings.write')).toBe(true);
    expect(can('owner', 'queue.callNext')).toBe(false);
    expect(can('owner', 'walkin.create')).toBe(false);
  });
});
