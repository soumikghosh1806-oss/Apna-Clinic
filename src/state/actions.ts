// The only way screens change data. Every action is async, because with a real backend each one is a network call.
// Demo mode (below) checks the demo role in the browser and runs a domain rule. The real backend (src/backend)
// sends the same calls to database functions, which do their own role checks.

import { toDateKey } from '../domain/dates';
import { can, type Action } from '../domain/permissions';
import {
  callNext,
  cancelToken,
  completeToken,
  createToken,
  getToken,
  holdToken,
  markArrived,
  markNoShow,
  requeueToken,
  resumeToken,
  saveVisit,
  skipToken,
  type CallNextValue,
  type VisitInput,
} from '../domain/queue';
import {
  addDoctor,
  removeDoctor,
  updateDoctor,
  updateSettings,
  type DoctorInput,
  type SettingsInput,
} from '../domain/settings';
import type {
  Actor,
  DateKey,
  Doctor,
  Failure,
  Medicine,
  Prescription,
  Result,
  Settings,
  Token,
  Visit,
} from '../domain/types';
import type { DoctorSchedule, ExceptionKind, WeeklySchedule } from '../domain/schedule';
import type { ScheduleConflict, TimedSession } from '../domain/types';
import type { Store } from './store';

export interface SaveVisitInput extends VisitInput {
  /** Real backend only. */
  symptoms?: string;
  diagnosis?: string;
  /** Real backend only: files to upload to private storage after the visit is saved. */
  files?: File[];
}

export type SaveVisitValue = Visit & { uploadErrors?: string[] };

export interface PrescriptionInput {
  visitId: string;
  medicines: Medicine[];
  instructions: string;
}

export interface NewDoctorInput {
  specialization: string;
  qualification: string;
  phone: string;
  consultationFee: string;
  opd: string;
}

export interface CreateStaffInput {
  fullName: string;
  email: string;
  role: 'receptionist' | 'doctor';
  tempPassword: string;
  confirmPassword: string;
  /** A doctor who already exists in the clinic and has no login yet. */
  doctorId?: string;
  /** Professional details for a doctor who is new to the clinic. */
  newDoctor?: NewDoctorInput;
}

export interface EmailOutcome {
  status: 'sent' | 'failed' | 'not_configured';
  message?: string;
}

/** kind "account": a new login was created. kind "invitation": the email already had an account, so an invitation was sent. */
export interface StaffCreated {
  kind: 'account' | 'invitation';
  email: EmailOutcome;
}

export interface ScheduleExceptionInput {
  /** Null means every doctor of the clinic (a clinic holiday). */
  doctorId: string | null;
  kind: ExceptionKind;
  startDate: DateKey;
  /** Only leave covers a range of days. */
  endDate: DateKey;
  sessions: TimedSession[];
  reason: string;
  /** Confirms a change that would affect booked patients. They stay booked either way. */
  confirm: boolean;
}

export interface ScheduleSaved {
  /** Booked patients the change affected. They were not cancelled. */
  kept: ScheduleConflict[];
}

/** Everything a screen can ask the app to do. Both the demo and the real backend provide it. */
export interface BookOnlineInput {
  name: string;
  phone: string;
  doctorId: string;
  date: DateKey;
  sessionStart?: string;
  verification?: string;
  email?: string;
}

