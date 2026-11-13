// booking-public: the parts of public booking that need server secrets. Patients are not signed in, so this function
// is public (verify_jwt off) and protects itself: strict input checks, database enforced rate limits, one time codes
// that are hashed with a server secret and never stored or logged, and emails that go only to an address the patient
// gave when booking, by the secret key of their own token.
//
//   status               Which ways of receiving a code this server can really offer (text message, email).
//   otp_request          Sends a 6 digit code to a mobile number (text message) or to an email address.
//   otp_verify           Checks the code. Success returns a verification the booking and "my place" calls accept.
//   notify_booking       Emails the booking confirmation (today: queue token mail, later date: appointment mail).
//   notify_cancellation  Emails the cancellation notice for a token that is cancelled.
//
// This file holds the logic only. Everything it needs from outside (the database with the secret key, the email and SMS
// providers, the environment) is passed in as `deps`, so the same code runs in Deno (index.ts), in unit tests and in
// the browser test stand-in. The secret key never leaves the server.

import { readEmailConfig, sendTemplate } from '../_shared/email/send.ts';
import { maskPhone, readSmsConfig, sendSms } from '../_shared/sms.ts';

type Json = Record<string, unknown>;
type RpcResult = { data: any; error: { message: string } | null };

export interface Deps {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  rpc: (fn: string, args: Json) => Promise<RpcResult>;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: Json, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const failure = (code: string, message: string, status: number, extra: Json = {}) =>
  reply({ ok: false, code, message, ...extra }, status);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const PHONE = /^[6-9][0-9]{9}$/;
const STATUS: Record<string, number> = {
  invalid_input: 400, otp_invalid: 400, otp_required: 400, otp_expired: 410, rate_limited: 429, not_found: 404, invalid_transition: 409,
};
const OTP_MINUTES = 10;
const MAX_BODY = 4096;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const enc = new TextEncoder();

/** The database's own refusals (rate limits, expired codes, ...) become the HTTP answer unchanged. */
function refusal(r: Json) {
  const code = String(r.code ?? 'invalid_input');
  return failure(code, String(r.message ?? 'This could not be done.'), STATUS[code] ?? 400, {
    ...(r.field_errors ? { field_errors: r.field_errors } : {}),
    ...(typeof r.attempts_left === 'number' ? { attempts_left: r.attempts_left } : {}),
  });
}
const serverError = (what: string) => failure('server_error', `${what} Please try again in a moment.`, 500);

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A uniformly random 6 digit code from the platform's secure random source. */
export function randomCode(): string {
  const buffer = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / 1_000_000) * 1_000_000; // reject the top slice so every code is equally likely
  do { crypto.getRandomValues(buffer); } while ((buffer[0] as number) >= limit);
  return String((buffer[0] as number) % 1_000_000).padStart(6, '0');
}

const secretOf = (deps: Deps) => {
  const s = (deps.env('OTP_HASH_SECRET') ?? '').trim();
  return s.length >= 16 ? s : null;
};

function clientAddress(req: Request): string | null {
  const forwarded = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? (req.headers.get('x-forwarded-for') ?? '').split(',')[0];
  const ip = str(forwarded);
  return ip && ip.length <= 64 ? ip : null;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "2026-03-11" becomes "Wednesday, 11 March 2026". The date is a calendar date, so no time zone is involved. */
export function dateLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const clock12 = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
};
export const sessionLabel = (start?: unknown, end?: unknown) =>
  typeof start === 'string' && typeof end === 'string' && start && end ? `${clock12(start)} to ${clock12(end)}` : undefined;

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return failure('invalid_input', 'Use POST.', 405);
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY) return failure('invalid_input', 'This request is too large.', 413);

  let input: Json;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return failure('invalid_input', 'This request is too large.', 413);
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    input = parsed as Json;
  } catch {
    return failure('invalid_input', 'Send the details as JSON.', 400);
  }

  try {
    // `return await` matters: without it a rejected promise would skip the catch below.
    switch (str(input.action)) {
      case 'status': return status(deps);
      case 'otp_request': return await otpRequest(input, req, deps);
      case 'otp_verify': return await otpVerify(input, deps);
      case 'notify_booking': return await notify(input, deps, 'booking');
      case 'notify_cancellation': return await notify(input, deps, 'cancellation');
      default: return failure('invalid_input', 'Unknown request.', 400);
    }
  } catch (error) {
    // Never echo internals to a public caller. The log has the reason, and no codes, phones or addresses.
    console.error('booking-public: unexpected error', error instanceof Error ? error.message : 'unknown');
    return serverError('Something went wrong on our side.');
  }
}

