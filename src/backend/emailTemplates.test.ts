import { describe, expect, it } from 'vitest';
import {
  EMAIL_TEMPLATE_NAMES,
  escapeHtml,
  renderEmail,
  type EmailData,
  type TemplateName,
} from '../../supabase/functions/_shared/email/templates';

const FULL: EmailData = {
  firstName: 'Priya',
  clinicName: 'Sunrise Family Clinic',
  roleLabel: 'Doctor',
  inviterName: 'Dr. Rao',
  actionUrl: 'https://apnaclinic.example/set-password?token=abc&next=%2Fhome',
  expiresIn: '24 hours',
  code: '482913',
  expiresInMinutes: 10,
  doctorName: 'Dr. Mehta',
  opdName: 'General OPD',
  dateLabel: 'Tuesday, 10 November 2026',
  sessionLabel: 'Morning OPD, 9:30 AM to 12:45 PM',
  tokenNumber: 17,
  queueUrl: 'https://apnaclinic.example/c/sunrise/queue',
  bookingUrl: 'https://apnaclinic.example/c/sunrise/book',
  supportEmail: 'help@apnaclinic.example',
  whenLabel: '10 Nov 2026, 4:12 PM IST',
};

const PATIENT: TemplateName[] = ['patient_otp', 'appointment_confirmation', 'queue_token_confirmation', 'appointment_cancellation'];

const SUBJECTS: Record<TemplateName, string> = {
  staff_invitation: 'Sunrise Family Clinic has invited you to join on Apna Clinic',
  staff_activation: 'Welcome to Apna Clinic: sign in to get started',
  email_verification: 'Confirm your email address for Apna Clinic',
  password_reset: 'Reset your Apna Clinic password',
  password_changed: 'Your Apna Clinic password was changed',
  patient_otp: 'Your Apna Clinic verification code',
  appointment_confirmation: 'Your appointment is confirmed: Tuesday, 10 November 2026',
  queue_token_confirmation: 'You are in the queue: token 17',
  appointment_cancellation: 'Your appointment was cancelled',
};

const names = [...EMAIL_TEMPLATE_NAMES];

