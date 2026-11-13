// Sends a text message through Twilio's HTTPS API. No imports from the platform: the environment and fetch are passed
// in, so this runs in Deno, Node and tests.
//
// Honesty rule: "sent" is returned only when Twilio accepted the message for delivery (HTTP 201 with a message id).
// It means the provider took it, not that the phone has it. Every other outcome says why not.
//
// Secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and ONE of TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM.
// India note: transactional SMS to Indian numbers must use a DLT registered sender and template (see docs/EMAIL_SETUP.md).

export interface SmsConfig { accountSid: string; authToken: string; from?: string; messagingServiceSid?: string }
export type SmsConfigResult = { ok: true; config: SmsConfig } | { ok: false; missing: string[] };
export interface SmsResult { status: 'sent' | 'failed' | 'not_configured'; message?: string; providerId?: string }

export function readSmsConfig(env: (name: string) => string | undefined): SmsConfigResult {
  const value = (k: string) => (env(k) ?? '').trim();
  const missing = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'].filter((k) => value(k) === '');
  if (value('TWILIO_MESSAGING_SERVICE_SID') === '' && value('TWILIO_FROM') === '') missing.push('TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM');
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    config: {
      accountSid: value('TWILIO_ACCOUNT_SID'), authToken: value('TWILIO_AUTH_TOKEN'),
      from: value('TWILIO_FROM') || undefined, messagingServiceSid: value('TWILIO_MESSAGING_SERVICE_SID') || undefined,
    },
  };
}

/** "98765 43210" becomes "+919876543210". Only the 10 digit Indian mobile format the database stores is accepted. */
export function toE164(phone10: string): string | null {
  return /^[6-9][0-9]{9}$/.test(phone10) ? `+91${phone10}` : null;
}

/** "XXXXXX3210": enough for a person to recognise their own number, nothing more. */
export const maskPhone = (phone10: string) => `${'X'.repeat(Math.max(0, phone10.length - 4))}${phone10.slice(-4)}`;

export async function sendSms(config: SmsConfigResult, fetchFn: typeof fetch, phone10: string, body: string): Promise<SmsResult> {
  if (!config.ok) return { status: 'not_configured', message: `Text messages are not set up on this server (missing: ${config.missing.join(', ')}). No message was sent.` };
  const to = toE164(phone10);
  if (!to) return { status: 'failed', message: 'This is not a mobile number text messages can be sent to.' };
  const c = config.config;
  const form = new URLSearchParams({ To: to, Body: body });
  if (c.messagingServiceSid) form.set('MessagingServiceSid', c.messagingServiceSid);
  else if (c.from) form.set('From', c.from);

  let response: Response;
  try {
    response = await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`${c.accountSid}:${c.authToken}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch {
    return { status: 'failed', message: 'The text message provider could not be reached. No message was sent.' };
  }
  let answer: { sid?: string; message?: string; code?: number } = {};
  try { answer = await response.json(); } catch { /* the status code is enough */ }
  if (response.status === 201 && answer.sid) return { status: 'sent', providerId: answer.sid };
  const reason = String(answer.message ?? `status ${response.status}`).slice(0, 220);
  return { status: 'failed', message: `The text message provider did not accept the message: ${reason}` };
}
