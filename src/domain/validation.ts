import { parseHM } from './dates';
import type { OpdSession } from './types';

/**
 * Turns what a person typed into a ten digit Indian mobile number.
 * Accepts spaces, dashes, a +91 prefix or a leading 0. Returns null when it is not a valid number.
 */
export function normalizePhone(input: string): string | null {
  let digits = input.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

export function validatePhone(input: string): string | null {
  if (!input.trim()) return 'Enter a mobile number.';
  if (!normalizePhone(input)) return 'Enter a valid 10 digit mobile number that starts with 6, 7, 8 or 9.';
  return null;
}

export function cleanName(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

export function validateName(input: string): string | null {
  const name = cleanName(input);
  if (!name) return 'Enter the patient name.';
  if (name.length < 2) return 'The name must have at least 2 letters.';
  if (name.length > 60) return 'The name can have at most 60 characters.';
  if (!/^[\p{L}\p{M}][\p{L}\p{M}\s.'-]*$/u.test(name)) {
    return 'Use letters, spaces, dots, apostrophes or hyphens only.';
  }
  return null;
}

/** "9000000001" to "••••• ••001". Used wherever a full number is not needed. */
export function maskPhone(phone: string): string {
  return `••••• ••${phone.slice(-3)}`;
}

/** "9000000001" to "90000 00001". */
export function formatPhone(phone: string): string {
  return `${phone.slice(0, 5)} ${phone.slice(5)}`;
}

/** Whole number inside a range, or an error message. */
export function validateWholeNumber(value: unknown, min: number, max: number, label: string): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return `${label} must be a whole number.`;
  if (value < min || value > max) return `${label} must be between ${min} and ${max}.`;
  return null;
}

/** Checks OPD sessions: one to three windows, each ending after it starts, none overlapping. */
export function validateSessions(sessions: OpdSession[]): string | null {
  if (sessions.length < 1) return 'Add at least one OPD timing.';
  if (sessions.length > 3) return 'Use at most 3 OPD timings.';
  const parsed = sessions.map((s) => ({ start: parseHM(s.start), end: parseHM(s.end) }));
  for (const p of parsed) {
    if (Number.isNaN(p.start) || Number.isNaN(p.end)) return 'Enter every OPD time as hours and minutes.';
    if (p.end <= p.start) return 'Each OPD timing must end after it starts.';
  }
  const sorted = [...parsed].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].start < sorted[i - 1].end) return 'OPD timings must not overlap.';
  }
  return null;
}

export interface ContactCheck {
  name: string;
  phone: string;
  fieldErrors: Record<string, string>;
}

/** Shared by the booking form, the walk-in form and the domain rules. */
export function checkContact(nameInput: string, phoneInput: string): ContactCheck {
  const fieldErrors: Record<string, string> = {};
  const nameError = validateName(nameInput);
  const phoneError = validatePhone(phoneInput);
  if (nameError) fieldErrors.name = nameError;
  if (phoneError) fieldErrors.phone = phoneError;
  return {
    name: cleanName(nameInput),
    phone: normalizePhone(phoneInput) ?? '',
    fieldErrors,
  };
}