// ------------------------------------------------------------------------------------------------------------------
function status(deps: Deps): Response {
  const secret = secretOf(deps);
  return reply({
    ok: true,
    channels: { sms: secret !== null && readSmsConfig(deps.env).ok, email: secret !== null && readEmailConfig(deps.env).ok },
  });
}

async function otpRequest(input: Json, req: Request, deps: Deps): Promise<Response> {
  const phone = str(input.phone).replace(/[\s-]/g, '').replace(/^(\+?91|0)(?=[0-9]{10}$)/, '');
  const channel = str(input.channel);
  const email = str(input.email).toLowerCase();

  const errors: Record<string, string> = {};
  if (!PHONE.test(phone)) errors.phone = 'Enter a valid 10 digit mobile number that starts with 6, 7, 8 or 9.';
  if (channel !== 'sms' && channel !== 'email') errors.channel = 'Choose how to receive the code.';
  if (channel === 'email' && !EMAIL.test(email)) errors.email = 'Enter a valid email address.';
  if (Object.keys(errors).length > 0) return failure('invalid_input', 'Please fix the highlighted fields.', 400, { field_errors: errors });

  // Check this server can really send, before a code is created or any limit is used up.
  const secret = secretOf(deps);
  const smsConfig = readSmsConfig(deps.env);
  const emailConfig = readEmailConfig(deps.env);
  if (secret === null || (channel === 'sms' && !smsConfig.ok) || (channel === 'email' && !emailConfig.ok)) {
    return failure('not_configured', channel === 'sms'
      ? 'Text message verification is not available right now. No code was sent.'
      : 'Email verification is not available right now. No code was sent.', 503);
  }

  const ip = clientAddress(req);
  const begun = await deps.rpc('otp_begin', {
    p_phone: phone, p_channel: channel, p_ip_hash: ip ? await hmacHex(secret, `ip:${ip}`) : null,
    // For email, the address is limited too (hashed, never stored in the clear), so no inbox can be flooded with codes.
    p_target_hash: channel === 'email' ? await hmacHex(secret, `email:${email}`) : null,
  });
  if (begun.error) return serverError('The code could not be created.');
  if (!begun.data?.ok) return refusal(begun.data ?? {});
  const challenge = String(begun.data.challenge_id);

  const code = randomCode();
  const stored = await deps.rpc('otp_set_hash', { p_challenge: challenge, p_hash: await hmacHex(secret, `${challenge}:${code}`) });
  if (stored.error || !stored.data?.ok) {
    await deps.rpc('otp_cancel', { p_challenge: challenge }).catch(() => undefined);
    return serverError('The code could not be created.');
  }

  const result = channel === 'sms'
    ? await sendSms(smsConfig, deps.fetch, phone,
        `${code} is your Apna Clinic verification code. It expires in ${OTP_MINUTES} minutes. Do not share it with anyone.`)
    : await sendTemplate(emailConfig, deps.fetch, email, 'patient_otp', { code, expiresInMinutes: OTP_MINUTES, expiresIn: `${OTP_MINUTES} minutes` });

  if (result.status !== 'sent') {
    // A code that was not sent must not stay valid or count against the person.
    await deps.rpc('otp_cancel', { p_challenge: challenge }).catch(() => undefined);
    console.error(`booking-public: ${channel} code not sent (${result.status}): ${result.message ?? ''}`);
    return failure(result.status === 'not_configured' ? 'not_configured' : 'delivery_failed',
      channel === 'sms'
        ? 'We could not send the text message. No code was sent. Please check the number and try again, or contact the clinic.'
        : 'We could not send the email. No code was sent. Please check the address and try again, or contact the clinic.',
      result.status === 'not_configured' ? 503 : 502);
  }
  return reply({
    ok: true, challenge_id: challenge, channel, expires_in_minutes: OTP_MINUTES,
    sent_to: channel === 'sms' ? maskPhone(phone) : email.replace(/^(.).*(@.*)$/, '$1***$2'),
  });
}

