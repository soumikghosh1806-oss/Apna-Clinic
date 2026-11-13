// The booking-public Edge Function's logic, run with fake services. Real Twilio, real Resend and the real database are
// not reachable from here (the database half is covered by the SQL tests), so what these tests prove is the function's
// own rules: what it checks, what it refuses, what it sends, what it never stores or reveals, and what it says when
// delivery fails or is not set up.
import { describe, expect, it } from 'vitest';
import { dateLabel, handle, hmacHex, randomCode, sessionLabel, type Deps } from '../../supabase/functions/booking-public/handler.ts';
import { maskPhone, readSmsConfig, sendSms, toE164 } from '../../supabase/functions/_shared/sms.ts';

const KEY = '44444444-4444-4444-8444-444444444444';
const CHALLENGE = '55555555-5555-4555-8555-555555555555';
const FULL_ENV: Record<string, string> = {
  OTP_HASH_SECRET: 'a-long-random-secret-for-the-tests-0123456789',
  RESEND_API_KEY: 're_test', EMAIL_FROM: 'Apna Clinic <no-reply@mail.example.com>', APP_BASE_URL: 'https://apna.example.com',
  TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tw_secret', TWILIO_MESSAGING_SERVICE_SID: 'MGtest',
};
const CONTEXT = {
  ok: true, email: 'patient@example.com', first_name: 'Asha', clinic_id: '66666666-6666-4666-8666-666666666666', clinic_name: 'Sunrise Skin Centre',
  clinic_slug: 'sunrise-skin', doctor: 'Dr Meera Skin', opd: 'Skin OPD', date: '2026-03-11', today: '2026-03-10', number: 7, status: 'waiting',
  session_start: '16:00', session_end: '19:00',
};

interface Setup { env?: Record<string, string>; rpcs?: Record<string, any>; twilio?: { status: number; body: any } | 'throw'; resend?: { status: number; body: any } | 'throw' }

function setup(o: Setup = {}) {
  const calls: { fn: string; args: any }[] = [];
  const sms: { to: string; body: string; auth: string }[] = [];
  const mails: any[] = [];
  const keys: (string | null)[] = [];
  const rpcs: Record<string, any> = {
    otp_begin: { ok: true, challenge_id: CHALLENGE, phone: '9876543210' }, otp_set_hash: { ok: true }, otp_cancel: { ok: true },
    otp_check: { ok: true, challenge_id: CHALLENGE, phone: '9876543210', channel: 'sms' }, booking_email_context: CONTEXT, log_email_event: null,
    ...o.rpcs,
  };
  const deps: Deps = {
    env: (k) => (o.env ?? FULL_ENV)[k],
    fetch: (async (url: any, init: any) => {
      if (String(url).startsWith('https://api.twilio.com/')) {
        if (o.twilio === 'throw') throw new Error('network');
        const form = new URLSearchParams(init.body);
        sms.push({ to: form.get('To') ?? '', body: form.get('Body') ?? '', auth: init.headers.Authorization });
        const r = o.twilio ?? { status: 201, body: { sid: 'SM123', status: 'queued' } };
        return new Response(JSON.stringify(r.body), { status: r.status });
      }
      if (String(url) === 'https://api.resend.com/emails') {
        if (o.resend === 'throw') throw new Error('network');
        mails.push(JSON.parse(init.body));
        keys.push(init.headers['Idempotency-Key'] ?? null);
        const r = o.resend ?? { status: 200, body: { id: 'em_1' } };
        return new Response(JSON.stringify(r.body), { status: r.status });
      }
      throw new Error(`unexpected request to ${url}`);
    }) as typeof fetch,
    rpc: async (fn, args) => { calls.push({ fn, args }); return { data: rpcs[fn], error: null }; },
  };
  const call = (body: any, headers: Record<string, string> = {}) =>
    handle(new Request('https://f.test/booking-public', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }), deps)
      .then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
  return { call, calls, sms, mails, keys, deps };
}

