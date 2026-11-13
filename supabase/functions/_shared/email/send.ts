// Sends one of the Apna Clinic emails through Resend's HTTPS API.
//
// Why HTTPS and not SMTP: Supabase Edge Functions block the usual SMTP ports (25 and 587).
// Honesty rule: "sent" is returned only when the provider accepted the message. Every other outcome says why not.
// No imports from the platform: the environment and fetch are passed in, so this runs in Deno, Node and tests.

import { renderEmail, type EmailData, type TemplateName } from './templates.ts';

export interface EmailConfig { apiKey: string; from: string; replyTo?: string; appBaseUrl: string; supportEmail?: string }
export type ConfigResult = { ok: true; config: EmailConfig } | { ok: false; missing: string[] };
export interface SendResult {
  status: 'sent' | 'failed' | 'not_configured';
  message?: string;
  providerId?: string;
}

export function readEmailConfig(env: (name: string) => string | undefined): ConfigResult {
  const value = (k: string) => (env(k) ?? '').trim();
  const missing = ['RESEND_API_KEY', 'EMAIL_FROM', 'APP_BASE_URL'].filter((k) => value(k) === '');
  if (missing.length > 0) return { ok: false, missing };
  const base = value('APP_BASE_URL').replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/]+$/.test(base) && !/^http:\/\/localhost(:\d+)?$/.test(base) && !/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(base)) {
    return { ok: false, missing: ['APP_BASE_URL (must be the https:// address of the site, with no path)'] };
  }
  return {
    ok: true,
    config: { apiKey: value('RESEND_API_KEY'), from: value('EMAIL_FROM'), replyTo: value('EMAIL_REPLY_TO') || undefined,
      appBaseUrl: base, supportEmail: value('SUPPORT_EMAIL') || undefined },
  };
}

export const notConfiguredMessage = (missing: string[]) =>
  `Email delivery is not set up on this server (missing: ${missing.join(', ')}). No email was sent.`;

export async function sendTemplate(
  config: ConfigResult, fetchFn: typeof fetch, to: string, template: TemplateName, data: EmailData,
  idempotencyKey?: string,
): Promise<SendResult> {
  if (!config.ok) return { status: 'not_configured', message: notConfiguredMessage(config.missing) };
  const rendered = renderEmail(template, { supportEmail: config.config.supportEmail, ...data });
  let response: Response;
  try {
    response = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.config.apiKey}`, 'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: config.config.from, to: [to], subject: rendered.subject, html: rendered.html, text: rendered.text,
        ...(config.config.replyTo ? { reply_to: config.config.replyTo } : {}),
      }),
    });
  } catch {
    return { status: 'failed', message: 'The email provider could not be reached. No email was sent.' };
  }
  let body: { id?: string; message?: string; name?: string } = {};
  try { body = await response.json(); } catch { /* the status code is enough */ }
  if (response.ok && body.id) return { status: 'sent', providerId: body.id };
  const reason = String(body.message ?? `status ${response.status}`).slice(0, 220);
  return { status: 'failed', message: `The email provider did not accept the message: ${reason}` };
}