export interface Actions {
  /**
   * sessionStart (HH:MM) picks one of the doctor's sessions. verification (from a checked one time code) and email
   * (for the confirmation mail) are for the real backend. The demo ignores all three.
   */
  bookOnline(input: BookOnlineInput): Promise<Result<Token>>;
  addWalkIn(input: { name: string; phone: string; doctorId: string; allowOverLimit?: boolean }): Promise<Result<Token>>;
  cancelOwnToken(tokenId: string): Promise<Result<Token>>;
  markArrived(tokenId: string): Promise<Result<Token>>;
  markNoShow(tokenId: string): Promise<Result<Token>>;
  requeue(tokenId: string): Promise<Result<Token>>;
  callNext(doctorId: string, expectedCurrentId: string | null): Promise<Result<CallNextValue>>;
  complete(tokenId: string): Promise<Result<Token>>;
  skip(tokenId: string): Promise<Result<Token>>;
  hold(tokenId: string): Promise<Result<Token>>;
  resume(tokenId: string): Promise<Result<Token>>;
  saveVisit(input: SaveVisitInput): Promise<Result<SaveVisitValue>>;
  saveSettings(input: SettingsInput): Promise<Result<Settings>>;
  saveDoctor(doctorId: string, input: DoctorInput): Promise<Result<Doctor>>;
  addDoctor(input: DoctorInput): Promise<Result<Doctor>>;
  removeDoctor(doctorId: string): Promise<Result<Doctor>>;
  resetDemo(): Promise<Result<null>>;
  // The rest exist only with a real backend. In demo mode they answer "not available".
  savePrescription(input: PrescriptionInput): Promise<Result<Prescription>>;
  openReport(reportId: string): Promise<Result<null>>;
  createStaff(input: CreateStaffInput): Promise<Result<StaffCreated>>;
  resendStaffEmail(userId: string): Promise<Result<{ email: EmailOutcome }>>;
  resetStaffPassword(userId: string, tempPassword: string, confirmPassword: string): Promise<Result<{ email: EmailOutcome }>>;
  revokeInvitation(invitationId: string): Promise<Result<null>>;
  setStaffActive(userId: string, active: boolean): Promise<Result<null>>;
  // Doctor timetables (real backend only).
  getSchedule(doctorId: string): Promise<Result<DoctorSchedule>>;
  saveWeeklySchedule(doctorId: string, weekly: WeeklySchedule, confirm: boolean): Promise<Result<ScheduleSaved>>;
  addScheduleException(input: ScheduleExceptionInput): Promise<Result<ScheduleSaved & { id: string }>>;
  removeScheduleException(id: string, confirm: boolean): Promise<Result<ScheduleSaved>>;
}

export interface ActionContext {
  actor: Actor;
  /** For doctors: the queue they belong to. */
  doctorId?: string;
}

function forbidden(message = 'Your demo role is not allowed to do this.'): Failure {
  return { ok: false, code: 'forbidden', message };
}