const REQUEST = { action: 'otp_request', phone: '98765 43210', channel: 'sms' };
const sentCode = (text: string) => /^(\d{6}) is your Apna Clinic verification code/.exec(text)?.[1] ?? '';

describe('booking-public: text message helper', () => {
  it('only accepts a ten digit Indian mobile number and hides all but the last four digits', () => {
    expect(toE164('9876543210')).toBe('+919876543210');
    expect(toE164('1234567890')).toBeNull();
    expect(toE164('98765')).toBeNull();
    expect(maskPhone('9876543210')).toBe('XXXXXX3210');
  });
  it('says what is missing instead of pretending to send', async () => {
    const cfg = readSmsConfig((k) => ({ TWILIO_ACCOUNT_SID: 'AC1' }[k]));
    expect(cfg).toEqual({ ok: false, missing: ['TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM'] });
    const r = await sendSms(cfg, (() => { throw new Error('must not be called'); }) as unknown as typeof fetch, '9876543210', 'hi');
    expect(r.status).toBe('not_configured');
    expect(r.message).toContain('No message was sent');
  });
  it('reports "sent" only when the provider returned a message id with HTTP 201', async () => {
    const cfg = readSmsConfig((k) => FULL_ENV[k]);
    const reply = (status: number, body: any) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect((await sendSms(cfg, reply(201, { sid: 'SM1' }), '9876543210', 'x')).status).toBe('sent');
    expect((await sendSms(cfg, reply(201, {}), '9876543210', 'x')).status).toBe('failed');
    const refused = await sendSms(cfg, reply(400, { message: 'The number is unverified', code: 21608 }), '9876543210', 'x');
    expect(refused).toMatchObject({ status: 'failed' });
    expect(refused.message).toContain('unverified');
    expect((await sendSms(cfg, (async () => { throw new Error('offline'); }) as unknown as typeof fetch, '9876543210', 'x')).status).toBe('failed');
  });
});

describe('booking-public: codes', () => {
  it('makes six digit codes that are not all the same', () => {
    const seen = new Set(Array.from({ length: 50 }, () => randomCode()));
    for (const c of seen) expect(c).toMatch(/^\d{6}$/);
    expect(seen.size).toBeGreaterThan(40);
  });
  it('signs with a keyed hash that depends on both the secret and the challenge', async () => {
    const a = await hmacHex('secret-one-secret-one', `${CHALLENGE}:123456`);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hmacHex('secret-two-secret-two', `${CHALLENGE}:123456`)).not.toBe(a);
    expect(await hmacHex('secret-one-secret-one', `${KEY}:123456`)).not.toBe(a);
  });
});

