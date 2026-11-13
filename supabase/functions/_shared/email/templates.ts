// Apna Clinic emails. No imports, no Deno/Node/DOM APIs. One layout() plus a table of templates;
// the plain text is built from the same data. Never a password; patient mails: first name only,
// no phone, no medical details. Every dynamic value is HTML-escaped.

export type TemplateName =
  | 'staff_invitation' | 'staff_activation' | 'email_verification' | 'password_reset' | 'password_changed'
  | 'patient_otp' | 'appointment_confirmation' | 'queue_token_confirmation' | 'appointment_cancellation';

export interface EmailData {
  firstName?: string; clinicName?: string; roleLabel?: string; inviterName?: string;
  actionUrl?: string; expiresIn?: string; code?: string; expiresInMinutes?: number;
  doctorName?: string; opdName?: string; dateLabel?: string; sessionLabel?: string; tokenNumber?: number;
  queueUrl?: string; bookingUrl?: string; supportEmail?: string; whenLabel?: string;
}

export interface RenderedEmail { subject: string; html: string; text: string }

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ESC[ch] as string);
}

const C = { teal: '#0f6b6b', soft: '#e3f0ef', bg: '#faf8f4', text: '#1f2a2b', danger: '#a3261a', muted: '#566466', line: '#e4dfd6' };
const FONT = "font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
const TAGLINE = 'Apna Clinic · Simple, organised clinic queues';
const IGNORE = 'If you did not expect this email, you can safely ignore it.';
const SIGN_IN = 'Open Apna Clinic and sign in to continue.';
const e = escapeHtml;
const PRES = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

interface X {
  first: string; clinic: string; role: string; inviter: string; act: string; exp: string; code: string;
  mins: string; doctor: string; opd: string; date: string; session: string; tok: string;
  queue: string; book: string; when: string;
}

// Text is raw (escaped once, in layout). need: say "sign in" when there is no valid link.
interface Spec {
  subject: string; pre?: string; h: string; p: (string | false)[];
  big?: string; label?: string; spaced?: 1; rows?: [string, string][]; warn?: string;
  btn?: string; url?: string; need?: 1;
  after?: (string | false)[];
}

