// What the patient screens and the waiting room display read. There are two sources behind the same hooks:
// the demo's sample data, or a real clinic over the network. Which one is used is fixed when the page loads.

import { useContext, useMemo } from 'react';
import { IS_SUPABASE } from '../backend/mode';
import { useClinicSlug } from '../backend/clinicRoute';
import {
  mapMyToken,
  mapPublicQueue,
  type BoardData,
  type BookingDoctor,
  type MyTokenData,
  type PublicDoctor,
  type QueueEstimate,
} from '../backend/mappers';
import { PublicClinicContext } from '../backend/publicClinic';
import { rpc } from '../backend/rpc';
import { useRemote } from '../backend/useRemote';
import { addDays, toDateKey } from '../domain/dates';
import {
  activeDoctors,
  bookingAvailability,
  currentToken,
  getDoctor,
  getPatient,
  getToken,
  queueStatus,
  queueView,
  upcomingTokens,
} from '../domain/queue';
import type { QueueStatus } from '../domain/queue';
import type { DateKey } from '../domain/types';
import { useLiveQueue } from './hooks';

export type Load = 'loading' | 'ready' | 'not_found' | 'error';

// ---------------------------------------------------------------------------------------------------------------
// Booking page
// ---------------------------------------------------------------------------------------------------------------

export interface BookingState {
  load: Load | 'no_clinic';
  message?: string;
  clinicName: string;
  today: DateKey;
  tomorrow: DateKey;
  doctors: BookingDoctor[];
}

function useDemoBooking(): BookingState {
  const { state, now } = useLiveQueue();
  const today = toDateKey(now);
  const tomorrow = addDays(today, 1);
  const doctors = activeDoctors(state).map((d) => ({
    id: d.id,
    name: d.name,
    opd: d.opd,
    sessions: d.sessions,
    today: bookingAvailability(state, d.id, today),
    tomorrow: bookingAvailability(state, d.id, tomorrow),
  }));
  return { load: 'ready', clinicName: state.settings.clinicName, today, tomorrow, doctors };
}

function useRemoteBooking(): BookingState {
  const ctx = useContext(PublicClinicContext);
  return useMemo<BookingState>(() => {
    const data = ctx?.data;
    return {
      load: ctx?.load ?? 'no_clinic',
      message: ctx?.message,
      clinicName: data?.clinicName ?? '',
      today: data?.today ?? '',
      tomorrow: data?.tomorrow ?? '',
      doctors: data?.doctors ?? [],
    };
  }, [ctx]);
}

export const useBooking: () => BookingState = IS_SUPABASE ? useRemoteBooking : useDemoBooking;

// ---------------------------------------------------------------------------------------------------------------
// Live queue and waiting room display (numbers only)
// ---------------------------------------------------------------------------------------------------------------

export interface BoardState {
  load: Load | 'no_clinic';
  message?: string;
  clinicName: string;
  today: DateKey;
  now: Date;
  doctors: PublicDoctor[];
  doctor: PublicDoctor | null;
  status: QueueStatus;
  currentNumber: number | null;
  /** The next few waiting token numbers, in calling order. */
  upcoming: number[];
  /** Real backend only: how many are waiting, whether the doctor is with a patient, and what a new booking can expect. */
  waitingCount?: number;
  consulting?: boolean;
  onBreak?: boolean;
  estimate?: QueueEstimate;
  updatedAt: Date;
}

const NOT_STARTED: QueueStatus = { code: 'not_started', label: 'Not started yet' };

