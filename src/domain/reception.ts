// Filtering for the reception list. Kept here so the screen only has to show the rows.

import type { AppState, DateKey, Patient, Token, TokenStatus } from './types';

/** "arrived" means waiting and already at the clinic. "not_arrived" means waiting and not yet at the clinic. */
export type StatusFilter = 'all' | 'not_arrived' | 'arrived' | TokenStatus;

export interface ReceptionFilters {
  query: string;
  doctorId: string | 'all';
  status: StatusFilter;
}

export interface ReceptionRow {
  token: Token;
  patient: Patient;
}

/**
 * Short numbers (up to 3 digits, with or without #) match token numbers.
 * Longer digit strings match phone numbers. Anything else matches the name.
 */
export function matchesQuery(row: ReceptionRow, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  const digits = text.replace(/\D/g, '');
  const looksNumeric = /^[#\d\s+-]+$/.test(text) && digits.length > 0;

  if (looksNumeric) {
    if (digits.length <= 3) return String(row.token.number) === String(Number(digits));
    return row.patient.phone.includes(digits);
  }
  return row.patient.name.toLowerCase().includes(text);
}

export function matchesStatus(token: Token, status: StatusFilter): boolean {
  switch (status) {
    case 'all':
      return true;
    case 'arrived':
      return token.status === 'waiting' && Boolean(token.arrivedAt);
    case 'not_arrived':
      return token.status === 'waiting' && !token.arrivedAt;
    default:
      return token.status === status;
  }
}

/** Rows for the day, in doctor then token order. */
export function receptionRows(state: AppState, date: DateKey, filters: ReceptionFilters): ReceptionRow[] {
  const doctorOrder = new Map(state.doctors.map((d, i) => [d.id, i]));
  const rows: ReceptionRow[] = [];
  for (const token of state.tokens) {
    if (token.date !== date) continue;
    if (filters.doctorId !== 'all' && token.doctorId !== filters.doctorId) continue;
    const patient = state.patients.find((p) => p.id === token.patientId);
    if (!patient) continue;
    const row = { token, patient };
    if (!matchesStatus(token, filters.status)) continue;
    if (!matchesQuery(row, filters.query)) continue;
    rows.push(row);
  }
  return rows.sort(
    (a, b) =>
      (doctorOrder.get(a.token.doctorId) ?? 0) - (doctorOrder.get(b.token.doctorId) ?? 0) ||
      a.token.number - b.token.number,
  );
}