const an = (w: string) => (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w;
const limit = (x: X) => (x.exp ? `For your safety, this link expires in ${x.exp}.` : 'For your safety, this link expires after a short time.');
const at = (x: X) => (x.clinic ? ` at ${x.clinic}` : '');
const WELCOME = "Welcome to Apna Clinic! We're glad to have you with us.";
const WAITS = 'Please arrive a little early. Waiting times are only estimates and can change during the day.';

const T: Record<TemplateName, (x: X) => Spec> = {
  staff_invitation: (x) => ({
    subject: x.clinic ? `${x.clinic} has invited you to join on Apna Clinic` : 'You have been invited to Apna Clinic',
    h: x.clinic ? `You have been invited to join ${x.clinic}` : 'You have been invited to join a clinic',
    p: [
      `${x.inviter || 'A clinic owner'} has invited you to join ${x.clinic || 'their clinic'} on Apna Clinic${x.role ? ` as ${an(x.role)}` : ''}.`,
      'You already have an Apna Clinic account, so there is nothing new to set up. Sign in and choose Accept on the invitation.',
      'No access is given until you accept. Nothing about your password changes. We never send passwords by email. If your clinic gave you a temporary password separately, use it to sign in, and you will be asked to choose a new private one on your first sign in.',
    ],
    rows: [['Clinic', x.clinic], ['Role', x.role], ['Invited by', x.inviter]],
    btn: 'Sign in to review the invitation', url: x.act, need: 1,
  }),
  staff_activation: (x) => ({
    subject: 'Welcome to Apna Clinic: sign in to get started',
    h: 'Welcome to Apna Clinic',
    p: [
      WELCOME,
      `Your account has been created successfully${x.clinic ? ` for ${x.clinic}` : ''}${x.role ? ` as ${an(x.role)}` : ''}, and we're here to make your clinic experience simpler and more organised.`,
      'To sign in, use the email address this message was sent to and the temporary password your clinic gave you separately. We never send passwords by email. You will be asked to choose a new private password the first time you sign in.',
      !!x.act && 'Use the secure button below to continue.',
    ],
    rows: [['Clinic', x.clinic], ['Role', x.role], ['Added by', x.inviter]],
    btn: 'Open the sign-in page', url: x.act, need: 1,
  }),
  email_verification: (x) => ({
    subject: 'Confirm your email address for Apna Clinic',
    h: 'Confirm your email address',
    p: [
      WELCOME,
      'You are setting up a clinic account with this email address. Please confirm it so we know the account is yours.',
      !!x.act && 'Use the secure button below to confirm your email address.',
    ],
    btn: 'Confirm my email address', url: x.act, need: 1,
    after: [!!x.act && limit(x)],
  }),
  password_reset: (x) => ({
    subject: 'Reset your Apna Clinic password',
    h: 'Reset your password',
    p: [
      'We received a request to reset the password for your Apna Clinic account.',
      !!x.act && 'Use the secure button below to choose a new password.',
    ],
    btn: 'Choose a new password', url: x.act, need: 1,
    after: [!!x.act && limit(x), 'If you did not ask for this, you can safely ignore this email. Your password will stay as it is.'],
  }),
  password_changed: (x) => ({
    subject: 'Your Apna Clinic password was changed',
    h: 'Your password was changed',
    p: [
      `This is a security notice. The password for your Apna Clinic account was changed${x.when ? ` on ${x.when}` : ''}.`,
      'If this was you, there is nothing more to do.',
    ],
    warn: `If this was not you, ${x.act ? 'reset your password now using the button below, or ' : 'reset your password now from the sign-in page, or '}contact your clinic straight away.`,
    btn: 'Reset my password', url: x.act,
  }),
  patient_otp: (x) => ({
    subject: 'Your Apna Clinic verification code',
    pre: `Your verification code is ${x.code || 'inside'}. It expires in ${x.mins}.`,
    h: 'Your verification code',
    p: [`Use this code to continue with your booking${at(x)}.`, `This code expires in ${x.mins}.`],
    big: x.code, label: 'Your verification code', spaced: 1,
    warn: 'Never share this code with anyone. Apna Clinic staff will never ask for it.',
  }),
  appointment_confirmation: (x) => ({
    subject: `Your appointment is confirmed${x.date ? `: ${x.date}` : ''}`,
    h: 'Your appointment is confirmed',
    p: [`Your appointment${at(x)} is confirmed. Here are your details.`],
    rows: [['Clinic', x.clinic], ['Doctor', x.doctor], ['OPD', x.opd], ['Date', x.date], ['Session', x.session], ['Token number', x.tok]],
    btn: 'View the live queue', url: x.queue,
    after: [WAITS],
  }),
  queue_token_confirmation: (x) => ({
    subject: `You are in the queue${x.tok ? `: token ${x.tok}` : ''}`,
    h: 'You are in the queue',
    p: [`You are in today's queue${at(x)}. Please keep your token number handy.`],
    big: x.tok, label: 'Your token number',
    rows: [['Doctor', x.doctor], ['OPD', x.opd], ['Date', x.date], ['Session', x.session]],
    btn: 'Track the live queue', url: x.queue,
    after: [WAITS],
  }),
  appointment_cancellation: (x) => ({
    subject: 'Your appointment was cancelled',
    h: 'Your appointment was cancelled',
    p: [
      `Your appointment${at(x)} has been cancelled. No further action is needed.`,
      !!x.book && 'If you would still like to see the doctor, use the button below to book again.',
    ],
    rows: [['Doctor', x.doctor], ['OPD', x.opd], ['Date', x.date], ['Session', x.session], ['Token number', x.tok]],
    btn: 'Book again', url: x.book,
  }),
};

export const EMAIL_TEMPLATE_NAMES: readonly TemplateName[] = Object.keys(T) as TemplateName[];

function layout(s: Spec, x: X, support: string): RenderedEmail {
  const keep = (a?: (string | false)[]) => (a ?? []).filter((v): v is string => !!v);
  const rows = (s.rows ?? []).filter((r) => r[1]);
  const hi = `Hello ${x.first},`;
  const paras = [hi, ...keep(s.p)], notes = keep(s.after);
  const fallback = !s.url && s.need ? SIGN_IN : '';
  const tbl = (inner: string, st = '') => `<table ${PRES} width="100%" style="${st}">${inner}</table>`;
  const card = (inner: string, st: string) => tbl(`<tr><td style="${st}">${inner}</td></tr>`, 'margin:0 0 20px;');
  const para = (t: string, st = '') => `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${C.text};${st}">${e(t)}</p>`;
  const sp = s.spaced ? '.3em' : '0';

  const h = [`<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;color:${C.teal};">${e(s.h)}</h1>`, ...paras.map((t) => para(t))];
  if (s.big) {
    h.push(card(
      `<div style="font-size:14px;color:${C.muted};">${e(s.label || '')}</div>` +
      `<div style="font-family:Consolas,'Courier New',monospace;font-size:${s.spaced ? 34 : 48}px;line-height:1.3;font-weight:700;color:${C.teal};letter-spacing:${sp};padding:6px 0 0 ${sp};">${e(s.big)}</div>`,
      `background:${C.soft};border-radius:10px;padding:18px 12px;text-align:center;`));
  }
  if (rows.length) {
    const cell = 'padding:6px 12px;font-size:15px;line-height:1.5;vertical-align:top;';
    h.push(card(tbl(rows.map((r) => `<tr><td width="38%" style="${cell}color:${C.muted};">${e(r[0])}</td><td style="${cell}color:${C.text};font-weight:600;">${e(r[1])}</td></tr>`).join('')),
      `background:${C.soft};border-radius:10px;padding:8px 4px;`));
  }
  if (s.warn) h.push(card(e(s.warn), `border-left:4px solid ${C.danger};background:#fbeceb;color:${C.danger};padding:12px 14px;font-size:15px;line-height:1.5;font-weight:600;`));
  if (s.url) {
    const u = e(s.url);
    h.push(`<table ${PRES} style="margin:8px 0 18px;"><tr><td bgcolor="${C.teal}" style="background:${C.teal};border-radius:8px;"><a class="btn" href="${u}" style="display:inline-block;padding:14px 28px;${FONT}font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;background:${C.teal};">${e(s.btn || 'Continue')}</a></td></tr></table>`,
      `<p style="margin:0 0 20px;font-size:13px;line-height:1.6;color:${C.muted};">If the button does not work, copy and paste this link into your browser:<br><a href="${u}" style="color:${C.teal};word-break:break-all;">${u}</a></p>`);
  } else if (fallback) h.push(para(fallback));
  h.push(...notes.map((t) => para(t, `font-size:14px;color:${C.muted};`)));

  const foot = `<p style="margin:0 0 6px;font-weight:700;">${e(TAGLINE)}</p><p style="margin:0 0 6px;">${e(IGNORE)}</p>` +
    (support ? `<p style="margin:0;">Need help? Write to <a href="mailto:${e(support)}" style="color:${C.teal};">${e(support)}</a></p>` : '');
  const pad = '&nbsp;&zwnj;'.repeat(40);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${e(s.subject)}</title>
<style>a.btn:hover{background:#0b5555!important}@media only screen and (max-width:620px){.card{padding:22px 18px!important}}</style></head>
<body style="margin:0;padding:0;background:${C.bg};${FONT}color:${C.text};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${C.bg};">${e(s.pre || paras[1] || s.h)}${pad}</div>
${tbl(`<tr><td align="center" style="padding:24px 12px;${FONT}">${tbl(
  `<tr><td style="padding:0 4px 16px;"><table ${PRES}><tr><td width="30" height="30" align="center" style="width:30px;height:30px;background:${C.teal};border-radius:8px;color:#ffffff;font-size:22px;font-weight:700;line-height:30px;">+</td><td style="padding-left:10px;font-size:22px;font-weight:700;color:${C.teal};">Apna Clinic</td></tr></table></td></tr>` +
  `<tr><td class="card" style="background:#ffffff;border:1px solid ${C.line};border-radius:12px;padding:30px 28px;">${h.join('')}</td></tr>` +
  `<tr><td align="center" style="padding:20px 8px;font-size:13px;line-height:1.6;color:${C.muted};">${foot}</td></tr>`,
  'max-width:600px;')}</td></tr>`, `background:${C.bg};`)}
</body></html>`;

  const t = ['Apna Clinic', s.h, ...paras];
  if (s.big) t.push(`${s.label || ''}: ${s.big}`);
  if (rows.length) t.push(rows.map((r) => `${r[0]}: ${r[1]}`).join('\n'));
  if (s.warn) t.push(s.warn);
  if (s.url) t.push(`${s.btn || 'Continue'}\n${s.url}`); // no colon: it would read like a password value
  else if (fallback) t.push(fallback);
  t.push(...notes, `--\n${TAGLINE}\n${IGNORE}${support ? `\nNeed help? Write to ${support}` : ''}`);
  return { subject: s.subject, html, text: t.join('\n\n') };
}

// https only (http://localhost for development).
const URL_OK = /^(https:\/\/[^\s"'<>\\/?#]+|http:\/\/localhost(:\d{1,5})?)([/?#][^\s"'<>\\]*)?$/i;
const MAIL_OK = /^[^\s@<>"'&]+@[^\s@<>"'&]+\.[^\s@<>"'&]+$/;
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f\u2028\u2029]+/g;

export function renderEmail(name: TemplateName, data: EmailData): RenderedEmail {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const c = (k: string, max = 200) => {
    const v = d[k];
    return (typeof v === 'string' || typeof v === 'number' ? String(v) : '').replace(CTRL, ' ').trim().slice(0, max);
  };
  const url = (k: string) => { const v = c(k, 2000); return URL_OK.test(v) ? v : ''; };
  const code = c('code', 12).replace(/\s+/g, '');
  const n = Math.round(Number(d.expiresInMinutes)) || 10;
  const tok = c('tokenNumber', 8);
  const x: X = {
    first: c('firstName', 80).split(' ')[0] || 'there', clinic: c('clinicName'), role: c('roleLabel', 60), inviter: c('inviterName'),
    act: url('actionUrl'), exp: c('expiresIn', 60), code: /^[0-9A-Za-z]{4,10}$/.test(code) ? code : '',
    mins: `${n > 0 && n < 1440 ? n : 10} minute${n === 1 ? '' : 's'}`, doctor: c('doctorName'), opd: c('opdName'), date: c('dateLabel'),
    session: c('sessionLabel'), tok: /^\d{1,6}$/.test(tok) ? tok : '', queue: url('queueUrl'), book: url('bookingUrl'), when: c('whenLabel'),
  };
  const support = c('supportEmail', 120);
  const make = Object.prototype.hasOwnProperty.call(T, name) ? T[name] : undefined;
  const spec: Spec = make ? make(x) : { subject: 'Apna Clinic', h: 'Apna Clinic', p: [SIGN_IN] };
  return layout(spec, x, MAIL_OK.test(support) ? support : '');
}
