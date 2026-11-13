// The public clinic directory: which clinics a patient can find from the home page, and how to search them.
//
// A clinic is listed only when its owner chose that. Everything here is what the database function shows to anyone:
// the clinic's name and location, a public phone number the owner chose, its doctors and their queue numbers. It never
// carries a patient, an owner or a staff member.

import type { Availability, QueueStatus } from '../domain/queue';
import { mapAvailability, mapQueueStatus } from './mappers';
import { rpc, type Dto } from './rpc';
import { useRemote, type Remote } from './useRemote';

export interface DirectoryDoctor {
  id: string;
  name: string;
  opd: string;
  specialization?: string;
  today: Availability;
  queue: { status: QueueStatus; waitingCount: number; currentNumber: number | null; consulting: boolean };
}

export interface DirectoryClinic {
  slug: string;
  name: string;
  city?: string;
  address?: string;
  state?: string;
  phone?: string;
  /** At least one doctor can take a booking today. */
  anyOpen: boolean;
  doctors: DirectoryDoctor[];
}

export interface DirectoryPage {
  total: number;
  clinics: DirectoryClinic[];
  offset: number;
  limit: number;
}

export interface DirectoryQuery {
  /** Clinic name or location. */
  query: string;
  specialization: string;
  doctor: string;
  offset: number;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const whole = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function mapDirectory(dto: Dto): DirectoryPage {
  const clinics = (Array.isArray(dto.clinics) ? (dto.clinics as Dto[]) : []).map((c): DirectoryClinic => ({
    slug: String(c.slug ?? ''),
    name: String(c.name ?? ''),
    city: text(c.city),
    address: text(c.address),
    state: text(c.state),
    phone: text(c.phone),
    anyOpen: c.any_open === true,
    doctors: (Array.isArray(c.doctors) ? (c.doctors as Dto[]) : []).map((d): DirectoryDoctor => {
      const q = (d.queue ?? {}) as Dto;
      return {
        id: String(d.id ?? ''),
        name: String(d.name ?? ''),
        opd: String(d.opd ?? ''),
        specialization: text(d.specialization),
        today: mapAvailability(d.today as Dto | undefined),
        queue: {
          status: mapQueueStatus(q.status as Dto | undefined),
          waitingCount: whole(q.waiting_count),
          currentNumber: typeof q.current_number === 'number' ? q.current_number : null,
          consulting: q.consulting === true,
        },
      };
    }),
  }));
  return { total: whole(dto.total), clinics, offset: whole(dto.offset), limit: whole(dto.limit) };
}

export function mapDirectoryFilters(dto: Dto): string[] {
  return (Array.isArray(dto.specializations) ? (dto.specializations as unknown[]) : []).filter((s): s is string => typeof s === 'string' && s !== '');
}

/** "Camp, Pune" style line from what the clinic gave. */
export function placeLine(c: Pick<DirectoryClinic, 'address' | 'city' | 'state'>): string {
  return [c.address, c.city, c.state].filter(Boolean).join(', ');
}

/** The words the database would reject (too short or too long) are not sent, so typing one letter shows everything. */
const usable = (v: string) => (v.trim().length >= 2 ? v.trim().slice(0, 60) : null);

export function useDirectory(q: DirectoryQuery, pageSize = 8): Remote<DirectoryPage> {
  const query = usable(q.query);
  const doctor = usable(q.doctor);
  return useRemote(
    async () => {
      const answer = await rpc('directory_search', {
        p_query: query, p_specialization: q.specialization || null, p_doctor: doctor, p_limit: pageSize, p_offset: q.offset,
      });
      return answer.ok ? { ok: true as const, value: mapDirectory(answer.data) } : answer;
    },
    [query, q.specialization, doctor, q.offset, pageSize],
    // The queue numbers on the cards stay fresh while the page is open.
    { intervalMs: 15000 },
  );
}

export function useDirectoryFilters(): Remote<string[]> {
  return useRemote(
    async () => {
      const answer = await rpc('directory_filters', {});
      return answer.ok ? { ok: true as const, value: mapDirectoryFilters(answer.data) } : answer;
    },
    [],
    { intervalMs: 0 },
  );
}