describe('booking-public: otp_request', () => {
  it('sends the code by text message, stores only its hash, and never returns it', async () => {
    const s = setup();
    const r = await s.call(REQUEST, { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, challenge_id: CHALLENGE, channel: 'sms', expires_in_minutes: 10, sent_to: 'XXXXXX3210' });
    expect(s.sms).toHaveLength(1);
    expect(s.sms[0].to).toBe('+919876543210');
    const code = sentCode(s.sms[0].body);
    expect(code).toMatch(/^\d{6}$/);
    expect(s.sms[0].auth).toMatch(/^Basic /);

    const stored = s.calls.find((c) => c.fn === 'otp_set_hash')!.args;
    expect(stored.p_hash).toBe(await hmacHex(FULL_ENV.OTP_HASH_SECRET!, `${CHALLENGE}:${code}`));
    const everything = JSON.stringify([s.calls, r.json]);
    expect(everything).not.toContain(code);
    expect(everything).not.toContain('203.0.113.9');
    expect(s.calls.find((c) => c.fn === 'otp_begin')!.args.p_ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.calls.find((c) => c.fn === 'otp_begin')!.args.p_phone).toBe('9876543210');
  });

  it('sends by email with the branded code template, limiting the address as well', async () => {
    const s = setup();
    const r = await s.call({ action: 'otp_request', phone: '9876543210', channel: 'email', email: 'Asha@Example.com' });
    expect(r.status).toBe(200);
    expect(r.json.sent_to).toBe('a***@example.com');
    expect(s.mails).toHaveLength(1);
    expect(s.mails[0].to).toEqual(['asha@example.com']);
    expect(s.mails[0].subject).toBe('Your Apna Clinic verification code');
    const code = /\b(\d{6})\b/.exec(s.mails[0].text)![1];
    expect(s.mails[0].html).toContain(code);
    expect(s.calls.find((c) => c.fn === 'otp_begin')!.args.p_target_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(s.calls)).not.toContain('asha@example.com');
  });

  it('checks the input before doing anything', async () => {
    const s = setup();
    const r = await s.call({ action: 'otp_request', phone: '12345', channel: 'carrier pigeon' });
    expect(r.status).toBe(400);
    expect(Object.keys(r.json.field_errors).sort()).toEqual(['channel', 'phone']);
    expect((await s.call({ action: 'otp_request', phone: '9876543210', channel: 'email', email: 'nope' })).json.field_errors.email).toBeTruthy();
    expect(s.calls).toHaveLength(0);
    expect(s.sms).toHaveLength(0);
  });

  it('says so, and uses up nothing, when the server cannot send that kind of code', async () => {
    const noSms = setup({ env: { ...FULL_ENV, TWILIO_AUTH_TOKEN: '' } });
    const r = await noSms.call(REQUEST);
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ ok: false, code: 'not_configured' });
    expect(r.json.message).toContain('No code was sent');
    expect(noSms.calls).toHaveLength(0);

    const noSecret = setup({ env: { ...FULL_ENV, OTP_HASH_SECRET: 'short' } });
    expect((await noSecret.call(REQUEST)).json.code).toBe('not_configured');
    expect(noSecret.calls).toHaveLength(0);
  });

  it('cancels the code and tells the truth when the provider refuses or cannot be reached', async () => {
    for (const twilio of [{ status: 400, body: { message: 'Unverified number', code: 21608 } }, 'throw'] as const) {
      const s = setup({ twilio });
      const r = await s.call(REQUEST);
      expect(r.status).toBe(502);
      expect(r.json).toMatchObject({ ok: false, code: 'delivery_failed' });
      expect(r.json.message).toContain('No code was sent');
      expect(r.json.message).not.toContain('Unverified');
      expect(s.calls.map((c) => c.fn)).toEqual(['otp_begin', 'otp_set_hash', 'otp_cancel']);
    }
    const mail = setup({ resend: { status: 403, body: { message: 'domain not verified' } } });
    const r = await mail.call({ action: 'otp_request', phone: '9876543210', channel: 'email', email: 'a@example.com' });
    expect(r.json.code).toBe('delivery_failed');
    expect(mail.calls.some((c) => c.fn === 'otp_cancel')).toBe(true);
  });

  it('passes the database limits on exactly as they are', async () => {
    const s = setup({ rpcs: { otp_begin: { ok: false, code: 'rate_limited', message: 'Too many codes were requested for this number. Please wait about 10 minutes and try again.' } } });
    const r = await s.call(REQUEST);
    expect(r.status).toBe(429);
    expect(r.json.code).toBe('rate_limited');
    expect(s.sms).toHaveLength(0);
  });
});

