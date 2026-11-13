// The real backend's version of every action. Each one calls a database function, which checks the caller's role
// itself. Nothing here decides who may do what; it only sends the request and shapes the answer.

import type { Actions, SaveVisitInput, SaveVisitValue } from '../state/actions';
import type { Failure, Result, Token } from '../domain/types';
import { getSupabase } from '../lib/supabase';
import {
  mapBookedToken,
  mapDoctor,
  mapPrescription,
  mapSettings,
  mapToken,
  mapVisit,
} from './mappers';
import { callFunction, readEmailOutcome } from './functions';
import { mapConflicts, mapSchedule, timedSessionsToDto, weeklyToDto } from './scheduleMappers';
import { networkFailure, rpc, type Dto } from './rpc';

export interface RemoteActionDeps {
  /** Clinic address from the web address. Needed by patients. */
  slug: string | null;
  /** The clinic the signed in staff member is working in. */
  clinicId: string | null;
  /** Reads the staff snapshot again after a change, so every screen shows it. */
  refresh(): Promise<void>;
  /** Where the sign in link in an invitation should come back to. */
  siteUrl?: string;
}

const NO_CLINIC: Failure = { ok: false, code: 'forbidden', message: 'Open the link your clinic gave you to use this.' };
const NOT_SIGNED_IN: Failure = { ok: false, code: 'forbidden', message: 'Sign in with a staff account to do this.' };
const NO_DEMO_RESET: Failure = { ok: false, code: 'forbidden', message: 'There is no demo data to reset.' };

export const REPORT_BUCKET = 'patient-reports';
export const REPORT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
export const REPORT_MAX_BYTES = 10 * 1024 * 1024;

const TYPE_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** Files are checked here for a clear message, and again by the database and the storage bucket. */
export function reportFileType(file: { name: string; type: string }): string | null {
  const declared = file.type.toLowerCase();
  if ((REPORT_TYPES as readonly string[]).includes(declared)) return declared;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return TYPE_BY_EXTENSION[extension] ?? null;
}

/** A storage file name with no folders, spaces or unusual characters. */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-80);
  return cleaned || 'report';
}

export function reportPath(clinicId: string, patientId: string, fileName: string, uniqueId: string): string {
  return `${clinicId}/${patientId}/${uniqueId}-${safeFileName(fileName)}`;
}

