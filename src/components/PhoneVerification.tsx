// Asks a patient to prove a one time code. Used when booking (a clinic can require it) and to see your own place in
// a queue without the link to your token.
//
// What this screen never does: show or guess a code, or say a code was sent when the server did not say so. If the
// server cannot send the kind of code asked for, it says that plainly and nothing was sent.

import { MessageSquare, Mail, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cleanPhone, fetchChannels, requestCode, verifyCode, type Channels, type CodeChannel, type CodeSent } from '../backend/verification';
import type { Failure } from '../domain/types';
import { Button, LiveRegion, Notice, TextField } from './ui';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const RESEND_AFTER_SECONDS = 30;

export interface PhoneVerificationProps {
  /**
   * booking: the clinic wants the patient's contact checked; a text message or an email code both work.
   * position: to see a queue place the phone itself must be proved, so only a text message works.
   */
  purpose: 'booking' | 'position';
  /** The number typed on the form. When given, it is shown and cannot be changed here. */
  phone?: string;
  /** An email the patient already typed, offered for the email code. */
  email?: string;
  onVerified(result: { verification: string; channel: CodeChannel; phone: string }): void;
  onCancel?(): void;
}

export function PhoneVerification({ purpose, phone: givenPhone, email: givenEmail, onVerified, onCancel }: PhoneVerificationProps) {
  const [channels, setChannels] = useState<Channels | null>(null);
  const [channelsFailure, setChannelsFailure] = useState<Failure | null>(null);
  const [choice, setChoice] = useState<CodeChannel>('sms');
  const [phone, setPhone] = useState(givenPhone ?? '');
  const [email, setEmail] = useState(givenEmail ?? '');
  const [sent, setSent] = useState<CodeSent | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);
  const lockedPhone = givenPhone !== undefined;

  useEffect(() => {
    let live = true;
    void fetchChannels().then((r) => {
      if (!live) return;
      if (!r.ok) return setChannelsFailure(r);
      setChannels(r.value);
      setChoice(r.value.sms || purpose === 'position' ? 'sms' : 'email');
    });
    return () => {
      live = false;
    };
  }, [purpose]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  useEffect(() => {
    if (sent) codeRef.current?.focus();
  }, [sent]);

  const available: CodeChannel[] = channels ? (['sms', 'email'] as const).filter((c) => channels[c] && (purpose === 'booking' || c === 'sms')) : [];
  const shownErrors = failure?.fieldErrors ?? {};

  async function send() {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const result = await requestCode({ phone: cleanPhone(phone), channel: choice, ...(choice === 'email' ? { email: email.trim() } : {}) });
    setBusy(false);
    if (!result.ok) return setFailure(result);
    setSent(result.value);
    setCode('');
    setCooldown(RESEND_AFTER_SECONDS);
  }

  async function check() {
    if (busy || !sent) return;
    setBusy(true);
    setFailure(null);
    const result = await verifyCode(sent.challengeId, code.replace(/\s/g, ''));
    setBusy(false);
    if (result.ok) return onVerified({ verification: result.value.verification, channel: result.value.channel, phone: cleanPhone(phone) });
    setFailure(result);
    // A code that has expired or has been tried too often cannot be saved: ask for a new one.
    if (result.code === 'otp_expired') {
      setSent(null);
      setCode('');
    } else {
      codeRef.current?.focus();
    }
  }

  const title = purpose === 'booking' ? 'Verify before booking' : 'Check your place in the queue';

  if (channelsFailure) {
    return (
      <section className="card verify" aria-labelledby="verify-title">
        <h2 id="verify-title">{title}</h2>
        <Notice kind="error" title={channelsFailure.message}>
          <p>We could not check how codes can be sent. Please try again in a moment.</p>
        </Notice>
        {onCancel && <Button onClick={onCancel}>Go back</Button>}
      </section>
    );
  }
  if (!channels) {
    return (
      <section className="card verify" aria-labelledby="verify-title">
        <h2 id="verify-title">{title}</h2>
        <p className="muted" role="status">
          Loading...
        </p>
      </section>
    );
  }
  if (available.length === 0) {
    return (
      <section className="card verify" aria-labelledby="verify-title">
        <h2 id="verify-title">{title}</h2>
        <Notice kind="warning" title="Codes cannot be sent right now.">
          <p>
            {purpose === 'booking'
              ? 'This clinic asks patients to verify their contact before booking, but no code can be sent at the moment. No code was sent. Please contact the clinic reception.'
              : 'Your place can only be shown after a text message code, and text messages are not available at the moment. Please use the link to your token, or ask the clinic reception.'}
          </p>
        </Notice>
        {onCancel && <Button onClick={onCancel}>Go back</Button>}
      </section>
    );
  }

  const sentWhere = sent ? (sent.channel === 'sms' ? `by text message to ${sent.sentTo}` : `by email to ${sent.sentTo}`) : '';

  return (
    <section className="card verify" aria-labelledby="verify-title">
      <h2 id="verify-title">
        <ShieldCheck size={22} aria-hidden="true" /> {title}
      </h2>
      <p className="muted">
        {purpose === 'booking'
          ? 'This clinic checks contact details before it books a token. We will send you a 6 digit code.'
          : 'Enter your mobile number. We will send a 6 digit code by text message to show your own token, and only yours.'}
      </p>

      {!sent && (
        <div className="stack">
          {!lockedPhone && (
            <TextField
              label="Mobile number"
              name="verify-phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel-national"
              maxLength={16}
              prefix="+91"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              error={shownErrors.phone}
            />
          )}
          {lockedPhone && (
            <p>
              Mobile number: <strong className="nowrap">+91 {cleanPhone(phone)}</strong>
            </p>
          )}

          {available.length > 1 && (
            <fieldset>
              <legend>How should we send the code?</legend>
              <div className="choice-list">
                {available.map((c) => (
                  <label className="choice" key={c}>
                    <input type="radio" name="code-channel" value={c} checked={choice === c} onChange={() => setChoice(c)} />
                    <span className="choice__body">
                      <span className="choice__title">
                        {c === 'sms' ? <MessageSquare size={16} aria-hidden="true" /> : <Mail size={16} aria-hidden="true" />}{' '}
                        {c === 'sms' ? 'Text message to my mobile' : 'Email'}
                      </span>
                      {c === 'email' && (
                        <>
                          <br />
                          <span className="muted small">Confirms your email address. It does not prove the mobile number.</span>
                        </>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {choice === 'email' && (
            <TextField
              label="Email address"
              name="verify-email"
              type="email"
              autoComplete="email"
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={shownErrors.email}
            />
          )}

          {failure && !failure.fieldErrors && <Notice kind="error" title={failure.message} />}
          {failure?.fieldErrors && <Notice kind="error" title="Please fix the highlighted fields." />}

          <div className="row">
            <Button
              variant="primary"
              onClick={() => void send()}
              disabled={busy || cleanPhone(phone).length < 10 || (choice === 'email' && !EMAIL.test(email.trim()))}
            >
              {busy ? 'Sending...' : choice === 'sms' ? 'Send code by text message' : 'Send code by email'}
            </Button>
            {onCancel && <Button onClick={onCancel}>Cancel</Button>}
          </div>
        </div>
      )}

      {sent && (
        <form
          className="stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void check();
          }}
        >
          <LiveRegion>
            <Notice kind="success" live={false}>
              We sent a 6 digit code {sentWhere}. It expires in {sent.expiresInMinutes} minutes.
            </Notice>
          </LiveRegion>
          <TextField
            ref={codeRef}
            label="6 digit code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            pattern="[0-9]*"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            // A wrong code says how many tries are left, so the whole message is the field's error.
            error={failure?.code === 'otp_invalid' ? failure.message : shownErrors.code}
          />
          {failure && !failure.fieldErrors && <Notice kind="error" title={failure.message} />}
          <div className="row">
            <Button type="submit" variant="primary" disabled={busy || code.length !== 6}>
              {busy ? 'Checking...' : 'Verify'}
            </Button>
            <Button
              onClick={() => {
                setSent(null);
                setFailure(null);
              }}
              disabled={busy}
            >
              Change number or method
            </Button>
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            {cooldown > 0 ? (
              `You can ask for a new code in ${cooldown} seconds.`
            ) : (
              <button type="button" className="link-button" onClick={() => void send()} disabled={busy}>
                Send a new code
              </button>
            )}
          </p>
        </form>
      )}
    </section>
  );
}