describe('booking-public: otp_verify', () => {
  it('hashes what was typed the same way and returns the verification, never the number', async () => {
    const s = setup();
    const r = await s.call({ action: 'otp_verify', challenge_id: CHALLENGE, code: '123 456' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, verification: CHALLENGE, channel: 'sms', phone_hint: 'XXXXXX3210', valid_for_minutes: 30 });
    expect(s.calls[0].args.p_hash).toBe(await hmacHex(FULL_ENV.OTP_HASH_SECRET!, `${CHALLENGE}:123456`));
    expect(JSON.stringify(r.json)).not.toContain('9876543210');
  });
  it('checks the shape of the code and the id before asking the database', async () => {
    const s = setup();
    expect((await s.call({ action: 'otp_verify', challenge_id: 'nope', code: '123456' })).status).toBe(400);
    const bad = await s.call({ action: 'otp_verify', challenge_id: CHALLENGE, code: '12ab56' });
    expect(bad.status).toBe(400);
    expect(bad.json.field_errors.code).toBeTruthy();
    expect(s.calls).toHaveLength(0);
  });
  it('reports a wrong code with the tries that are left, and an expired one as expired', async () => {
    const wrong = setup({ rpcs: { otp_check: { ok: false, code: 'otp_invalid', message: 'That code is not correct. You have 4 tries left.', field_errors: { code: 'That code is not correct.' }, attempts_left: 4 } } });
    const r = await wrong.call({ action: 'otp_verify', challenge_id: CHALLENGE, code: '000000' });
    expect([r.status, r.json.code, r.json.attempts_left]).toEqual([400, 'otp_invalid', 4]);
    const expired = setup({ rpcs: { otp_check: { ok: false, code: 'otp_expired', message: 'This code has expired.' } } });
    expect((await expired.call({ action: 'otp_verify', challenge_id: CHALLENGE, code: '000000' })).status).toBe(410);
  });
});

describe('booking-public: booking and cancellation emails', () => {
  it('sends the appointment mail for a later date, with only what the patient needs', async () => {
    const s = setup();
    const r = await s.call({ action: 'notify_booking', access_key: KEY });
    expect(r.json).toEqual({ ok: true, email: { status: 'sent' } });
    expect(s.mails).toHaveLength(1);
    const mail = s.mails[0];
    expect(mail.to).toEqual(['patient@example.com']);
    expect(mail.subject).toContain('Your appointment is confirmed');
    for (const text of [mail.text, mail.html]) {
      expect(text).toContain('Sunrise Skin Centre');
      expect(text).toContain('Dr Meera Skin');
      expect(text).toContain('Wednesday, 11 March 2026');
      expect(text).toContain('4:00 pm to 7:00 pm');
      expect(text).toContain(`https://apna.example.com/c/sunrise-skin/queue/${KEY}`);
    }
    expect(JSON.stringify(mail)).not.toMatch(/9\d{9}/);
    expect(s.keys).toEqual([`booking-booking-${KEY}`]);
    expect(s.calls.find((c) => c.fn === 'log_email_event')!.args).toMatchObject({ p_template: 'appointment_confirmation', p_status: 'sent' });
  });

  it('sends the queue token mail for a booking made for today', async () => {
    const s = setup({ rpcs: { booking_email_context: { ...CONTEXT, date: '2026-03-10' } } });
    await s.call({ action: 'notify_booking', access_key: KEY });
    expect(s.mails[0].subject).toBe('You are in the queue: token 7');
  });

  it('sends nothing when the patient gave no email, and says so', async () => {
    const s = setup({ rpcs: { booking_email_context: { ...CONTEXT, email: null } } });
    const r = await s.call({ action: 'notify_booking', access_key: KEY });
    expect(r.json.email.status).toBe('skipped');
    expect(s.mails).toHaveLength(0);
  });

  it('never claims an email was sent when it was not', async () => {
    const notSet = setup({ env: { OTP_HASH_SECRET: FULL_ENV.OTP_HASH_SECRET! } });
    const a = await notSet.call({ action: 'notify_booking', access_key: KEY });
    expect(a.status).toBe(200);
    expect(a.json.email.status).toBe('not_configured');
    expect(a.json.email.message).toContain('no email was sent');
    expect(notSet.mails).toHaveLength(0);

    const refused = setup({ resend: { status: 403, body: { message: 'The mail.example.com domain is not verified' } } });
    const b = await refused.call({ action: 'notify_booking', access_key: KEY });
    expect(b.json.email.status).toBe('failed');
    expect(JSON.stringify(b.json)).not.toContain('mail.example.com');
    expect(refused.calls.find((c) => c.fn === 'log_email_event')!.args).toMatchObject({ p_status: 'failed' });
    expect((await setup({ resend: 'throw' }).call({ action: 'notify_booking', access_key: KEY })).json.email.status).toBe('failed');
  });

  it('sends the cancellation mail only for a cancelled token, and the booking mail only for a live one', async () => {
    const live = setup();
    expect((await live.call({ action: 'notify_cancellation', access_key: KEY })).status).toBe(409);
    expect(live.mails).toHaveLength(0);

    const cancelled = setup({ rpcs: { booking_email_context: { ...CONTEXT, status: 'cancelled' } } });
    expect((await cancelled.call({ action: 'notify_booking', access_key: KEY })).status).toBe(409);
    const r = await cancelled.call({ action: 'notify_cancellation', access_key: KEY });
    expect(r.json.email.status).toBe('sent');
    expect(cancelled.mails[0].subject).toBe('Your appointment was cancelled');
    expect(cancelled.mails[0].text).toContain('https://apna.example.com/c/sunrise-skin/book');
  });

  it('refuses a key that is not a key, and a token that is not found', async () => {
    const s = setup({ rpcs: { booking_email_context: { ok: false, code: 'not_found', message: 'This token could not be found.' } } });
    expect((await s.call({ action: 'notify_booking', access_key: 'abc' })).status).toBe(400);
    expect((await s.call({ action: 'notify_booking', access_key: KEY })).status).toBe(404);
    expect(s.mails).toHaveLength(0);
  });
});

