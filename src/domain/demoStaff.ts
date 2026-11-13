// Demo staff accounts. This is NOT real authentication.
// Nothing is sent to any phone. The code below is shown on the login screen on purpose.
// A real version needs an OTP provider and server side checks.

import type { Role } from './types';
import { normalizePhone } from './validation';

export const DEMO_OTP = '1234';

export interface DemoStaff {
  phone: string;
  role: Role;
  /** Set for doctors so the panel opens their own queue. */
  doctorId?: string;
  /** Used for reception and owner. Doctors show the name from the doctor list. */
  label: string;
}

export const DEMO_STAFF: DemoStaff[] = [
  { phone: '9000000101', role: 'reception', label: 'Reception desk' },
  { phone: '9000000102', role: 'doctor', doctorId: 'doc-general', label: 'General OPD doctor' },
  { phone: '9000000104', role: 'doctor', doctorId: 'doc-child', label: 'Child OPD doctor' },
  { phone: '9000000103', role: 'owner', label: 'Clinic owner' },
];

export type LoginCheck = { ok: true; staff: DemoStaff } | { ok: false; field: 'phone' | 'otp'; message: string };

export function checkDemoLogin(phoneInput: string, otpInput: string): LoginCheck {
  const phone = normalizePhone(phoneInput);
  if (!phone) return { ok: false, field: 'phone', message: 'Enter a valid 10 digit mobile number.' };
  const staff = DEMO_STAFF.find((s) => s.phone === phone);
  if (!staff) return { ok: false, field: 'phone', message: 'This number is not one of the demo staff numbers listed below.' };
  if (otpInput.trim() !== DEMO_OTP) return { ok: false, field: 'otp', message: 'That code is not correct.' };
  return { ok: true, staff };
}
