// Clinic settings and doctor list rules.

import { addDays, toDateKey } from './dates';
import { ACTIVE_STATUSES, fail, getDoctor, nextId, succeed } from './queue';
import type { AppState, Doctor, OpdSession, Outcome, Settings } from './types';
import { validateSessions, validateWholeNumber } from './validation';

export const LIMIT_MIN = 1;
export const LIMIT_MAX = 500;
export const MINUTES_MIN = 1;
export const MINUTES_MAX = 60;

export interface SettingsInput {
  clinicName: string;
  onlineBookingEnabled: boolean;
  defaultDailyLimit: number;
  defaultMinutesPerPatient: number;
  /** Only with a real backend. */
  maxOnlineBookingsPerPhone?: number;
}

export function updateSettings(state: AppState, input: SettingsInput): Outcome<Settings> {
  const fieldErrors: Record<string, string> = {};
  const name = input.clinicName.trim();
  if (name.length < 2 || name.length > 60) fieldErrors.clinicName = 'The clinic name needs 2 to 60 characters.';
  const limitError = validateWholeNumber(input.defaultDailyLimit, LIMIT_MIN, LIMIT_MAX, 'The daily token limit');
  if (limitError) fieldErrors.defaultDailyLimit = limitError;
  const minutesError = validateWholeNumber(
    input.defaultMinutesPerPatient,
    MINUTES_MIN,
    MINUTES_MAX,
    'Minutes per patient',
  );
  if (minutesError) fieldErrors.defaultMinutesPerPatient = minutesError;
  if (Object.keys(fieldErrors).length > 0) {
    return fail(state, 'invalid_input', 'Please fix the highlighted fields.', { fieldErrors });
  }
  const settings: Settings = {
    clinicName: name,
    onlineBookingEnabled: input.onlineBookingEnabled,
    defaultDailyLimit: input.defaultDailyLimit,
    defaultMinutesPerPatient: input.defaultMinutesPerPatient,
  };
  return succeed({ ...state, settings }, settings);
}

export interface DoctorInput {
  name: string;
  opd: string;
  sessions: OpdSession[];
  dailyLimit: number | null;
  minutesPerPatient: number | null;
}

function checkDoctorInput(input: DoctorInput): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  const name = input.name.trim();
  const opd = input.opd.trim();
  if (name.length < 2 || name.length > 60) fieldErrors.name = 'The doctor name needs 2 to 60 characters.';
  if (opd.length < 2 || opd.length > 40) fieldErrors.opd = 'The OPD name needs 2 to 40 characters.';
  const sessionError = validateSessions(input.sessions);
  if (sessionError) fieldErrors.sessions = sessionError;
  if (input.dailyLimit !== null) {
    const e = validateWholeNumber(input.dailyLimit, LIMIT_MIN, LIMIT_MAX, 'The doctor token limit');
    if (e) fieldErrors.dailyLimit = e;
  }
  if (input.minutesPerPatient !== null) {
    const e = validateWholeNumber(input.minutesPerPatient, MINUTES_MIN, MINUTES_MAX, 'Minutes per patient');
    if (e) fieldErrors.minutesPerPatient = e;
  }
  return fieldErrors;
}

export function updateDoctor(state: AppState, doctorId: string, input: DoctorInput): Outcome<Doctor> {
  const doctor = getDoctor(state, doctorId);
  if (!doctor || !doctor.active) return fail(state, 'not_found', 'This doctor could not be found.');
  const fieldErrors = checkDoctorInput(input);
  if (Object.keys(fieldErrors).length > 0) {
    return fail(state, 'invalid_input', 'Please fix the highlighted fields.', { fieldErrors });
  }
  const updated: Doctor = {
    ...doctor,
    name: input.name.trim(),
    opd: input.opd.trim(),
    sessions: input.sessions.map((s) => ({ start: s.start, end: s.end })),
    dailyLimit: input.dailyLimit,
    minutesPerPatient: input.minutesPerPatient,
  };
  return succeed({ ...state, doctors: state.doctors.map((d) => (d.id === doctorId ? updated : d)) }, updated);
}

export function addDoctor(state: AppState, input: DoctorInput): Outcome<Doctor> {
  const fieldErrors = checkDoctorInput(input);
  if (Object.keys(fieldErrors).length > 0) {
    return fail(state, 'invalid_input', 'Please fix the highlighted fields.', { fieldErrors });
  }
  const idResult = nextId(state, 'doc');
  const doctor: Doctor = {
    id: idResult.id,
    name: input.name.trim(),
    opd: input.opd.trim(),
    sessions: input.sessions.map((s) => ({ start: s.start, end: s.end })),
    dailyLimit: input.dailyLimit,
    minutesPerPatient: input.minutesPerPatient,
    active: true,
  };
  return succeed({ ...idResult.state, doctors: [...idResult.state.doctors, doctor] }, doctor);
}

/** How many tokens for today or tomorrow still need the doctor. Used to warn before removing. */
export function openTokenCount(state: AppState, doctorId: string, now: Date): number {
  const today = toDateKey(now);
  const tomorrow = addDays(today, 1);
  return state.tokens.filter(
    (t) => t.doctorId === doctorId && (t.date === today || t.date === tomorrow) && ACTIVE_STATUSES.includes(t.status),
  ).length;
}

/**
 * Removes a doctor from booking and the queue screens. The doctor record is kept as inactive
 * so past reports still add up. Refused while the doctor still has open tokens.
 */
export function removeDoctor(state: AppState, doctorId: string, now: Date): Outcome<Doctor> {
  const doctor = getDoctor(state, doctorId);
  if (!doctor || !doctor.active) return fail(state, 'not_found', 'This doctor could not be found.');
  if (state.doctors.filter((d) => d.active).length <= 1) {
    return fail(state, 'invalid_transition', 'Keep at least one doctor. Add another doctor before removing this one.');
  }
  const open = openTokenCount(state, doctorId, now);
  if (open > 0) {
    return fail(
      state,
      'invalid_transition',
      `${doctor.name} still has ${open} open token${open === 1 ? '' : 's'} for today or tomorrow. Finish or cancel them first.`,
    );
  }
  const updated: Doctor = { ...doctor, active: false };
  return succeed({ ...state, doctors: state.doctors.map((d) => (d.id === doctorId ? updated : d)) }, updated);
}
