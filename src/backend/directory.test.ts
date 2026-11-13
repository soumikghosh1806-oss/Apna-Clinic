import { describe, expect, it } from 'vitest';
import { mapDirectory, mapDirectoryFilters, placeLine } from './directory';
import { mapMyPosition, mapPublicQueue } from './mappers';
import { availabilityLine, queueLine, timingText } from '../domain/availabilityText';
import { readAnswer, toFailure } from './rpc';

describe('directory answers', () => {
  const dto = {
    ok: true, total: 2, offset: 0, limit: 8,
    clinics: [
      {
        slug: 'sunrise-skin', name: 'Sunrise Skin Centre', city: 'Pune', address: '12 MG Road', phone: '+91 20 5550 1234', any_open: true,
        doctors: [{
          id: 'd1', name: 'Dr Meera Skin', opd: 'Skin OPD', specialization: 'Dermatologist',
          today: { open: true, issued: 3, limit: 100, sessions: [{ start: '10:00:00', end: '14:00:00', open: true, issued: 3 }] },
          queue: { status: { code: 'running', label: 'Doctor is seeing token #2' }, waiting_count: 4, current_number: 2, consulting: true },
        }],
      },
      { slug: 'harbour', name: 'Harbour Heart Clinic', any_open: false, doctors: [] },
    ],
  };

  it('reads clinics, doctors, availability and queue numbers', () => {
    const page = mapDirectory(dto);
    expect(page.total).toBe(2);
    const [a, b] = page.clinics;
    expect(a).toMatchObject({ slug: 'sunrise-skin', city: 'Pune', phone: '+91 20 5550 1234', anyOpen: true });
    expect(a!.doctors[0]).toMatchObject({ name: 'Dr Meera Skin', specialization: 'Dermatologist' });
    expect(a!.doctors[0]!.today.sessions).toEqual([{ start: '10:00', end: '14:00', open: true, issued: 3 }]);
    expect(a!.doctors[0]!.queue).toEqual({ status: { code: 'running', label: 'Doctor is seeing token #2' }, waitingCount: 4, currentNumber: 2, consulting: true });
    // Missing optional parts stay absent, they are not shown as "undefined" or empty text.
    expect(b).toMatchObject({ anyOpen: false, doctors: [] });
    expect(b!.phone).toBeUndefined();
    expect(b!.city).toBeUndefined();
  });

  it('survives odd data and makes a place line from what is there', () => {
    expect(mapDirectory({}).clinics).toEqual([]);
    expect(mapDirectory({ clinics: 'x', total: 'many' })).toMatchObject({ total: 0, clinics: [] });
    expect(placeLine({ address: '12 MG Road', city: 'Pune' })).toBe('12 MG Road, Pune');
    expect(placeLine({ city: 'Pune' })).toBe('Pune');
    expect(placeLine({})).toBe('');
    expect(mapDirectoryFilters({ specializations: ['Cardiologist', 7, '', 'Dermatologist'] })).toEqual(['Cardiologist', 'Dermatologist']);
  });

  it('writes the wording for people', () => {
    expect(availabilityLine({ open: true, issued: 3, limit: 100 })).toBe('97 of 100 tokens left');
    expect(availabilityLine({ open: false, reason: 'closed', closedReason: 'holiday', issued: 0, limit: 100 })).toBe('Clinic closed');
    expect(availabilityLine({ open: false, reason: 'ended', issued: 0, limit: 100 })).toBe("Today's OPD is over");
    expect(timingText({ start: '09:30', end: '12:45' })).toMatch(/9:30.*12:45/);
    const running = { status: { code: 'running' as const, label: 'x' }, waitingCount: 4, currentNumber: 2, consulting: true };
    expect(queueLine(running)).toBe('Now serving token 2. 4 waiting.');
    expect(queueLine({ ...running, waitingCount: 0 })).toBe('Now serving token 2. Nobody else is waiting.');
    expect(queueLine({ status: { code: 'closed', label: 'The clinic is closed on Wednesday, 11 Mar.' }, waitingCount: 0, currentNumber: null, consulting: false }))
      .toBe('The clinic is closed on Wednesday, 11 Mar.');
    expect(queueLine({ status: { code: 'not_started', label: 'Not started yet' }, waitingCount: 3, currentNumber: null, consulting: false })).toBe('Not started yet. 3 waiting.');
  });
});