function useDemoBoard(doctorId: string | null, _enabled = true): BoardState {
  const { state, now, updatedAt } = useLiveQueue();
  const today = toDateKey(now);
  const doctors = activeDoctors(state);
  const doctor = (doctorId ? doctors.find((d) => d.id === doctorId) : undefined) ?? doctors[0];
  return {
    load: 'ready',
    clinicName: state.settings.clinicName,
    today,
    now,
    doctors: doctors.map((d) => ({ id: d.id, name: d.name, opd: d.opd })),
    doctor: doctor ? { id: doctor.id, name: doctor.name, opd: doctor.opd } : null,
    status: doctor ? queueStatus(state, doctor.id, today, today) : NOT_STARTED,
    currentNumber: doctor ? (currentToken(state, doctor.id, today)?.number ?? null) : null,
    upcoming: doctor ? upcomingTokens(state, doctor.id, today, 3).map((t) => t.number) : [],
    updatedAt,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function useRemoteBoard(doctorId: string | null, enabled = true): BoardState {
  const slug = useClinicSlug();
  const remote = useRemote(
    async () => {
      const answer = await rpc('get_public_queue', {
        p_slug: slug ?? '',
        p_doctor_id: doctorId && UUID.test(doctorId) ? doctorId : null,
        p_date: null,
      });
      return answer.ok ? { ok: true as const, value: mapPublicQueue(answer.data) } : answer;
    },
    [slug, doctorId],
    { enabled: slug !== null && enabled, intervalMs: 10000 },
  );
  const data: BoardData | undefined = remote.data;
  let load: BoardState['load'] = 'loading';
  if (slug === null) load = 'no_clinic';
  else if (data) load = 'ready';
  else if (!enabled) load = 'ready';
  else if (remote.failure) load = remote.failure.code === 'not_found' ? 'not_found' : 'error';
  return {
    load,
    message: remote.failure?.message,
    clinicName: data?.clinicName ?? '',
    today: data?.today ?? '',
    now: data?.now ?? new Date(),
    doctors: data?.doctors ?? [],
    doctor: data?.doctor ?? null,
    status: data?.status ?? NOT_STARTED,
    currentNumber: data?.currentNumber ?? null,
    upcoming: data?.upcoming ?? [],
    waitingCount: data?.waitingCount,
    consulting: data?.consulting,
    onBreak: data?.onBreak,
    estimate: data?.estimate,
    updatedAt: remote.updatedAt ?? new Date(),
  };
}

/** `enabled` lets a page skip the load when it has another source for the same numbers. */
export const useBoard: (doctorId: string | null, enabled?: boolean) => BoardState = IS_SUPABASE ? useRemoteBoard : useDemoBoard;

// ---------------------------------------------------------------------------------------------------------------
// One patient's token
// ---------------------------------------------------------------------------------------------------------------

export interface MyTokenState {
  /** "idle" means there was no token to look up. */
  load: Load | 'idle';
  message?: string;
  data: MyTokenData | null;
  updatedAt: Date;
  refresh(): void;
}

interface MyTokenInput {
  /** A token the page address names. It is shown whatever its status or day. */
  explicitKey?: string;
  /** Tokens this device booked, oldest first. The newest one that is still useful is shown. */
  remembered: string[];
}

function useDemoMyToken({ explicitKey, remembered }: MyTokenInput): MyTokenState {
  const { state, now, updatedAt } = useLiveQueue();
  const today = toDateKey(now);
  let token = explicitKey ? getToken(state, explicitKey) : undefined;
  if (!explicitKey) {
    token = [...remembered]
      .reverse()
      .map((id) => getToken(state, id))
      .find((t) => t && t.date >= today && t.status !== 'cancelled');
  }
  let data: MyTokenData | null = null;
  const view = token ? queueView(state, token, now) : undefined;
  if (token && view) {
    const doctor = getDoctor(state, token.doctorId)!;
    data = {
      clinicName: state.settings.clinicName,
      slug: '',
      timezone: '',
      today,
      now,
      token,
      firstName: getPatient(state, token.patientId)?.name.split(' ')[0] ?? '',
      doctor: { id: doctor.id, name: doctor.name, opd: doctor.opd },
      view,
      status: queueStatus(state, token.doctorId, token.date, today),
      currentNumber: currentToken(state, token.doctorId, token.date)?.number ?? null,
      upcoming: upcomingTokens(state, token.doctorId, token.date, 3).map((t) => t.number),
    };
  }
  const load: MyTokenState['load'] = explicitKey ? (data ? 'ready' : 'not_found') : data ? 'ready' : 'idle';
  return { load, data, updatedAt, refresh: () => undefined };
}

function useRemoteMyToken({ explicitKey, remembered }: MyTokenInput): MyTokenState {
  const keys = explicitKey ? [explicitKey] : [...remembered].reverse().slice(0, 5);
  const remote = useRemote(
    async () => {
      for (const key of keys) {
        if (!UUID.test(key)) continue;
        const answer = await rpc('get_my_token', { p_access_key: key });
        if (!answer.ok) {
          if (answer.code === 'not_found') continue;
          return answer;
        }
        const data = mapMyToken(answer.data, key);
        // A link shows its token whatever happened to it. "Newest token on this device" skips finished days and cancellations.
        if (explicitKey || (data.token.date >= data.today && data.token.status !== 'cancelled')) {
          return { ok: true as const, value: data };
        }
      }
      return explicitKey
        ? { ok: false as const, code: 'not_found' as const, message: 'We could not find this token.' }
        : { ok: true as const, value: null };
    },
    [keys.join(',')],
    { enabled: keys.length > 0, intervalMs: 10000 },
  );

  let load: MyTokenState['load'] = 'loading';
  if (keys.length === 0) load = 'idle';
  else if (remote.data) load = 'ready';
  else if (remote.data === null) load = 'idle';
  else if (remote.failure) load = remote.failure.code === 'not_found' ? 'not_found' : 'error';
  return {
    load,
    message: remote.failure?.message,
    data: remote.data ?? null,
    updatedAt: remote.updatedAt ?? new Date(),
    refresh: remote.refresh,
  };
}

export const useMyToken: (input: MyTokenInput) => MyTokenState = IS_SUPABASE ? useRemoteMyToken : useDemoMyToken;