describe('booking-public: the request itself', () => {
  it('reports which kinds of code this server can really send', async () => {
    expect((await setup().call({ action: 'status' })).json).toEqual({ ok: true, channels: { sms: true, email: true } });
    expect((await setup({ env: { OTP_HASH_SECRET: FULL_ENV.OTP_HASH_SECRET!, RESEND_API_KEY: 're_test', EMAIL_FROM: 'a@b.co', APP_BASE_URL: 'https://x.test' } }).call({ action: 'status' })).json.channels)
      .toEqual({ sms: false, email: true });
    expect((await setup({ env: {} }).call({ action: 'status' })).json.channels).toEqual({ sms: false, email: false });
  });
  it('refuses anything that is not a small JSON object with a known action', async () => {
    const s = setup();
    expect((await s.call('not json')).status).toBe(400);
    expect((await s.call('[1,2]')).status).toBe(400);
    expect((await s.call({ action: 'drop_everything' })).status).toBe(400);
    expect((await s.call({ action: 'otp_request', phone: '9'.repeat(5000) })).status).toBe(413);
    const get = await handle(new Request('https://f.test/booking-public', { method: 'GET' }), s.deps);
    expect(get.status).toBe(405);
    const options = await handle(new Request('https://f.test/booking-public', { method: 'OPTIONS' }), s.deps);
    expect(options.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });
  it('turns an unexpected database error into a calm message that reveals nothing', async () => {
    const s = setup();
    s.deps.rpc = async () => { throw new Error('connection to db.internal.supabase.co refused'); };
    const r = await handle(new Request('https://f.test/x', { method: 'POST', body: JSON.stringify(REQUEST) }), s.deps);
    const body = await r.json();
    expect(r.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('internal');
  });
  it('writes dates and sessions for people', () => {
    expect(dateLabel('2026-03-11')).toBe('Wednesday, 11 March 2026');
    expect(dateLabel('garbage')).toBe('garbage');
    expect(sessionLabel('09:30', '12:45')).toBe('9:30 am to 12:45 pm');
    expect(sessionLabel('00:05', '12:00')).toBe('12:05 am to 12:00 pm');
    expect(sessionLabel(undefined, undefined)).toBeUndefined();
  });
});