async function otpVerify(input: Json, deps: Deps): Promise<Response> {
  const challenge = str(input.challenge_id);
  const code = str(input.code).replace(/\s/g, '');
  if (!UUID.test(challenge)) return failure('invalid_input', 'Request a new code.', 400);
  if (!/^[0-9]{6}$/.test(code)) {
    return failure('invalid_input', 'Enter the 6 digit code.', 400, { field_errors: { code: 'Enter the 6 digit code.' } });
  }
  const secret = secretOf(deps);
  if (secret === null) return failure('not_configured', 'Verification is not available right now.', 503);

  const checked = await deps.rpc('otp_check', { p_challenge: challenge, p_hash: await hmacHex(secret, `${challenge}:${code}`) });
  if (checked.error) return serverError('The code could not be checked.');
  if (!checked.data?.ok) return refusal(checked.data ?? {});
  return reply({
    ok: true, verification: challenge, channel: checked.data.channel, phone_hint: maskPhone(String(checked.data.phone ?? '')),
    valid_for_minutes: 30,
  });
}

// ------------------------------------------------------------------------------------------------------------------
async function notify(input: Json, deps: Deps, kind: 'booking' | 'cancellation'): Promise<Response> {
  const accessKey = str(input.access_key);
  if (!UUID.test(accessKey)) return failure('invalid_input', 'This token could not be found.', 400);

  const looked = await deps.rpc('booking_email_context', { p_access_key: accessKey });
  if (looked.error) return serverError('The booking could not be read.');
  const c = looked.data as Json;
  if (!c?.ok) return refusal(c ?? {});

  const to = str(c.email);
  if (!to) return reply({ ok: true, email: { status: 'skipped', message: 'No email address was given for this booking.' } });
  if (kind === 'booking' && c.status === 'cancelled') return failure('invalid_transition', 'This booking was cancelled.', 409);
  if (kind === 'cancellation' && c.status !== 'cancelled') return failure('invalid_transition', 'This booking has not been cancelled.', 409);

  const cfg = readEmailConfig(deps.env);
  const base = cfg.ok ? cfg.config.appBaseUrl : undefined;
  const slug = str(c.clinic_slug);
  const forToday = str(c.date) === str(c.today);
  const template = kind === 'cancellation' ? 'appointment_cancellation' : forToday ? 'queue_token_confirmation' : 'appointment_confirmation';
  const first = str(c.first_name);

  // Only what the patient needs. No phone number, no medical detail, no other patient.
  const result = await sendTemplate(cfg, deps.fetch, to, template, {
    firstName: first || undefined, clinicName: str(c.clinic_name), doctorName: str(c.doctor), opdName: str(c.opd) || undefined,
    dateLabel: dateLabel(str(c.date)), sessionLabel: sessionLabel(c.session_start, c.session_end),
    tokenNumber: typeof c.number === 'number' ? c.number : undefined,
    queueUrl: base && slug ? `${base}/c/${slug}/queue/${accessKey}` : undefined,
    bookingUrl: base && slug ? `${base}/c/${slug}/book` : undefined,
  }, `booking-${kind}-${accessKey}`);

  await deps.rpc('log_email_event', {
    p_clinic: typeof c.clinic_id === 'string' ? c.clinic_id : null, p_template: template, p_recipient: to,
    p_status: result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : 'skipped',
    p_provider_id: result.providerId ?? null, p_error: result.status === 'sent' ? null : result.message ?? null,
  }).catch(() => undefined);

  // The patient's booking already succeeded. This only says honestly what happened to the email. The provider's own
  // wording stays in the server log and the email_events table, not in a public answer.
  if (result.status !== 'sent') console.error(`booking-public: ${template} not sent (${result.status}): ${result.message ?? ''}`);
  return reply({
    ok: true,
    email: {
      status: result.status,
      ...(result.status === 'sent' ? {} : {
        message: result.status === 'not_configured'
          ? 'Email is not set up for this clinic yet, so no email was sent.'
          : 'We could not send the email. No email was sent.',
      }),
    },
  });
}
