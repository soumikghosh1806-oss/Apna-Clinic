// Shared data shapes for the whole app. Keep this file free of logic.

/** A calendar day written as YYYY-MM-DD in the device's local time. */
export type DateKey = string;

/** Staff roles available in demo mode. */
export type Role = 'reception' | 'doctor' | 'owner';

/** Anyone using the app. Patients are not logged in. */
export type Actor = Role | 'patient';

/** One OPD working window, for example 10:00 to 14:00. Times are HH:MM, 24 hour. */
export interface OpdSession {
  start: string;
  end: string;
}

/** An OPD session with an optional break inside it. */
export interface TimedSession extends OpdSession {
  breakStart?: string;
  breakEnd?: string;
}

export interface Doctor {
  id: string;
  name: string;
  /** Name of the OPD the doctor runs, for example "General OPD". */
  opd: string;
  sessions: OpdSession[];
  /** Overrides the clinic wide daily token limit when set. */
  dailyLimit: number | null;
  /** Overrides the clinic wide minutes per patient when set. */
  minutesPerPatient: number | null;
  /** Removed doctors are kept (inactive) so old reports stay correct. */
  active: boolean;
  /** Only known with a real backend: whether this doctor has a sign in. */
  hasLogin?: boolean;
}

export interface Patient {
  id: string;
  name: string;
  /** Ten digit Indian mobile number, digits only. */
  phone: string;
  /** True for patients that came with the demo data. */
  sample: boolean;
}

export type TokenStatus =
  | 'waiting'
  | 'in_progress'
  | 'completed'
  | 'no_show'
  | 'skipped'
  | 'on_hold'
  | 'cancelled';

export type TokenSource = 'online' | 'walk_in';

/** Who recorded the arrival. Calls made by the doctor are not counted in wait averages. */
export type ArrivalSource = 'reception' | 'walk_in' | 'doctor_call';

export interface Token {
  id: string;
  /** Token number shown to people. Unique per doctor and per date. */
  number: number;
  /** Position in the calling order. Starts equal to number, changes when a token is requeued or resumed. */
  orderKey: number;
  doctorId: string;
  patientId: string;
  date: DateKey;
  source: TokenSource;
  status: TokenStatus;
  /** ISO timestamps. */
  createdAt: string;
  arrivedAt?: string;
  arrivalSource?: ArrivalSource;
  startedAt?: string;
  completedAt?: string;
  /** Which visit this is for the patient. Set when a server counted it, otherwise worked out from the visit list. */
  visitNumber?: number;
  /** The OPD session the token belongs to. Set by the real backend. */
  session?: OpdSession;
}

export interface Medicine {
  name: string;
  dose?: string;
  frequency?: string;
  duration?: string;
  notes?: string;
}

export interface Prescription {
  id: string;
  medicines: Medicine[];
  instructions: string;
}

/** A file kept in the private report storage. Only its details are held here, never the file itself. */
export interface ReportFile {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface Visit {
  id: string;
  patientId: string;
  doctorId: string;
  date: DateKey;
  /** Set when the visit was created from a token. */
  tokenId?: string;
  title: string;
  notes: string;
  advice: string;
  /** File names only. Files are never uploaded or stored in this prototype. */
  attachments: string[];
  /** True for visits that came with the demo data. */
  sample: boolean;
  createdAt: string;
  /** The next four fields exist only with a real backend. */
  symptoms?: string;
  diagnosis?: string;
  prescription?: Prescription | null;
  reports?: ReportFile[];
}

export interface Settings {
  clinicName: string;
  onlineBookingEnabled: boolean;
  defaultDailyLimit: number;
  defaultMinutesPerPatient: number;
  /** Only with a real backend: how many online tokens one mobile number may book in a day. */
  maxOnlineBookingsPerPhone?: number;
}

export interface AppState {
  schema: 1;
  /** Day the demo data was built. The demo is rebuilt when the date changes. */
  seededOn: DateKey;
  updatedAt: string;
  idCounter: number;
  settings: Settings;
  doctors: Doctor[];
  patients: Patient[];
  tokens: Token[];
  visits: Visit[];
}

export type ErrorCode =
  | 'forbidden'
  | 'online_disabled'
  | 'full'
  | 'doctor_unavailable'
  | 'invalid_date'
  | 'invalid_input'
  | 'duplicate'
  | 'not_found'
  | 'invalid_transition'
  | 'stale'
  | 'too_soon'
  | 'empty'
  | 'rate_limited'
  | 'slug_taken'
  | 'schedule_conflict'
  | 'otp_required'
  | 'otp_expired'
  | 'otp_invalid'
  | 'delivery_failed'
  | 'not_configured'
  | 'network';

export interface Failure {
  ok: false;
  code: ErrorCode;
  message: string;
  /** Field level messages for forms. */
  fieldErrors?: Record<string, string>;
  /** Set for duplicate bookings so the screen can link to the existing token. */
  existingTokenId?: string;
  /** Set when a schedule change would leave booked patients outside the new timings. Nothing was changed. */
  conflicts?: ScheduleConflict[];
  /** Set when a one time code was wrong: how many tries are left before a new code is needed. */
  attemptsLeft?: number;
}

/** Booked patients a schedule change would affect. They are never cancelled: the owner is warned and may confirm. */
export interface ScheduleConflict {
  doctorId: string;
  doctor: string;
  date: DateKey;
  /** How many open tokens are booked for that doctor and day. */
  tokens: number;
  /** closed: the whole day becomes closed. session_changed: the session they booked no longer exists. */
  reason: 'closed' | 'session_changed';
  closedReason?: 'leave' | 'holiday' | 'weekly_off';
  session?: OpdSession;
}

export interface Success<T> {
  ok: true;
  value: T;
}

export type Result<T> = Success<T> | Failure;

/** Every domain function returns the next state plus a result. On failure the state is unchanged. */
export interface Outcome<T> {
  state: AppState;
  result: Result<T>;
}