describe('email templates', () => {
  it('lists all nine templates', () => {
    expect(names.sort()).toEqual(Object.keys(SUBJECTS).sort());
  });

  it.each(names)('%s renders with full data and with empty data', (name) => {
    for (const data of [FULL, {}, undefined as unknown as EmailData, null as unknown as EmailData]) {
      const mail = renderEmail(name, data);
      expect(mail.subject.length).toBeGreaterThan(0);
      expect(mail.html).toContain('Apna Clinic');
      expect(mail.html).toContain('<title>');
      expect(mail.html).toContain('lang="en"');
      expect(mail.html).toContain('name="color-scheme"');
      expect(mail.text.trim().length).toBeGreaterThan(0);
      expect(mail.text).toContain('Apna Clinic');
      expect(mail.text).toContain('If you did not expect this email, you can safely ignore it.');
      expect(mail.html).toContain('If you did not expect this email, you can safely ignore it.');
      expect(mail.html).not.toMatch(/unsubscribe/i);
    }
  });

  it.each(names)('%s has the exact subject line', (name) => {
    expect(renderEmail(name, FULL).subject).toBe(SUBJECTS[name]);
  });

  it('uses the fallback subjects when details are missing', () => {
    expect(renderEmail('staff_invitation', {}).subject).toBe('You have been invited to Apna Clinic');
    expect(renderEmail('appointment_confirmation', {}).subject).toBe('Your appointment is confirmed');
    expect(renderEmail('queue_token_confirmation', {}).subject).toBe('You are in the queue');
  });

  it('greets by first name only and falls back to "there"', () => {
    const named = renderEmail('staff_activation', { ...FULL, firstName: 'Priya Sharma' });
    expect(named.html).toContain('Hello Priya,');
    expect(named.html).not.toContain('Sharma');
    expect(named.text).toContain('Hello Priya,');
    expect(renderEmail('staff_activation', {}).text).toContain('Hello there,');
  });

  it('shows the support email only when it is given', () => {
    expect(renderEmail('password_reset', FULL).html).toContain('help@apnaclinic.example');
    expect(renderEmail('password_reset', FULL).text).toContain('help@apnaclinic.example');
    expect(renderEmail('password_reset', { ...FULL, supportEmail: undefined }).html).not.toContain('Need help?');
  });

  it('escapes every user supplied value', () => {
    const evil = '<script>alert(1)</script>';
    const data: EmailData = {
      ...FULL,
      firstName: evil,
      clinicName: evil,
      roleLabel: evil,
      inviterName: evil,
      expiresIn: evil,
      doctorName: evil,
      opdName: evil,
      dateLabel: evil,
      sessionLabel: evil,
      whenLabel: evil,
      supportEmail: 'a"b@x.com',
    };
    for (const name of names) {
      const mail = renderEmail(name, data);
      expect(mail.html).not.toContain('<script');
      expect(mail.html).not.toContain(evil);
      expect(mail.subject).not.toContain('\n');
    }
    expect(renderEmail('staff_invitation', data).html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('keeps line breaks out of the subject', () => {
    const mail = renderEmail('staff_invitation', { ...FULL, clinicName: 'Sunrise\r\nBcc: someone@example.com' });
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  it('drops links that are not https (or http://localhost)', () => {
    for (const bad of ['javascript:alert(1)', 'http://example.com/x', 'data:text/html,hi', '//evil.example', 'https://', 'http://localhost.evil.com/x', 'https://a.com/"onmouseover="x']) {
      const mail = renderEmail('password_reset', { ...FULL, actionUrl: bad });
      expect(mail.html).not.toContain('href="javascript');
      expect(mail.html).not.toContain(bad);
      expect(mail.html).toContain('Open Apna Clinic and sign in to continue.');
      expect(mail.text).toContain('Open Apna Clinic and sign in to continue.');
      expect(mail.html).not.toContain('copy and paste this link');
    }
  });

  it('accepts https and http://localhost links, with a visible copy-and-paste line', () => {
    const ok = renderEmail('staff_activation', FULL);
    expect(ok.html).toContain('href="https://apnaclinic.example/set-password?token=abc&amp;next=%2Fhome"');
    expect(ok.html).toContain('copy and paste this link');
    expect(ok.text).toContain('https://apnaclinic.example/set-password?token=abc&next=%2Fhome');
    const dev = renderEmail('staff_activation', { ...FULL, actionUrl: 'http://localhost:5173/login' });
    expect(dev.html).toContain('href="http://localhost:5173/login"');
  });

  it('never contains a password value', () => {
    for (const name of names) {
      const mail = renderEmail(name, FULL);
      expect(mail.html).not.toMatch(/password\s*:\s*\S/i);
      expect(mail.text).not.toMatch(/password\s*:\s*\S/i);
      expect(mail.html).not.toMatch(/<input/i);
    }
  });

  it('tells new and invited staff the temporary password came separately', () => {
    for (const name of ['staff_activation', 'staff_invitation'] as const) {
      const mail = renderEmail(name, FULL);
      expect(mail.text).toMatch(/temporary password/i);
      expect(mail.text).toMatch(/separately/i);
      expect(mail.text).toMatch(/choose a new/i);
    }
  });

  it('makes the invitation clear that nothing happens until they accept', () => {
    const mail = renderEmail('staff_invitation', FULL);
    expect(mail.text).toContain('Dr. Rao');
    expect(mail.text).toContain('Sunrise Family Clinic');
    expect(mail.text).toContain('a Doctor');
    expect(mail.text).toMatch(/choose Accept/);
    expect(mail.text).toMatch(/No access is given until you accept/);
  });

  it.each(PATIENT)('%s has no phone number, no "phone" and no surname', (name) => {
    const mail = renderEmail(name, { ...FULL, firstName: 'Priya Sharma' });
    for (const out of [mail.html, mail.text, mail.subject]) {
      expect(out).not.toContain('+91');
      expect(out).not.toMatch(/phone/i);
      expect(out).not.toContain('Sharma');
    }
  });

  it('shows the one-time code in both versions and warns not to share it', () => {
    const mail = renderEmail('patient_otp', FULL);
    expect(mail.html).toContain('482913');
    expect(mail.text).toContain('482913');
    expect(mail.text).toContain('10 minutes');
    expect(mail.text).toMatch(/Never share this code/);
    expect(mail.text).toMatch(/staff will never ask for it/);
    expect(renderEmail('patient_otp', { ...FULL, expiresInMinutes: 1 }).text).toContain('1 minute.');
  });

  it('shows the booking details', () => {
    const confirm = renderEmail('appointment_confirmation', FULL);
    for (const part of ['Sunrise Family Clinic', 'Dr. Mehta', 'General OPD', 'Tuesday, 10 November 2026', 'Morning OPD, 9:30 AM to 12:45 PM', '17', 'https://apnaclinic.example/c/sunrise/queue']) {
      expect(confirm.html).toContain(part);
      expect(confirm.text).toContain(part);
    }
    expect(confirm.text).toMatch(/estimates/);
    const token = renderEmail('queue_token_confirmation', FULL);
    expect(token.html).toContain('>17<');
    expect(token.text).toContain('Your token number: 17');
    const cancelled = renderEmail('appointment_cancellation', FULL);
    expect(cancelled.text).toContain('https://apnaclinic.example/c/sunrise/book');
    expect(renderEmail('appointment_cancellation', { ...FULL, bookingUrl: undefined }).html).not.toContain('<a class="btn"');
  });

  it('puts the time of the change in the password changed notice', () => {
    const mail = renderEmail('password_changed', FULL);
    expect(mail.text).toContain('10 Nov 2026, 4:12 PM IST');
    expect(mail.text).toMatch(/If this was not you/);
  });

  it('never throws for an unknown template name', () => {
    const mail = renderEmail('nope' as TemplateName, FULL);
    expect(mail.html).toContain('Apna Clinic');
    expect(mail.text.length).toBeGreaterThan(0);
  });
});

// Run with WRITE_EMAIL_PREVIEWS=1 to save each email as an HTML file you can open in a browser.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
if (env.WRITE_EMAIL_PREVIEWS === '1') {
  describe('email previews', () => {
    it('writes each html to /tmp/email-previews', async () => {
      const fsName = 'node:fs';
      const fs = (await import(/* @vite-ignore */ fsName)) as {
        mkdirSync: (dir: string, opts: { recursive: boolean }) => void;
        writeFileSync: (file: string, data: string) => void;
      };
      fs.mkdirSync('/tmp/email-previews', { recursive: true });
      for (const name of names) fs.writeFileSync(`/tmp/email-previews/${name}.html`, renderEmail(name, FULL).html);
    });
  });
}