export function createRemoteActions(deps: RemoteActionDeps): Actions {
  const staff = <T>(run: (clinicId: string) => Promise<Result<T>>): Promise<Result<T>> =>
    deps.clinicId ? run(deps.clinicId) : Promise.resolve(NOT_SIGNED_IN);

  /** After a failure that means the screen is out of date, load the newest data in the background. */
  const staleAfter = (result: Result<unknown>) => {
    if (!result.ok && ['stale', 'invalid_transition', 'not_found', 'duplicate', 'doctor_unavailable'].includes(result.code)) {
      void deps.refresh();
    }
  };

  async function tokenAction(fn: string, tokenId: string): Promise<Result<Token>> {
    if (!deps.clinicId) return NOT_SIGNED_IN;
    const answer = await rpc(fn, { p_token_id: tokenId });
    if (!answer.ok) {
      staleAfter(answer);
      return answer;
    }
    await deps.refresh();
    return { ok: true, value: mapToken(answer.data.token as Dto) };
  }

  return {
    async bookOnline(input) {
      if (!deps.slug) return NO_CLINIC;
      const answer = await rpc('book_token', {
        p_slug: deps.slug,
        p_name: input.name,
        p_phone: input.phone,
        p_doctor_id: input.doctorId,
        p_date: input.date,
        p_session_start: input.sessionStart ?? null,
        p_verification: input.verification ?? null,
        p_email: input.email?.trim() || null,
      });
      return answer.ok ? { ok: true, value: mapBookedToken(answer.data) } : answer;
    },

    async cancelOwnToken(key) {
      const answer = await rpc('cancel_my_token', { p_access_key: key });
      if (!answer.ok) return answer;
      const t = (answer.data.token ?? {}) as Dto;
      return {
        ok: true,
        value: { ...mapBookedToken({ access_key: key, token: t }), status: 'cancelled' },
      };
    },

    addWalkIn: (input) =>
      staff(async (clinicId) => {
        const answer = await rpc('add_walk_in', {
          p_clinic: clinicId,
          p_name: input.name,
          p_phone: input.phone,
          p_doctor_id: input.doctorId,
          p_allow_over_limit: input.allowOverLimit === true,
        });
        if (!answer.ok) {
          staleAfter(answer);
          return answer;
        }
        await deps.refresh();
        return { ok: true, value: mapToken(answer.data.token as Dto) };
      }),

    markArrived: (id) => tokenAction('mark_arrived', id),
    markNoShow: (id) => tokenAction('mark_no_show', id),
    requeue: (id) => tokenAction('requeue_token', id),
    complete: (id) => tokenAction('complete_token', id),
    skip: (id) => tokenAction('skip_token', id),
    hold: (id) => tokenAction('hold_token', id),
    resume: (id) => tokenAction('resume_token', id),

    callNext: (doctorId, expectedCurrentId) =>
      staff(async () => {
        const answer = await rpc('call_next', { p_doctor_id: doctorId, p_expected_current: expectedCurrentId });
        if (!answer.ok) {
          staleAfter(answer);
          return answer;
        }
        await deps.refresh();
        return {
          ok: true,
          value: {
            completed: answer.data.completed ? mapToken(answer.data.completed as Dto) : undefined,
            called: answer.data.called ? mapToken(answer.data.called as Dto) : undefined,
          },
        };
      }),

    saveVisit: (input) => staff((clinicId) => saveVisitWithFiles(clinicId, input)),

    saveSettings: (input) =>
      staff(async (clinicId) => {
        const answer = await rpc('update_clinic_settings', {
          p_clinic: clinicId,
          p_clinic_name: input.clinicName,
          // NaN (an empty box) becomes null, which the database rejects with a clear message for that field.
          p_online_booking_enabled: input.onlineBookingEnabled,
          p_default_daily_limit: Number.isFinite(input.defaultDailyLimit) ? input.defaultDailyLimit : null,
          p_default_minutes_per_patient: Number.isFinite(input.defaultMinutesPerPatient) ? input.defaultMinutesPerPatient : null,
          p_max_online_bookings_per_phone: input.maxOnlineBookingsPerPhone ?? null,
        });
        if (!answer.ok) return answer;
        await deps.refresh();
        const s = (answer.data.settings ?? {}) as Dto;
        return { ok: true, value: mapSettings(s, String(s.clinic_name ?? input.clinicName)) };
      }),

    addDoctor: (input) =>
      staff(async (clinicId) => {
        const answer = await rpc('add_doctor', {
          p_clinic: clinicId,
          p_name: input.name,
          p_opd: input.opd,
          p_sessions: input.sessions,
          p_daily_limit: input.dailyLimit,
          p_minutes_per_patient: input.minutesPerPatient,
        });
        if (!answer.ok) return answer;
        await deps.refresh();
        return { ok: true, value: mapDoctor(answer.data.doctor as Dto) };
      }),

    saveDoctor: (doctorId, input) =>
      staff(async (clinicId) => {
        const answer = await rpc('update_doctor', {
          p_clinic: clinicId,
          p_doctor_id: doctorId,
          p_name: input.name,
          p_opd: input.opd,
          // Editing a doctor never touches the timetable. That has its own editor, with a warning for booked patients.
          p_sessions: null,
          p_daily_limit: input.dailyLimit,
          p_minutes_per_patient: input.minutesPerPatient,
        });
        if (!answer.ok) return answer;
        await deps.refresh();
        return { ok: true, value: mapDoctor(answer.data.doctor as Dto) };
      }),

    removeDoctor: (doctorId) =>
      staff(async (clinicId) => {
        const answer = await rpc('remove_doctor', { p_clinic: clinicId, p_doctor_id: doctorId });
        if (!answer.ok) return answer;
        await deps.refresh();
        return { ok: true, value: mapDoctor(answer.data.doctor as Dto) };
      }),

    resetDemo: () => Promise.resolve(NO_DEMO_RESET),

    savePrescription: (input) =>
      staff(async (clinicId) => {
        const answer = await rpc('save_prescription', {
          p_clinic: clinicId,
          p_visit_id: input.visitId,
          p_medicines: input.medicines,
          p_instructions: input.instructions,
        });
        if (!answer.ok) return answer;
        const rx = mapPrescription(answer.data.prescription);
        return rx ? { ok: true, value: rx } : { ok: false, code: 'invalid_input', message: 'The prescription could not be saved.' };
      }),

    // The new tab must be opened while the click is still being handled, or the browser blocks it.
    async openReport(reportId) {
      const tab = window.open('', '_blank');
      if (tab) {
        tab.opener = null;
        tab.document.title = 'Opening report';
        tab.document.body.textContent = 'Opening the report...';
      }
      const close = () => tab?.close();
      const authorised = await rpc('authorize_report_download', { p_report_id: reportId });
      if (!authorised.ok) {
        close();
        return authorised;
      }
      try {
        const client = await getSupabase();
        const signed = await client.storage.from(REPORT_BUCKET).createSignedUrl(String(authorised.data.path), 60);
        if (signed.error || !signed.data?.signedUrl) {
          close();
          return { ok: false, code: 'not_found', message: 'The report file could not be opened.' };
        }
        if (!tab) {
          return {
            ok: false,
            code: 'forbidden',
            message: 'Your browser blocked the new tab. Allow pop-ups for this site and try again.',
          };
        }
        tab.location.href = signed.data.signedUrl;
        return { ok: true, value: null };
      } catch {
        close();
        return networkFailure();
      }
    },

    createStaff: (input) =>
      staff(async (clinicId) => {
        const answer = await callFunction('staff-account', {
          action: 'create',
          clinicId,
          fullName: input.fullName,
          email: input.email,
          role: input.role,
          tempPassword: input.tempPassword,
          confirmPassword: input.confirmPassword,
          doctorId: input.role === 'doctor' && input.doctorId ? input.doctorId : null,
          newDoctor: input.role === 'doctor' && !input.doctorId ? input.newDoctor ?? null : null,
        });
        if (!answer.ok) return answer;
        return { ok: true, value: { kind: answer.data.kind === 'invitation' ? 'invitation' : 'account', email: readEmailOutcome(answer.data) } };
      }),

    resendStaffEmail: (userId) =>
      staff(async (clinicId) => {
        const answer = await callFunction('staff-account', { action: 'resend', clinicId, userId });
        return answer.ok ? { ok: true, value: { email: readEmailOutcome(answer.data) } } : answer;
      }),

    resetStaffPassword: (userId, tempPassword, confirmPassword) =>
      staff(async (clinicId) => {
        const answer = await callFunction('staff-account', { action: 'reset_temp_password', clinicId, userId, tempPassword, confirmPassword });
        return answer.ok ? { ok: true, value: { email: readEmailOutcome(answer.data) } } : answer;
      }),

    revokeInvitation: (invitationId) =>
      staff(async (clinicId) => {
        const answer = await rpc('revoke_invitation', { p_clinic: clinicId, p_invitation: invitationId });
        return answer.ok ? { ok: true, value: null } : answer;
      }),

    getSchedule: (doctorId) =>
      staff(async (clinicId) => {
        const answer = await rpc('get_doctor_schedule', { p_clinic: clinicId, p_doctor_id: doctorId });
        return answer.ok ? { ok: true, value: mapSchedule(answer.data) } : answer;
      }),

    saveWeeklySchedule: (doctorId, weekly, confirm) =>
      staff(async (clinicId) => {
        const answer = await rpc('set_weekly_schedule', {
          p_clinic: clinicId,
          p_doctor_id: doctorId,
          p_weekly: weeklyToDto(weekly),
          p_confirm: confirm,
        });
        if (!answer.ok) return answer;
        await deps.refresh();
        return { ok: true, value: { kept: mapConflicts(answer.data.kept) } };
      }),

    addScheduleException: (input) =>
      staff(async (clinicId) => {
        const answer = await rpc('add_schedule_exception', {
          p_clinic: clinicId,
          p_doctor_id: input.doctorId,
          p_kind: input.kind,
          p_start: input.startDate,
          p_end: input.endDate,
          p_sessions: timedSessionsToDto(input.sessions),
          p_reason: input.reason.trim() === '' ? null : input.reason,
          p_confirm: input.confirm,
        });
        if (!answer.ok) return answer;
        await deps.refresh();
        return { ok: true, value: { id: String(answer.data.id ?? ''), kept: mapConflicts(answer.data.kept) } };
      }),

    removeScheduleException: (id, confirm) =>
      staff(async (clinicId) => {
        const answer = await rpc('remove_schedule_exception', { p_clinic: clinicId, p_exception: id, p_confirm: confirm });
        if (!answer.ok) return answer;
        await deps.refresh();
        return { ok: true, value: { kept: mapConflicts(answer.data.kept) } };
      }),

    setStaffActive: (userId, active) =>
      staff(async (clinicId) => {
        const answer = await rpc('set_staff_active', { p_clinic: clinicId, p_user_id: userId, p_active: active });
        return answer.ok ? { ok: true, value: null } : answer;
      }),
  };

  async function saveVisitWithFiles(clinicId: string, input: SaveVisitInput): Promise<Result<SaveVisitValue>> {
    const saved = await rpc('save_visit', {
      p_clinic: clinicId,
      p_patient_id: input.patientId,
      p_visit_id: input.visitId ?? null,
      p_title: input.title,
      p_notes: input.notes,
      p_advice: input.advice,
      p_date: input.date,
      p_symptoms: input.symptoms ?? null,
      p_diagnosis: input.diagnosis ?? null,
    });
    if (!saved.ok) return saved;
    const visit = mapVisit({ ...(saved.data.visit as Dto) }, input.patientId);

    const uploadErrors: string[] = [];
    for (const file of input.files ?? []) {
      const error = await uploadReport(clinicId, input.patientId, visit.id, file);
      if (error) uploadErrors.push(`${file.name}: ${error}`);
    }
    void deps.refresh();
    return { ok: true, value: uploadErrors.length > 0 ? { ...visit, uploadErrors } : visit };
  }

  /** Uploads one file to the private bucket, then records it. Returns an error message, or null when it worked. */
  async function uploadReport(clinicId: string, patientId: string, visitId: string, file: File): Promise<string | null> {
    const type = reportFileType(file);
    if (!type) return 'Only PDF, JPEG, PNG or WebP files can be uploaded.';
    if (file.size < 1 || file.size > REPORT_MAX_BYTES) return 'The file must be 10 MB or smaller.';
    try {
      const client = await getSupabase();
      const path = reportPath(clinicId, patientId, file.name, crypto.randomUUID());
      const uploaded = await client.storage.from(REPORT_BUCKET).upload(path, file, { contentType: type, upsert: false });
      if (uploaded.error) return 'The file could not be uploaded.';
      const registered = await rpc('register_report', {
        p_clinic: clinicId,
        p_patient_id: patientId,
        p_visit_id: visitId,
        p_name: file.name.slice(0, 120),
        p_path: path,
        p_content_type: type,
        p_size_bytes: file.size,
      });
      return registered.ok ? null : registered.message;
    } catch {
      return 'The file could not be uploaded.';
    }
  }
}
