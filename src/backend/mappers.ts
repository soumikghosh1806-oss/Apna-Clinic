// Turns the database's answers (snake_case JSON) into the app's own shapes.
// Pure functions with no network, so every rule here is covered by unit tests.

import type { Availability, QueueStatus, QueueView, SessionSlot, TimeEstimate } from '../domain/queue';
import type {
  AppState,
  DateKey,
  Doctor,
  Medicine,
  OpdSession,
  Patient,
  Prescription,
  ReportFile,
  Role,
  Settings,
  Token,
  TimedSession,
  TokenSource,
  TokenStatus,
  Visit,
} from '../domain/types';
import type { Dto } from './rpc';
import { mapTimedSessions } from './scheduleMappers';
import { shiftToZone } from './time';

export type DbRole = 'owner' | 'receptionist' | 'doctor';

export function mapRole(role: string): Role | null {
  switch (role) {
    case 'owner':
      return 'owner';
    case 'receptionist':
      return 'reception';
    case 'doctor':
      return 'doctor';
    default:
      return null;
  }
}

/** The database calls the patient being with the doctor "serving". The screens call it "in_progress". */
export function mapStatus(status: string): TokenStatus {
  switch (status) {
    case 'serving':
      return 'in_progress';
    case 'arrived':
      return 'waiting';
    case 'waiting':
    case 'completed':
    case 'no_show':
    case 'skipped':
    case 'on_hold':
    case 'cancelled':
      return status;
    default:
      return 'waiting';
  }
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** A date column comes as "2026-11-08". A timestamp column keeps its time, so only the day part is used. */
export function dayOf(v: unknown): DateKey {
  return str(v).slice(0, 10);
}

export function mapToken(dto: Dto): Token {
  const token: Token = {
    id: str(dto.id),
    number: num(dto.number),
    orderKey: num(dto.order_key, num(dto.number)),
    doctorId: str(dto.doctor_id),
    patientId: str(dto.patient_id),
    date: dayOf(dto.date),
    source: (dto.source === 'walk_in' ? 'walk_in' : 'online') as TokenSource,
    status: mapStatus(str(dto.status)),
    createdAt: str(dto.created_at),
  };
  const arrivedAt = optStr(dto.arrived_at);
  if (arrivedAt) token.arrivedAt = arrivedAt;
  const arrivalSource = optStr(dto.arrival_source);
  if (arrivalSource === 'reception' || arrivalSource === 'walk_in' || arrivalSource === 'doctor_call') {
    token.arrivalSource = arrivalSource;
  }
  const startedAt = optStr(dto.started_at);
  if (startedAt) token.startedAt = startedAt;
  const completedAt = optStr(dto.completed_at);
  if (completedAt) token.completedAt = completedAt;
  if (typeof dto.visit_number === 'number') token.visitNumber = dto.visit_number;
  if (optStr(dto.session_start) && optStr(dto.session_end)) token.session = { start: str(dto.session_start).slice(0, 5), end: str(dto.session_end).slice(0, 5) };
  return token;
}

export function mapSessions(v: unknown): OpdSession[] {
  if (!Array.isArray(v)) return [];
  return v.map((s) => ({ start: str((s as Dto).start), end: str((s as Dto).end) }));
}

export function mapDoctor(dto: Dto): Doctor {
  return {
    id: str(dto.id),
    name: str(dto.name),
    opd: str(dto.opd),
    sessions: mapSessions(dto.sessions),
    dailyLimit: typeof dto.daily_limit === 'number' ? dto.daily_limit : null,
    minutesPerPatient: typeof dto.minutes_per_patient === 'number' ? dto.minutes_per_patient : null,
    active: dto.active !== false,
    hasLogin: dto.has_login === true,
  };
}

export function mapSettings(dto: Dto, clinicName: string): Settings {
  return {
    clinicName,
    onlineBookingEnabled: dto.online_booking_enabled !== false,
    defaultDailyLimit: num(dto.default_daily_limit, 100),
    defaultMinutesPerPatient: num(dto.default_minutes_per_patient, 10),
    maxOnlineBookingsPerPhone: num(dto.max_online_bookings_per_phone_per_day, 4),
  };
}

export interface StaffSnapshot {
  clinicId: string;
  clinicName: string;
  slug: string;
  timezone: string;
  today: DateKey;
  role: Role;
  myDoctorId: string | null;
  state: AppState;
}

/** The staff screens read one AppState, the same shape the demo uses. Patients are rebuilt from today's tokens. */
export function mapSnapshot(dto: Dto): StaffSnapshot {
  const clinic = (dto.clinic ?? {}) as Dto;
  const clinicName = str(clinic.name);
  const patients = new Map<string, Patient>();
  const tokens: Token[] = [];
  for (const raw of Array.isArray(dto.tokens) ? (dto.tokens as Dto[]) : []) {
    const token = mapToken(raw);
    tokens.push(token);
    if (token.patientId && !patients.has(token.patientId)) {
      patients.set(token.patientId, {
        id: token.patientId,
        name: str(raw.patient_name),
        phone: str(raw.patient_phone),
        sample: false,
      });
    }
  }
  const state: AppState = {
    schema: 1,
    seededOn: dayOf(dto.today),
    updatedAt: str(dto.now),
    idCounter: 0,
    settings: mapSettings((dto.settings ?? {}) as Dto, clinicName),
    doctors: (Array.isArray(dto.doctors) ? (dto.doctors as Dto[]) : []).map(mapDoctor),
    patients: [...patients.values()],
    tokens,
    visits: [],
  };
  return {
    clinicId: str(clinic.id),
    clinicName,
    slug: str(clinic.slug),
    timezone: str(clinic.timezone, 'Asia/Kolkata'),
    today: dayOf(dto.today),
    role: mapRole(str(dto.role)) ?? 'reception',
    myDoctorId: optStr(dto.my_doctor_id) ?? null,
    state,
  };
}

export function emptyState(clinicName: string): AppState {
  return {
    schema: 1,
    seededOn: '',
    updatedAt: '',
    idCounter: 0,
    settings: { clinicName, onlineBookingEnabled: true, defaultDailyLimit: 100, defaultMinutesPerPatient: 10 },
    doctors: [],
    patients: [],
    tokens: [],
    visits: [],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Patient screens
// ---------------------------------------------------------------------------------------------------------------

export function mapQueueStatus(dto: Dto | null | undefined): QueueStatus {
  const code = str(dto?.code);
  const known = ['scheduled', 'not_started', 'running', 'between', 'finished', 'closed'] as const;
  return {
    code: (known as readonly string[]).includes(code) ? (code as QueueStatus['code']) : 'not_started',
    label: str(dto?.label, 'Not started yet'),
  };
}

export function mapEstimate(dto: Dto | null | undefined, timeZone: string): TimeEstimate | null {
  if (!dto || typeof dto.at !== 'string') return null;
  const at = new Date(dto.at);
  if (Number.isNaN(at.getTime())) return null;
  return { at: shiftToZone(at, timeZone), outsideHours: dto.outside_hours === true };
}

export interface PublicDoctor {
  id: string;
  name: string;
  opd: string;
  /** What the clinic typed for the doctor's speciality. Absent when it did not. */
  specialization?: string;
}

function mapSessionSlots(v: unknown): SessionSlot[] {
  if (!Array.isArray(v)) return [];
  return v.map((raw) => {
    const s = raw as Dto;
    return { start: str(s.start).slice(0, 5), end: str(s.end).slice(0, 5), open: s.open !== false, issued: num(s.issued) };
  });
}

export function mapAvailability(dto: Dto | null | undefined): Availability {
  const reason = str(dto?.reason);
  const a: Availability = {
    open: dto?.open === true,
    issued: num(dto?.issued),
    limit: num(dto?.limit),
  };
  if (reason === 'online_disabled' || reason === 'full' || reason === 'doctor_unavailable' || reason === 'closed' || reason === 'ended') {
    a.reason = reason;
  }
  const closed = str(dto?.closed_reason);
  if (closed === 'leave' || closed === 'holiday' || closed === 'weekly_off') a.closedReason = closed;
  if (Array.isArray(dto?.sessions)) a.sessions = mapSessionSlots(dto?.sessions);
  return a;
}

export interface BookingDoctor extends PublicDoctor {
  sessions: OpdSession[];
  today: Availability;
  tomorrow: Availability;
}

export interface PublicClinicData {
  clinicName: string;
  slug: string;
  timezone: string;
  today: DateKey;
  tomorrow: DateKey;
  now: Date;
  onlineBookingEnabled: boolean;
  doctors: BookingDoctor[];
}

export function mapPublicClinic(dto: Dto): PublicClinicData {
  const clinic = (dto.clinic ?? {}) as Dto;
  const timezone = str(clinic.timezone, 'Asia/Kolkata');
  return {
    clinicName: str(clinic.name),
    slug: str(clinic.slug),
    timezone,
    today: dayOf(dto.today),
    tomorrow: dayOf(dto.tomorrow),
    now: shiftToZone(new Date(str(dto.now)), timezone),
    onlineBookingEnabled: dto.online_booking_enabled !== false,
    doctors: (Array.isArray(dto.doctors) ? (dto.doctors as Dto[]) : []).map((d) => ({
      id: str(d.id),
      name: str(d.name),
      opd: str(d.opd),
      sessions: mapSessions(d.sessions),
      today: mapAvailability(((d.availability ?? {}) as Dto).today),
      tomorrow: mapAvailability(((d.availability ?? {}) as Dto).tomorrow),
    })),
  };
}

export interface BoardData {
  clinicName: string;
  timezone: string;
  today: DateKey;
  date: DateKey;
  now: Date;
  doctors: PublicDoctor[];
  doctor: PublicDoctor | null;
  status: QueueStatus;
  currentNumber: number | null;
  upcoming: number[];
  /** Today's OPD timings for this doctor and whether the doctor is on a break or with a patient right now. */
  sessions?: TimedSession[];
  onBreak?: boolean;
  consulting?: boolean;
  waitingCount?: number;
  /** What a new booking can expect. An estimate. Present only on the real backend. */
  estimate?: QueueEstimate;
}

export interface QueueEstimate {
  minutesPerPatient: number;
  /** About how long a patient who books now would wait: everyone waiting plus the one being seen, at the usual minutes each. */
  waitForNewBookingMinutes: number;
  /** False when the doctor is off, the clinic is closed, or today's OPD is over: no new patient will be seen today. */
  queueOpen: boolean;
}

function mapBoardParts(board: Dto | null | undefined) {
  const upcoming = Array.isArray(board?.upcoming) ? (board!.upcoming as unknown[]).filter((n): n is number => typeof n === 'number') : [];
  return {
    status: mapQueueStatus(board?.status as Dto | undefined),
    currentNumber: typeof board?.current_number === 'number' ? (board.current_number as number) : null,
    upcoming,
    sessions: mapTimedSessions(board?.sessions),
    onBreak: board?.on_break === true,
    consulting: board?.consulting === true,
    waitingCount: typeof board?.waiting_count === 'number' ? (board.waiting_count as number) : undefined,
  };
}

export function mapPublicQueue(dto: Dto): BoardData {
  const clinic = (dto.clinic ?? {}) as Dto;
  const timezone = str(clinic.timezone, 'Asia/Kolkata');
  const pickDoctor = (d: Dto): PublicDoctor => ({
    id: str(d.id), name: str(d.name), opd: str(d.opd), ...(str(d.specialization) ? { specialization: str(d.specialization) } : {}),
  });
  const e = dto.estimate as Dto | null | undefined;
  return {
    clinicName: str(clinic.name),
    timezone,
    today: dayOf(dto.today),
    date: dayOf(dto.date),
    now: shiftToZone(new Date(str(dto.now)), timezone),
    doctors: (Array.isArray(dto.doctors) ? (dto.doctors as Dto[]) : []).map(pickDoctor),
    doctor: dto.doctor ? pickDoctor(dto.doctor as Dto) : null,
    ...mapBoardParts(dto.board as Dto | undefined),
    ...(e && typeof e === 'object'
      ? { estimate: { minutesPerPatient: num(e.minutes_per_patient), waitForNewBookingMinutes: num(e.wait_for_new_booking_minutes), queueOpen: e.queue_open !== false } }
      : {}),
  };
}

export interface MyTokenData {
  clinicName: string;
  slug: string;
  timezone: string;
  today: DateKey;
  now: Date;
  /** The token as the patient sees it. Its id is the secret link key. */
  token: Token;
  firstName: string;
  doctor: PublicDoctor;
  view: QueueView;
  status: QueueStatus;
  currentNumber: number | null;
  upcoming: number[];
  sessions?: TimedSession[];
  onBreak?: boolean;
  consulting?: boolean;
}

export function mapMyToken(dto: Dto, key: string): MyTokenData {
  const clinic = (dto.clinic ?? {}) as Dto;
  const timezone = str(clinic.timezone, 'Asia/Kolkata');
  const t = (dto.token ?? {}) as Dto;
  const d = (dto.doctor ?? {}) as Dto;
  const v = (dto.view ?? {}) as Dto;
  const doctor: PublicDoctor = { id: str(d.id), name: str(d.name), opd: str(d.opd) };
  const token: Token = {
    id: key,
    number: num(t.number),
    orderKey: num(t.number),
    doctorId: doctor.id,
    patientId: '',
    date: dayOf(t.date),
    source: t.source === 'walk_in' ? 'walk_in' : 'online',
    status: mapStatus(str(t.status)),
    createdAt: '',
  };
  const arrivedAt = optStr(t.arrived_at);
  if (arrivedAt) token.arrivedAt = arrivedAt;
  if (optStr(t.session_start) && optStr(t.session_end)) token.session = { start: str(t.session_start).slice(0, 5), end: str(t.session_end).slice(0, 5) };

  const minutesPerPatient = num(v.minutes_per_patient, 10);
  const view: QueueView = {
    token,
    doctor: {
      id: doctor.id,
      name: doctor.name,
      opd: doctor.opd,
      sessions: [],
      dailyLimit: null,
      minutesPerPatient,
      active: true,
    },
    patientsAhead: typeof v.patients_ahead === 'number' ? v.patients_ahead : null,
    estimatedWaitMinutes: typeof v.estimated_wait_minutes === 'number' ? v.estimated_wait_minutes : null,
    estimatedTime: mapEstimate(v.estimated_time as Dto | undefined, timezone),
    progress: num(v.progress, 0),
    minutesPerPatient,
  };
  return {
    clinicName: str(clinic.name),
    slug: str(clinic.slug),
    timezone,
    today: dayOf(dto.today),
    now: shiftToZone(new Date(str(dto.now)), timezone),
    token,
    firstName: str(dto.first_name),
    doctor,
    view,
    ...mapBoardParts(dto.board as Dto | undefined),
  };
}

/** One of a patient's own tokens as shown after they proved their phone number. No name, no phone, no key. */
export interface MyPlace {
  number: number;
  status: TokenStatus;
  session?: { start: string; end: string };
  patientsAhead: number | null;
  estimatedWaitMinutes: number | null;
  estimatedTime: TimeEstimate | null;
  minutesPerPatient: number;
}

export interface MyPositionData {
  today: DateKey;
  now: Date;
  places: MyPlace[];
}

export function mapMyPosition(dto: Dto): MyPositionData {
  const timezone = str(dto.timezone, 'Asia/Kolkata');
  const places = (Array.isArray(dto.tokens) ? (dto.tokens as Dto[]) : []).map((t): MyPlace => {
    const v = (t.view ?? {}) as Dto;
    const place: MyPlace = {
      number: num(t.number),
      status: mapStatus(str(t.status)),
      patientsAhead: typeof v.patients_ahead === 'number' ? v.patients_ahead : null,
      estimatedWaitMinutes: typeof v.estimated_wait_minutes === 'number' ? v.estimated_wait_minutes : null,
      estimatedTime: mapEstimate(v.estimated_time as Dto | undefined, timezone),
      minutesPerPatient: num(v.minutes_per_patient, 10),
    };
    if (optStr(t.session_start) && optStr(t.session_end)) place.session = { start: str(t.session_start).slice(0, 5), end: str(t.session_end).slice(0, 5) };
    return place;
  });
  return { today: dayOf(dto.today), now: shiftToZone(new Date(str(dto.now)), timezone), places };
}

/** What book_token answers: no internal ids, only the number and the secret key for the patient's link. */
export function mapBookedToken(dto: Dto): Token {
  const t = (dto.token ?? {}) as Dto;
  return {
    id: str(dto.access_key),
    number: num(t.number),
    orderKey: num(t.order_key, num(t.number)),
    doctorId: str(t.doctor_id),
    patientId: '',
    date: dayOf(t.date),
    source: t.source === 'walk_in' ? 'walk_in' : 'online',
    status: mapStatus(str(t.status, 'waiting')),
    createdAt: str(t.created_at),
    ...(optStr(t.session_start) && optStr(t.session_end)
      ? { session: { start: str(t.session_start).slice(0, 5), end: str(t.session_end).slice(0, 5) } }
      : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Patients, visits, reports
// ---------------------------------------------------------------------------------------------------------------

export interface PatientHit {
  patient: Patient;
  visitCount: number;
  lastVisitDate: DateKey | null;
}

export function mapPatientHits(dto: Dto): PatientHit[] {
  return (Array.isArray(dto.patients) ? (dto.patients as Dto[]) : []).map((p) => ({
    patient: { id: str(p.id), name: str(p.name), phone: str(p.phone), sample: false },
    visitCount: num(p.visit_count),
    lastVisitDate: optStr(p.last_visit_date) ? dayOf(p.last_visit_date) : null,
  }));
}

export interface VisitListItem {
  id: string;
  date: DateKey;
  title: string;
  doctorLabel: string;
}

export function mapVisitList(dto: Dto): { patient: Patient; visits: VisitListItem[] } {
  const p = (dto.patient ?? {}) as Dto;
  return {
    patient: { id: str(p.id), name: str(p.name), phone: str(p.phone), sample: false },
    visits: (Array.isArray(dto.visits) ? (dto.visits as Dto[]) : []).map((v) => ({
      id: str(v.id),
      date: dayOf(v.date),
      title: str(v.title, 'Consultation'),
      doctorLabel: str(v.doctor_name),
    })),
  };
}

export function mapReportFile(dto: Dto): ReportFile {
  return {
    id: str(dto.id),
    name: str(dto.name),
    contentType: str(dto.content_type),
    sizeBytes: num(dto.size_bytes),
    uploadedAt: str(dto.uploaded_at),
  };
}

export function mapMedicines(v: unknown): Medicine[] {
  if (!Array.isArray(v)) return [];
  return v.map((m) => {
    const d = m as Dto;
    const medicine: Medicine = { name: str(d.name) };
    for (const key of ['dose', 'frequency', 'duration', 'notes'] as const) {
      const value = optStr(d[key]);
      if (value) medicine[key] = value;
    }
    return medicine;
  });
}

export function mapPrescription(v: unknown): Prescription | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Dto;
  return { id: str(d.id), medicines: mapMedicines(d.medicines), instructions: str(d.instructions) };
}

export function mapVisit(dto: Dto, patientId: string): Visit {
  return {
    id: str(dto.id),
    patientId,
    doctorId: str(dto.doctor_id),
    date: dayOf(dto.date),
    tokenId: optStr(dto.token_id),
    title: str(dto.title, 'Consultation'),
    notes: str(dto.notes),
    advice: str(dto.advice),
    attachments: [],
    sample: false,
    createdAt: str(dto.created_at),
    symptoms: str(dto.symptoms),
    diagnosis: str(dto.diagnosis),
    prescription: mapPrescription(dto.prescription),
    reports: (Array.isArray(dto.reports) ? (dto.reports as Dto[]) : []).map(mapReportFile),
  };
}

export interface HistoryData {
  patient: Patient;
  visits: Visit[];
  otherReports: ReportFile[];
}

export function mapHistory(dto: Dto): HistoryData {
  const p = (dto.patient ?? {}) as Dto;
  const patient: Patient = { id: str(p.id), name: str(p.name), phone: str(p.phone), sample: false };
  return {
    patient,
    visits: (Array.isArray(dto.visits) ? (dto.visits as Dto[]) : []).map((v) => mapVisit(v, patient.id)),
    otherReports: (Array.isArray(dto.other_reports) ? (dto.other_reports as Dto[]) : []).map(mapReportFile),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------------------------------

export interface DayStatsRow {
  date: DateKey;
  total: number;
  completed: number;
  noShow: number;
  cancelled: number;
  averageWaitMinutes: number | null;
  waitSamples: number;
}

export function mapReportSeries(dto: Dto): DayStatsRow[] {
  return (Array.isArray(dto.days) ? (dto.days as Dto[]) : []).map((d) => ({
    date: dayOf(d.date),
    total: num(d.total),
    completed: num(d.completed),
    noShow: num(d.no_show),
    cancelled: num(d.cancelled),
    averageWaitMinutes: typeof d.average_wait_minutes === 'number' ? d.average_wait_minutes : null,
    waitSamples: num(d.wait_samples),
  }));
}

export interface MonthRow {
  date: DateKey;
  opd: string;
  total: number;
  completed: number;
  noShow: number;
  cancelled: number;
  averageWaitMinutes: number | null;
}

export function mapReportMonth(dto: Dto): MonthRow[] {
  return (Array.isArray(dto.rows) ? (dto.rows as Dto[]) : []).map((r) => ({
    date: dayOf(r.date),
    opd: str(r.opd),
    total: num(r.total),
    completed: num(r.completed),
    noShow: num(r.no_show),
    cancelled: num(r.cancelled),
    averageWaitMinutes: typeof r.average_wait_minutes === 'number' ? r.average_wait_minutes : null,
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Staff list (owner)
// ---------------------------------------------------------------------------------------------------------------

export interface StaffMember {
  userId: string;
  role: Role;
  isActive: boolean;
  fullName: string;
  email: string;
  doctorName: string | null;
  /** Created with a temporary password and has not chosen their own yet. */
  firstLoginPending: boolean;
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: Role;
}

export interface StaffList {
  staff: StaffMember[];
  doctorsWithoutLogin: PublicDoctor[];
  pendingInvitations: PendingInvitation[];
}

export function mapStaffList(dto: Dto): StaffList {
  return {
    staff: (Array.isArray(dto.staff) ? (dto.staff as Dto[]) : []).flatMap((s) => {
      const role = mapRole(str(s.role));
      if (!role) return [];
      return [
        {
          userId: str(s.user_id),
          role,
          isActive: s.is_active !== false,
          fullName: str(s.full_name),
          email: str(s.email),
          doctorName: optStr(s.doctor_name) ?? null,
          firstLoginPending: s.first_login_pending === true,
        },
      ];
    }),
    pendingInvitations: (Array.isArray(dto.pending_invitations) ? (dto.pending_invitations as Dto[]) : []).flatMap((i) => {
      const role = mapRole(str(i.role));
      return role ? [{ id: str(i.id), email: str(i.email), role }] : [];
    }),
    doctorsWithoutLogin: (Array.isArray(dto.doctors_without_login) ? (dto.doctors_without_login as Dto[]) : []).map((d) => ({
      id: str(d.id),
      name: str(d.name),
      opd: str(d.opd),
    })),
  };
}

export interface Membership {
  clinicId: string;
  name: string;
  slug: string;
  timezone: string;
  role: Role;
  doctorId: string | null;
}

export interface AccountInfo {
  fullName: string;
  email: string;
  memberships: Membership[];
  /** The account has a temporary password and must choose its own before doing anything else. */
  mustChangePassword: boolean;
  pendingInvitations: number;
}

export interface Invitation {
  id: string;
  clinicName: string;
  role: Role;
  invitedBy: string;
  doctorName: string | null;
  expiresAt: string;
}

export function mapInvitations(dto: Dto): Invitation[] {
  return (Array.isArray(dto.invitations) ? (dto.invitations as Dto[]) : []).flatMap((i) => {
    const role = mapRole(str(i.role));
    return role
      ? [{ id: str(i.id), clinicName: str(i.clinic_name), role, invitedBy: str(i.invited_by), doctorName: optStr(i.doctor_name) ?? null, expiresAt: str(i.expires_at) }]
      : [];
  });
}

export function mapMemberships(dto: Dto): AccountInfo {
  const profile = (dto.profile ?? {}) as Dto;
  return {
    fullName: str(profile.full_name),
    email: str(profile.email),
    mustChangePassword: dto.must_change_password === true,
    pendingInvitations: typeof dto.pending_invitations === 'number' ? dto.pending_invitations : 0,
    memberships: (Array.isArray(dto.clinics) ? (dto.clinics as Dto[]) : []).flatMap((c) => {
      const role = mapRole(str(c.role));
      if (!role) return [];
      return [
        {
          clinicId: str(c.id),
          name: str(c.name),
          slug: str(c.slug),
          timezone: str(c.timezone, 'Asia/Kolkata'),
          role,
          doctorId: optStr(c.doctor_id) ?? null,
        },
      ];
    }),
  };
}
