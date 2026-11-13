// Phone and email verification for patients, and the emails about their booking. Everything goes through the
// booking-public Edge Function, which holds the secrets. The browser never sees a code before the patient does, never
// holds a key, and never decides whether something was "sent": the function answers that, honestly.

import type { Result } from '../domain/types';
import { callFunction } from './functions';
import type { Dto } from './rpc';

export type CodeChannel = 'sms' | 'email';
export interface Channels { sms: boolean; email: boolean }

/** What happened to an email about a booking. "skipped" means there was nobody to email, such as a patient who gave no address. */
export interface BookingEmailOutcome {
  status: 'sent' | 'failed' | 'not_configured' | 'skipped';
  message?: string;
}

export interface CodeSent {
  challengeId: string;
  channel: CodeChannel;
  expiresInMinutes: number;
  /** The number or address the code went to, partly hidden, so people can spot a typo. */
  sentTo: string;
}

export interface Verified {
  /** Pass this to book_token or get_my_position. It is good for 30 minutes, for this phone number only. */
  verification: string;
  channel: CodeChannel;
  validForMinutes: number;
}

const FUNCTION = 'booking-public';

/** "+91 98765-43210" becomes "9876543210", the form the database keeps. */
export const cleanPhone = (v: string) => v.replace(/[\s-]/g, '').replace(/^(\+?91|0)(?=[0-9]{10}$)/, '');

export async function fetchChannels(): Promise<Result<Channels>> {
  const r = await callFunction(FUNCTION, { action: 'status' });
  if (!r.ok) return r;
  const c = (r.data.channels ?? {}) as Dto;
  return { ok: true, value: { sms: c.sms === true, email: c.email === true } };
}

export async function requestCode(input: { phone: string; channel: CodeChannel; email?: string }): Promise<Result<CodeSent>> {
  const r = await callFunction(FUNCTION, { action: 'otp_request', ...input });
  if (!r.ok) return r;
  return {
    ok: true,
    value: {
      challengeId: String(r.data.challenge_id),
      channel: r.data.channel === 'email' ? 'email' : 'sms',
      expiresInMinutes: typeof r.data.expires_in_minutes === 'number' ? r.data.expires_in_minutes : 10,
      sentTo: String(r.data.sent_to ?? ''),
    },
  };
}

export async function verifyCode(challengeId: string, code: string): Promise<Result<Verified>> {
  const r = await callFunction(FUNCTION, { action: 'otp_verify', challenge_id: challengeId, code });
  if (!r.ok) return r;
  return {
    ok: true,
    value: {
      verification: String(r.data.verification),
      channel: r.data.channel === 'email' ? 'email' : 'sms',
      validForMinutes: typeof r.data.valid_for_minutes === 'number' ? r.data.valid_for_minutes : 30,
    },
  };
}

/** After this long the answer is treated as unknown: the booking is safe either way, only the email status is. */
const EMAIL_WAIT_MS = 8000;

async function notify(action: 'notify_booking' | 'notify_cancellation', accessKey: string): Promise<BookingEmailOutcome> {
  const unknown: BookingEmailOutcome = { status: 'failed', message: 'We could not confirm that the email was sent.' };
  const answer = await Promise.race([
    callFunction(FUNCTION, { action, access_key: accessKey }),
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), EMAIL_WAIT_MS)),
  ]);
  if (answer === null) return unknown;
  if (!answer.ok) return { status: 'failed', message: answer.message };
  const e = (answer.data.email ?? {}) as Dto;
  const status = e.status === 'sent' || e.status === 'failed' || e.status === 'not_configured' || e.status === 'skipped' ? e.status : 'failed';
  return { status, message: typeof e.message === 'string' ? e.message : undefined };
}

export const notifyBooking = (accessKey: string) => notify('notify_booking', accessKey);
export const notifyCancellation = (accessKey: string) => notify('notify_cancellation', accessKey);