describe('public queue and own place', () => {
  it('reads what a new booking can expect, and whether the queue is open', () => {
    const board = mapPublicQueue({
      ok: true, clinic: { name: 'Sunrise', slug: 's', timezone: 'Asia/Kolkata' }, now: '2026-03-10T05:30:00+00:00', today: '2026-03-10', date: '2026-03-10',
      doctors: [{ id: 'd1', name: 'Dr A', opd: 'Skin OPD', specialization: 'dermatologist' }],
      doctor: { id: 'd1', name: 'Dr A', opd: 'Skin OPD', specialization: 'dermatologist' },
      board: { status: { code: 'running', label: 'Doctor is seeing token #1' }, current_number: 1, upcoming: [2], waiting_count: 1, consulting: true, on_break: false, sessions: [] },
      estimate: { minutes_per_patient: 10, wait_for_new_booking_minutes: 20, queue_open: true },
    });
    expect(board.doctor).toMatchObject({ name: 'Dr A', specialization: 'dermatologist' });
    expect(board).toMatchObject({ waitingCount: 1, consulting: true, currentNumber: 1 });
    expect(board.estimate).toEqual({ minutesPerPatient: 10, waitForNewBookingMinutes: 20, queueOpen: true });
    expect(mapPublicQueue({ ok: true, now: '2026-03-10T05:30:00+00:00', board: {} }).estimate).toBeUndefined();
    expect(mapPublicQueue({ now: '2026-03-10T05:30:00+00:00', estimate: { minutes_per_patient: 10, wait_for_new_booking_minutes: 0, queue_open: false } }).estimate?.queueOpen).toBe(false);
  });

  it("reads a patient's own tokens after verification, with no name, phone or key", () => {
    const data = mapMyPosition({
      ok: true, today: '2026-03-10', now: '2026-03-10T05:30:00+00:00', timezone: 'Asia/Kolkata',
      tokens: [
        { number: 5, status: 'waiting', session_start: '10:00', session_end: '14:00', view: { patients_ahead: 2, estimated_wait_minutes: 20, estimated_time: { at: '2026-03-10T05:50:00+00:00' }, minutes_per_patient: 10 } },
        { number: 3, status: 'completed' },
        { number: 4, status: 'serving', view: { patients_ahead: 0, estimated_wait_minutes: 0 } },
      ],
    });
    expect(data.places).toHaveLength(3);
    expect(data.places[0]).toMatchObject({ number: 5, status: 'waiting', patientsAhead: 2, estimatedWaitMinutes: 20, session: { start: '10:00', end: '14:00' } });
    expect(data.places[0]!.estimatedTime).not.toBeNull();
    expect(data.places[1]).toMatchObject({ number: 3, status: 'completed', patientsAhead: null, estimatedWaitMinutes: null });
    expect(data.places[2]!.status).toBe('in_progress');
    expect(Object.keys(data.places[0]!).sort()).toEqual(['estimatedTime', 'estimatedWaitMinutes', 'minutesPerPatient', 'number', 'patientsAhead', 'session', 'status']);
    expect(mapMyPosition({ now: '2026-03-10T05:30:00+00:00' }).places).toEqual([]);
  });

  it('reads one time code refusals, including the tries that are left', () => {
    const wrong = toFailure({ ok: false, code: 'otp_invalid', message: 'That code is not correct.', field_errors: { code: 'x' }, attempts_left: 3 });
    expect(wrong).toMatchObject({ code: 'otp_invalid', attemptsLeft: 3, fieldErrors: { code: 'x' } });
    for (const code of ['otp_required', 'otp_expired', 'delivery_failed', 'not_configured']) {
      expect(toFailure({ ok: false, code, message: 'm' }).code).toBe(code);
    }
    expect(readAnswer({ data: { ok: false, code: 'otp_required', message: 'm' }, error: null })).toMatchObject({ ok: false, code: 'otp_required' });
  });
});
