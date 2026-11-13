// Queue rules for the whole app. Every function here is pure: it takes the current state and
// returns the next state plus a result. Screens never calculate queue numbers themselves.

import { addDays, formatTime, fromDateKey, minutesOfDay, parseHM, toDateKey } from './dates';
import type {
  AppState,
  DateKey,
  Doctor,
  ErrorCode,
  Failure,
  OpdSession,
  Outcome,
  Patient,
  Token,
  TokenSource,
  TokenStatus,
  Visit,
} from './types';
import { checkContact } from './validation';

/** A patient who was called less than this many seconds ago cannot be advanced again. Stops double taps. */
export const CALL_COOLDOWN_SECONDS = 3;

/** Statuses that still need attention from the clinic. */
export const ACTIVE_STATUSES: TokenStatus[] = ['waiting', 'in_progress', 'on_hold', 'skipped'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function fail(state: AppState, code: ErrorCode, message: string, extra: Partial<Failure> = {}): Outcome<never> {
  return { state, result: { ok: false, code, message, ...extra } };
}

export function succeed<T>(state: AppState, value: T): Outcome<T> {
  return { state, result: { ok: true, value } };
}

export function nextId(state: AppState, prefix: string): { id: string; state: AppState } {
  const counter = state.idCounter + 1;
  return { id: `${prefix}-${counter}`, state: { ...state, idCounter: counter } };
}

export function getDoctor(state: AppState, id: string): Doctor | undefined {
  return state.doctors.find((d) => d.id === id);
}

export function activeDoctors(state: AppState): Doctor[] {
  return state.doctors.filter((d) => d.active);
}

export function getPatient(state: AppState, id: string): Patient | undefined {
  return state.patients.find((p) => p.id === id);
}

export function getToken(state: AppState, id: string): Token | undefined {
  return state.tokens.find((t) => t.id === id);
}

export function dailyLimitFor(state: AppState, doctor: Doctor): number {
  return doctor.dailyLimit ?? state.settings.defaultDailyLimit;
}

export function minutesPerPatientFor(state: AppState, doctor: Doctor): number {
  return doctor.minutesPerPatient ?? state.settings.defaultMinutesPerPatient;
}

function replaceToken(state: AppState, id: string, patch: Partial<Token>): AppState {
  return { ...state, tokens: state.tokens.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

// ---------------------------------------------------------------------------
// Reading the queue
// ---------------------------------------------------------------------------

/** All tokens for one doctor on one day, in token number order. */
export function tokensFor(state: AppState, doctorId: string, date: DateKey): Token[] {
  return state.tokens.filter((t) => t.doctorId === doctorId && t.date === date).sort((a, b) => a.number - b.number);
}

/** Tokens issued, not counting cancelled ones. This is what the daily limit is checked against. */
export function issuedCount(state: AppState, doctorId: string, date: DateKey): number {
  return tokensFor(state, doctorId, date).filter((t) => t.status !== 'cancelled').length;
}

/** The patient currently with the doctor. */
export function currentToken(state: AppState, doctorId: string, date: DateKey): Token | undefined {
  return tokensFor(state, doctorId, date).find((t) => t.status === 'in_progress');
}

/** Waiting tokens in calling order. */
export function waitingTokens(state: AppState, doctorId: string, date: DateKey): Token[] {
  return tokensFor(state, doctorId, date)
    .filter((t) => t.status === 'waiting')
    .sort((a, b) => a.orderKey - b.orderKey || a.number - b.number);
}

export function upcomingTokens(state: AppState, doctorId: string, date: DateKey, count: number): Token[] {
  return waitingTokens(state, doctorId, date).slice(0, count);
}

export function tokensWithStatus(state: AppState, doctorId: string, date: DateKey, status: TokenStatus): Token[] {
  return tokensFor(state, doctorId, date).filter((t) => t.status === status);
}

export type QueueStatusCode = 'scheduled' | 'not_started' | 'running' | 'between' | 'finished' | 'closed';

export interface QueueStatus {
  code: QueueStatusCode;
  label: string;
}

/** One plain sentence about where a doctor's queue stands. Used by the patient screens. */
export function queueStatus(state: AppState, doctorId: string, date: DateKey, today: DateKey): QueueStatus {
  if (date > today) return { code: 'scheduled', label: 'Queue opens on the day of the visit' };
  const tokens = tokensFor(state, doctorId, date).filter((t) => t.status !== 'cancelled');
  const current = tokens.find((t) => t.status === 'in_progress');
  if (current) return { code: 'running', label: `Doctor is seeing token #${current.number}` };
  const waiting = tokens.filter((t) => t.status === 'waiting').length;
  const completed = tokens.filter((t) => t.status === 'completed').length;
  const pending = tokens.filter((t) => t.status === 'on_hold' || t.status === 'skipped').length;
  if (waiting > 0) {
    return completed > 0
      ? { code: 'between', label: 'Between patients, the next token will be called soon' }
      : { code: 'not_started', label: 'Not started yet' };
  }
  if (pending > 0) return { code: 'between', label: 'Waiting for held or skipped patients' };
  if (tokens.length === 0) return { code: 'not_started', label: 'No tokens issued yet' };
  return { code: 'finished', label: 'All tokens for today are done' };
}

/** One OPD session on a day a patient can book. */
export interface SessionSlot {
  start: string;
  end: string;
  /** False once the session has ended (only possible today). */
  open: boolean;
  /** Tokens already booked in this session. */
  issued: number;
}

export interface Availability {
  open: boolean;
  /** closed: no OPD that day (see closedReason). ended: today's OPD is over. */
  reason?: 'online_disabled' | 'full' | 'doctor_unavailable' | 'closed' | 'ended';
  closedReason?: 'leave' | 'holiday' | 'weekly_off';
  issued: number;
  limit: number;
  /** The day's sessions. Only the real backend has them; the demo books into one whole day queue. */
  sessions?: SessionSlot[];
}

/** Whether a patient can book online for this doctor and day. */
export function bookingAvailability(state: AppState, doctorId: string, date: DateKey): Availability {
  const doctor = getDoctor(state, doctorId);
  if (!doctor || !doctor.active) return { open: false, reason: 'doctor_unavailable', issued: 0, limit: 0 };
  const limit = dailyLimitFor(state, doctor);
  const issued = issuedCount(state, doctorId, date);
  if (!state.settings.onlineBookingEnabled) return { open: false, reason: 'online_disabled', issued, limit };
  if (issued >= limit) return { open: false, reason: 'full', issued, limit };
  return { open: true, issued, limit };
}

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

export interface TimeEstimate {
  at: Date;
  /** True when the estimate falls after the last OPD timing of the day. */
  outsideHours: boolean;
}

/**
 * Clock time after `offsetMinutes` of consulting, counting only OPD hours.
 * For today the clock starts at `now`; for other days it starts when the first session opens.
 */
export function estimateClockTime(
  sessions: OpdSession[],
  date: DateKey,
  now: Date,
  offsetMinutes: number,
): TimeEstimate {
  const windows = sessions
    .map((s) => ({ start: parseHM(s.start), end: parseHM(s.end) }))
    .filter((s) => !Number.isNaN(s.start) && !Number.isNaN(s.end))
    .sort((a, b) => a.start - b.start);

  const base = fromDateKey(date);
  const toDate = (min: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, min);
  const isToday = date === toDateKey(now);
  let cursor = isToday ? minutesOfDay(now) : 0;
  let remaining = Math.max(0, offsetMinutes);

  for (const w of windows) {
    if (cursor >= w.end) continue;
    cursor = Math.max(cursor, w.start);
    const available = w.end - cursor;
    if (remaining <= available) {
      return { at: toDate(cursor + remaining), outsideHours: false };
    }
    remaining -= available;
    cursor = w.end;
  }
  return { at: toDate(cursor + remaining), outsideHours: true };
}

export interface QueueView {
  token: Token;
  doctor: Doctor;
  /** Patients to be seen before this token, including the one with the doctor now. Null when the token is not queued. */
  patientsAhead: number | null;
  estimatedWaitMinutes: number | null;
  estimatedTime: TimeEstimate | null;
  /** 0 to 1, how much of the line in front of this token is already done. */
  progress: number;
  current?: Token;
  minutesPerPatient: number;
}

/** Everything the patient screens need to know about one token. */
export function queueView(state: AppState, token: Token, now: Date): QueueView | undefined {
  const doctor = getDoctor(state, token.doctorId);
  if (!doctor) return undefined;
  const minutesPerPatient = minutesPerPatientFor(state, doctor);
  const current = currentToken(state, token.doctorId, token.date);
  const dayTokens = tokensFor(state, token.doctorId, token.date).filter((t) => t.status !== 'cancelled');

  let patientsAhead: number | null = null;
  if (token.status === 'in_progress') {
    patientsAhead = 0;
  } else if (token.status === 'waiting') {
    const waitingBefore = waitingTokens(state, token.doctorId, token.date).filter(
      (t) => t.orderKey < token.orderKey || (t.orderKey === token.orderKey && t.number < token.number),
    ).length;
    patientsAhead = waitingBefore + (current ? 1 : 0);
  }

  const estimatedWaitMinutes = patientsAhead === null ? null : patientsAhead * minutesPerPatient;
  const estimatedTime =
    estimatedWaitMinutes === null ? null : estimateClockTime(doctor.sessions, token.date, now, estimatedWaitMinutes);

  const inFront = dayTokens.filter((t) => t.id !== token.id && t.orderKey < token.orderKey);
  const finished = inFront.filter((t) => t.status === 'completed' || t.status === 'no_show' || t.status === 'skipped');
  const progress = token.status === 'completed' ? 1 : inFront.length === 0 ? 1 : finished.length / inFront.length;

  return { token, doctor, patientsAhead, estimatedWaitMinutes, estimatedTime, progress, current, minutesPerPatient };
}

/** Plain words for the estimate, used on the confirmation and live queue screens. */
export function describeEstimate(view: QueueView): string {
  if (view.estimatedTime === null || view.estimatedWaitMinutes === null) return '';
  const time = formatTime(view.estimatedTime.at);
  return view.estimatedTime.outsideHours ? `${time} (after OPD hours)` : time;
}

// ---------------------------------------------------------------------------
// Creating tokens
// ---------------------------------------------------------------------------

export interface CreateTokenInput {
  name: string;
  phone: string;
  doctorId: string;
  date: DateKey;
  source: TokenSource;
  /** Reception may issue a walk-in token after the daily limit is reached. */
  allowOverLimit?: boolean;
}

export function createToken(state: AppState, input: CreateTokenInput, now: Date): Outcome<Token> {
  const today = toDateKey(now);
  const tomorrow = addDays(today, 1);

  const contact = checkContact(input.name, input.phone);
  if (Object.keys(contact.fieldErrors).length > 0) {
    return fail(state, 'invalid_input', 'Please fix the highlighted fields.', { fieldErrors: contact.fieldErrors });
  }

  const doctor = getDoctor(state, input.doctorId);
  if (!doctor || !doctor.active) {
    return fail(state, 'doctor_unavailable', 'This doctor or OPD is not available.');
  }

  if (input.source === 'online') {
    if (input.date !== today && input.date !== tomorrow) {
      return fail(state, 'invalid_date', 'You can book a token for today or tomorrow only.');
    }
    if (!state.settings.onlineBookingEnabled) {
      return fail(state, 'online_disabled', 'Online booking is switched off. Please visit the clinic reception.');
    }
  } else if (input.date !== today) {
    return fail(state, 'invalid_date', 'Walk-in tokens are for today only.');
  }

  const limit = dailyLimitFor(state, doctor);
  const issued = issuedCount(state, doctor.id, input.date);
  if (issued >= limit && !(input.source === 'walk_in' && input.allowOverLimit)) {
    return fail(state, 'full', `All ${limit} tokens for ${doctor.opd} are booked for this day.`);
  }

  // Reuse the patient record when the same name and number were seen before.
  const existing = state.patients.find(
    (p) => p.phone === contact.phone && p.name.toLowerCase() === contact.name.toLowerCase(),
  );

  if (existing) {
    const duplicate = state.tokens.find(
      (t) =>
        t.patientId === existing.id &&
        t.doctorId === doctor.id &&
        t.date === input.date &&
        ACTIVE_STATUSES.includes(t.status),
    );
    if (duplicate) {
      return fail(state, 'duplicate', `A token already exists for this patient: #${duplicate.number}.`, {
        existingTokenId: duplicate.id,
      });
    }
  }

  let next = state;
  let patientId: string;
  if (existing) {
    patientId = existing.id;
  } else {
    const idResult = nextId(next, 'pat');
    next = idResult.state;
    patientId = idResult.id;
    next = {
      ...next,
      patients: [...next.patients, { id: patientId, name: contact.name, phone: contact.phone, sample: false }],
    };
  }

  const tokenIdResult = nextId(next, 'tok');
  next = tokenIdResult.state;

  const dayTokens = tokensFor(next, doctor.id, input.date);
  const number = dayTokens.reduce((max, t) => Math.max(max, t.number), 0) + 1;
  const orderKey = dayTokens.reduce((max, t) => Math.max(max, t.orderKey), 0) + 1;
  const nowIso = now.toISOString();

  const token: Token = {
    id: tokenIdResult.id,
    number,
    orderKey: Math.max(orderKey, number),
    doctorId: doctor.id,
    patientId,
    date: input.date,
    source: input.source,
    status: 'waiting',
    createdAt: nowIso,
    ...(input.source === 'walk_in' ? { arrivedAt: nowIso, arrivalSource: 'walk_in' as const } : {}),
  };

  next = { ...next, tokens: [...next.tokens, token] };
  return succeed(next, token);
}

// ---------------------------------------------------------------------------
// Moving tokens through the queue
// ---------------------------------------------------------------------------

function findToken(state: AppState, tokenId: string): Token | Failure {
  const token = getToken(state, tokenId);
  if (!token) return { ok: false, code: 'not_found', message: 'This token could not be found.' };
  return token;
}

function isFailure(value: Token | Failure): value is Failure {
  return 'ok' in value;
}

function badTransition(state: AppState, token: Token, wanted: string): Outcome<never> {
  return fail(state, 'invalid_transition', `Token #${token.number} cannot be ${wanted} while it is ${statusLabel(token.status).toLowerCase()}.`);
}

export function statusLabel(status: TokenStatus): string {
  switch (status) {
    case 'waiting':
      return 'Waiting';
    case 'in_progress':
      return 'In progress';
    case 'completed':
      return 'Completed';
    case 'no_show':
      return 'No-show';
    case 'skipped':
      return 'Skipped';
    case 'on_hold':
      return 'On hold';
    case 'cancelled':
      return 'Cancelled';
  }
}

export function markArrived(state: AppState, tokenId: string, now: Date): Outcome<Token> {
  const found = findToken(state, tokenId);
  if (isFailure(found)) return fail(state, found.code, found.message);
  if (found.arrivedAt) return fail(state, 'invalid_transition', `Token #${found.number} is already marked as arrived.`);
  if (found.status !== 'waiting' && found.status !== 'skipped' && found.status !== 'on_hold') {
    return badTransition(state, found, 'marked as arrived');
  }
  const next = replaceToken(state, found.id, { arrivedAt: now.toISOString(), arrivalSource: 'reception' });
  return succeed(next, getToken(next, found.id)!);
}

export function markNoShow(state: AppState, tokenId: string): Outcome<Token> {
  const found = findToken(state, tokenId);
  if (isFailure(found)) return fail(state, found.code, found.message);
  if (found.status !== 'waiting' && found.status !== 'skipped' && found.status !== 'on_hold') {
    return badTransition(state, found, 'marked as no-show');
  }
  const next = replaceToken(state, found.id, { status: 'no_show' });
  return succeed(next, getToken(next, found.id)!);
}

/** Patient cancels their own token. Only a waiting token can be cancelled. */
export function cancelToken(state: AppState, tokenId: string): Outcome<Token> {
  const found = findToken(state, tokenId);
  if (isFailure(found)) return fail(state, found.code, found.message);
  if (found.status !== 'waiting') return badTransition(state, found, 'cancelled');
  const next = replaceToken(state, found.id, { status: 'cancelled' });
  return succeed(next, getToken(next, found.id)!);
}

/** Skipped or no-show patients who come back go to the end of the waiting line. */
export function requeueToken(state: AppState, tokenId: string): Outcome<Token> {
  const found = findToken(state, tokenId);
  if (isFailure(found)) return fail(state, found.code, found.message);
  if (found.status !== 'skipped' && found.status !== 'no_show') return badTransition(state, found, 'returned to the queue');
  const maxKey = tokensFor(state, found.doctorId, found.date).reduce((m, t) => Math.max(m, t.orderKey), 0);
  const next = replaceToken(state, found.id, { status: 'waiting', orderKey: maxKey + 1 });
  return succeed(next, getToken(next, found.id)!);
}

export interface CallNextValue {
  completed?: Token;
  called?: Token;
}

/**
 * The NEXT button. Finishes the patient currently with the doctor (if any) and calls the next waiting token.
 * `expectedCurrentId` is the token the doctor was looking at. If the queue moved on since then, nothing happens.
 */
export function callNext(
  state: AppState,
  doctorId: string,
  expectedCurrentId: string | null,
  now: Date,
): Outcome<CallNextValue> {
  const doctor = getDoctor(state, doctorId);
  if (!doctor) return fail(state, 'doctor_unavailable', 'This doctor is not available.');
  const date = toDateKey(now);
  const current = currentToken(state, doctorId, date);

  if ((current?.id ?? null) !== expectedCurrentId) {
    return fail(state, 'stale', 'The queue has changed. The screen was updated, please check and try again.');
  }

  if (current?.startedAt) {
    const seconds = (now.getTime() - new Date(current.startedAt).getTime()) / 1000;
    if (seconds < CALL_COOLDOWN_SECONDS) {
      return fail(state, 'too_soon', 'This patient was only just called. Wait a moment before pressing NEXT again.');
    }
  }

  const upcoming = waitingTokens(state, doctorId, date)[0];
  if (!current && !upcoming) return fail(state, 'empty', 'No patients are waiting.');

  let next = state;
  let completed: Token | undefined;
  if (current) {
    const done = completeToken(next, current.id, now);
    if (!done.result.ok) return fail(state, done.result.code, done.result.message);
    next = done.state;
    completed = done.result.value;
  }

  if (!upcoming) return succeed(next, { completed });

  const nowIso = now.toISOString();
  const patch: Partial<Token> = { status: 'in_progress', startedAt: nowIso };
  if (!upcoming.arrivedAt) {
    patch.arrivedAt = nowIso;
    patch.arrivalSource = 'doctor_call';
  }
  next = replaceToken(next, upcoming.id, patch);
  return succeed(next, { completed, called: getToken(next, upcoming.id)! });
}

/** Marks the consultation as done and makes sure a visit record exists for it. */
export function completeToken(state: AppState, tokenId: string, now: Date): Outcome<Token> {
  const found = findToken(state, tokenId);
  if (isFailure(found)) return fail(state, found.code, found.message);
  if (found.status !== 'in_progress') return badTransition(state, found, 'completed');

  let next = replaceToken(state, found.id, { status: 'completed', completedAt: now.toISOString() });
  if (!next.visits.some((v) => v.tokenId === found.id)) {
    const idResult = nextId(next, 'vis');
    next = idResult.state;
    const visit: Visit = {
      id: idResult.id,
      patientId: found.patientId,
      doctorId: found.doctorId,
      date: found.date,
      tokenId: found.id,
      title: 'Consultation',
      notes: '',
      advice: '',
      attachments: [],
      sample: false,
      createdAt: now.toISOString(),
    };
    next = { ...next, visits: [...next.visits, visit] };
  }
  return succeed(next, getToken(next, found.id)!);
}

/** The patient with the doctor, or a waiting patient, does not respond or is not present. */
export function skipToken(state: AppState, tokenId: string): Outcome<Token> {
  const found = findToken(state, tokenId);
  if (isFailure(found)) return fail(state, found.code, found.message);
  if (found.status !== 'in_progress' && found.status !== 'waiting') return badTransition(state, found, 'skipped');
  const next = replaceToken(state, found.id, { status: 'skipped' });
  return succeed(next, getToken(next, found.id)!);
}

/** Pause the consultation of the current patient, for example while they get a test done. */
export function holdToken(state: AppState, tokenId: string): Outcome<Token> {
  const found = findToken(state, tokenId);
  if (isFailure(found)) return fail(state, found.code, found.message);
  if (found.status !== 'in_progress') return badTransition(state, found, 'put on hold');
  const next = replaceToken(state, found.id, { status: 'on_hold' });
  return succeed(next, getToken(next, found.id)!);
}

/** A held patient goes to the front of the waiting line, so the next NEXT press calls them. */
export function resumeToken(state: AppState, tokenId: string): Outcome<Token> {
  const found = findToken(state, tokenId);
  if (isFailure(found)) return fail(state, found.code, found.message);
  if (found.status !== 'on_hold') return badTransition(state, found, 'resumed');
  const minKey = tokensFor(state, found.doctorId, found.date).reduce((m, t) => Math.min(m, t.orderKey), Infinity);
  const next = replaceToken(state, found.id, { status: 'waiting', orderKey: minKey - 1 });
  return succeed(next, getToken(next, found.id)!);
}

// ---------------------------------------------------------------------------
// Patients and visits
// ---------------------------------------------------------------------------

export interface PatientSummary {
  patient: Patient;
  visitCount: number;
  lastVisitDate: DateKey | null;
}

export function visitsFor(state: AppState, patientId: string): Visit[] {
  return state.visits
    .filter((v) => v.patientId === patientId)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

/**
 * Which visit this is for the patient, counting this one. A token that has not produced a visit record yet
 * counts as one more than the visits already on file.
 */
export function visitNumber(state: AppState, token: Token): number {
  if (token.visitNumber !== undefined) return token.visitNumber;
  const others = state.visits.filter((v) => v.patientId === token.patientId && v.tokenId !== token.id).length;
  return others + 1;
}

export function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function summarizePatient(state: AppState, patient: Patient): PatientSummary {
  const visits = visitsFor(state, patient.id);
  return { patient, visitCount: visits.length, lastVisitDate: visits[0]?.date ?? null };
}

/** Matches on part of the name or on the digits of the phone number. Needs at least 2 characters. */
export function searchPatients(state: AppState, query: string): PatientSummary[] {
  const text = query.trim().toLowerCase();
  const digits = query.replace(/\D/g, '');
  if (text.length < 2 && digits.length < 2) return [];
  return state.patients
    .filter((p) => {
      const nameMatch = text.length >= 2 && p.name.toLowerCase().includes(text);
      const phoneMatch = digits.length >= 2 && p.phone.includes(digits);
      return nameMatch || phoneMatch;
    })
    .map((p) => summarizePatient(state, p))
    .sort((a, b) => a.patient.name.localeCompare(b.patient.name));
}

export interface VisitInput {
  /** When set, the existing visit is updated instead of a new one being created. */
  visitId?: string;
  patientId: string;
  doctorId: string;
  date: DateKey;
  title: string;
  notes: string;
  advice: string;
  attachments: string[];
}

export function saveVisit(state: AppState, input: VisitInput, now: Date): Outcome<Visit> {
  const patient = getPatient(state, input.patientId);
  if (!patient) return fail(state, 'not_found', 'This patient could not be found.');
  const title = input.title.trim();
  const notes = input.notes.trim();
  const advice = input.advice.trim();
  const fieldErrors: Record<string, string> = {};
  if (!title) fieldErrors.title = 'Enter a short reason for the visit.';
  if (title.length > 120) fieldErrors.title = 'Keep the reason under 120 characters.';
  if (notes.length > 2000) fieldErrors.notes = 'Keep the notes under 2000 characters.';
  if (advice.length > 2000) fieldErrors.advice = 'Keep the advice under 2000 characters.';
  if (input.date > toDateKey(now)) fieldErrors.date = 'The visit date cannot be in the future.';
  if (!notes && !advice) fieldErrors.notes = 'Add a consultation note or advice.';
  if (Object.keys(fieldErrors).length > 0) {
    return fail(state, 'invalid_input', 'Please fix the highlighted fields.', { fieldErrors });
  }

  if (input.visitId) {
    const existing = state.visits.find((v) => v.id === input.visitId);
    if (!existing || existing.patientId !== input.patientId) {
      return fail(state, 'not_found', 'This visit could not be found.');
    }
    const updated: Visit = { ...existing, title, notes, advice, attachments: input.attachments, date: input.date };
    return succeed({ ...state, visits: state.visits.map((v) => (v.id === existing.id ? updated : v)) }, updated);
  }

  const idResult = nextId(state, 'vis');
  const visit: Visit = {
    id: idResult.id,
    patientId: input.patientId,
    doctorId: input.doctorId,
    date: input.date,
    title,
    notes,
    advice,
    attachments: input.attachments,
    sample: false,
    createdAt: now.toISOString(),
  };
  return succeed({ ...idResult.state, visits: [...idResult.state.visits, visit] }, visit);
}