function createSyncActions(store: Store, ctx: ActionContext, now: () => Date = () => new Date()) {
  const guard = <T>(action: Action, run: () => Result<T>): Result<T> => (can(ctx.actor, action) ? run() : forbidden());

  /** Doctors may only act on their own queue. */
  const ownsDoctor = (doctorId: string) => ctx.actor !== 'doctor' || ctx.doctorId === doctorId;

  const tokenAction = <T>(action: Action, tokenId: string, run: () => Result<T>): Result<T> => {
    if (!can(ctx.actor, action)) return forbidden();
    const token = getToken(store.getState(), tokenId);
    if (token && !ownsDoctor(token.doctorId)) return forbidden('This token belongs to another doctor.');
    return run();
  };

  return {
    bookOnline(input: BookOnlineInput): Result<Token> {
      const { sessionStart: _session, verification: _verification, email: _email, ...rest } = input;
      void _session;
      void _verification;
      void _email;
      return guard('booking.create', () =>
        store.run((s) => createToken(s, { ...rest, source: 'online' }, now())),
      );
    },
    addWalkIn(input: { name: string; phone: string; doctorId: string; allowOverLimit?: boolean }): Result<Token> {
      return guard('walkin.create', () =>
        store.run((s) => createToken(s, { ...input, date: toDateKey(now()), source: 'walk_in' }, now())),
      );
    },
    cancelOwnToken(tokenId: string): Result<Token> {
      return guard('booking.cancel', () => store.run((s) => cancelToken(s, tokenId)));
    },
    markArrived(tokenId: string): Result<Token> {
      return guard('arrival.mark', () => store.run((s) => markArrived(s, tokenId, now())));
    },
    markNoShow(tokenId: string): Result<Token> {
      return guard('noshow.mark', () => store.run((s) => markNoShow(s, tokenId)));
    },
    requeue(tokenId: string): Result<Token> {
      return tokenAction('queue.requeue', tokenId, () => store.run((s) => requeueToken(s, tokenId)));
    },
    callNext(doctorId: string, expectedCurrentId: string | null): Result<CallNextValue> {
      if (!can(ctx.actor, 'queue.callNext')) return forbidden();
      if (!ownsDoctor(doctorId)) return forbidden('This queue belongs to another doctor.');
      return store.run((s) => callNext(s, doctorId, expectedCurrentId, now()));
    },
    complete(tokenId: string): Result<Token> {
      return tokenAction('queue.complete', tokenId, () => store.run((s) => completeToken(s, tokenId, now())));
    },
    skip(tokenId: string): Result<Token> {
      return tokenAction('queue.skip', tokenId, () => store.run((s) => skipToken(s, tokenId)));
    },
    hold(tokenId: string): Result<Token> {
      return tokenAction('queue.hold', tokenId, () => store.run((s) => holdToken(s, tokenId)));
    },
    resume(tokenId: string): Result<Token> {
      return tokenAction('queue.resume', tokenId, () => store.run((s) => resumeToken(s, tokenId)));
    },
    saveVisit(input: VisitInput): Result<Visit> {
      if (!can(ctx.actor, 'visit.write')) return forbidden();
      if (!ownsDoctor(input.doctorId)) return forbidden('This record belongs to another doctor.');
      return store.run((s) => saveVisit(s, input, now()));
    },
    saveSettings(input: SettingsInput): Result<Settings> {
      return guard('settings.write', () => store.run((s) => updateSettings(s, input)));
    },
    saveDoctor(doctorId: string, input: DoctorInput): Result<Doctor> {
      return guard('settings.write', () => store.run((s) => updateDoctor(s, doctorId, input)));
    },
    addDoctor(input: DoctorInput): Result<Doctor> {
      return guard('settings.write', () => store.run((s) => addDoctor(s, input)));
    },
    removeDoctor(doctorId: string): Result<Doctor> {
      return guard('settings.write', () => store.run((s) => removeDoctor(s, doctorId, now())));
    },
    resetDemo(): Result<null> {
      return guard('demo.reset', () => {
        store.reset();
        return { ok: true, value: null };
      });
    },
  };
}

const NOT_IN_DEMO: Failure = {
  ok: false,
  code: 'forbidden',
  message: 'This feature needs the real backend. It is not part of the demo.',
};

/** The demo actions, with the same async shape as the real backend. */
export function createActions(store: Store, ctx: ActionContext, now: () => Date = () => new Date()): Actions {
  const sync = createSyncActions(store, ctx, now);
  const later =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A) =>
      Promise.resolve(fn(...args));
  return {
    bookOnline: later(sync.bookOnline),
    addWalkIn: later(sync.addWalkIn),
    cancelOwnToken: later(sync.cancelOwnToken),
    markArrived: later(sync.markArrived),
    markNoShow: later(sync.markNoShow),
    requeue: later(sync.requeue),
    callNext: later(sync.callNext),
    complete: later(sync.complete),
    skip: later(sync.skip),
    hold: later(sync.hold),
    resume: later(sync.resume),
    saveVisit: later(sync.saveVisit),
    saveSettings: later(sync.saveSettings),
    saveDoctor: later(sync.saveDoctor),
    addDoctor: later(sync.addDoctor),
    removeDoctor: later(sync.removeDoctor),
    resetDemo: later(sync.resetDemo),
    savePrescription: () => Promise.resolve(NOT_IN_DEMO),
    openReport: () => Promise.resolve(NOT_IN_DEMO),
    createStaff: () => Promise.resolve(NOT_IN_DEMO),
    resendStaffEmail: () => Promise.resolve(NOT_IN_DEMO),
    resetStaffPassword: () => Promise.resolve(NOT_IN_DEMO),
    revokeInvitation: () => Promise.resolve(NOT_IN_DEMO),
    setStaffActive: () => Promise.resolve(NOT_IN_DEMO),
    getSchedule: () => Promise.resolve(NOT_IN_DEMO),
    saveWeeklySchedule: () => Promise.resolve(NOT_IN_DEMO),
    addScheduleException: () => Promise.resolve(NOT_IN_DEMO),
    removeScheduleException: () => Promise.resolve(NOT_IN_DEMO),
  };
}
