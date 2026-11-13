// Screen 1: Token booking (patient, mobile first)

import { Ticket, Users } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PhoneVerification } from '../components/PhoneVerification';
import { Button, ButtonLink, DemoTag, Notice, PageHeader, TextField } from '../components/ui';
import { IS_SUPABASE } from '../backend/mode';
import { availabilityLine, timingText } from '../domain/availabilityText';
import { cleanPhone, notifyBooking } from '../backend/verification';
import { formatDate } from '../domain/dates';
import type { Availability, SessionSlot } from '../domain/queue';
import type { BookingDoctor } from '../backend/mappers';
import type { Failure } from '../domain/types';
import { useActions } from '../state/context';
import { rememberToken, useFocusFirstError } from '../state/hooks';
import { useBooking } from '../state/publicData';
import { ClinicNotice } from '../components/ClinicNotice';

type DayChoice = 'today' | 'tomorrow';

const timing = timingText;

/** The timings that apply on the chosen day. The real backend sends them per day; the demo has one list for every day. */
function timingsFor(doctor: BookingDoctor, day: DayChoice): { start: string; end: string }[] {
  return doctor[day].sessions ?? doctor.sessions;
}

const dayLine = availabilityLine;

export function BookScreen() {
  const booking = useBooking();
  const actions = useActions();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const focusFirstError = useFocusFirstError();
  const formRef = useRef<HTMLFormElement>(null);
  const submitting = useRef(false);

  const doctors = booking.doctors;
  const [doctorChoice, setDoctorChoice] = useState(params.get('doctor') ?? '');
  const [day, setDay] = useState<DayChoice>('today');
  const [sessionChoice, setSessionChoice] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  // A checked one time code, good for this phone number only. The clinic decides whether booking needs one.
  const [verification, setVerification] = useState<{ id: string; phone: string } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<Failure | null>(null);

  const today = booking.today;
  const date = day === 'today' ? today : booking.tomorrow;
  const doctorId = doctors.some((d) => d.id === doctorChoice) ? doctorChoice : (doctors[0]?.id ?? '');
  const selected = doctors.find((d) => d.id === doctorId);
  const none: Availability = { open: false, reason: 'doctor_unavailable', issued: 0, limit: 0 };
  const availability = selected ? selected[day] : none;
  // Doctors with several sessions a day: the patient picks one. Sessions that already ended today cannot be picked.
  const slots: SessionSlot[] = availability.sessions ?? [];
  const openSlots = slots.filter((slot) => slot.open);
  const sessionStart = openSlots.some((slot) => slot.start === sessionChoice) ? sessionChoice : (openSlots[0]?.start ?? '');

  async function attempt(proof: string | undefined) {
    // A second tap or Enter press while the first one is being handled does nothing.
    if (submitting.current) return;
    submitting.current = true;

    const result = await actions.bookOnline({
      name,
      phone,
      doctorId,
      date,
      ...(sessionStart ? { sessionStart } : {}),
      ...(proof ? { verification: proof } : {}),
      ...(IS_SUPABASE && email.trim() ? { email: email.trim() } : {}),
    });
    if (result.ok) {
      rememberToken(result.value.id);
      // The booking is made. If an email address was given, the confirmation email is sent now and the next page
      // says honestly whether it went out.
      const emailOutcome = IS_SUPABASE && email.trim() ? await notifyBooking(result.value.id) : undefined;
      navigate(`/token/${result.value.id}`, { state: emailOutcome ? { email: emailOutcome } : undefined });
      return;
    }
    submitting.current = false;
    if (result.code === 'otp_required' || result.code === 'otp_expired' || (result.code === 'otp_invalid' && result.fieldErrors?.phone)) {
      // The clinic needs the number checked first, or the check has run out. The form stays as it is.
      setVerification(null);
      setVerifying(true);
      setFailure(result.code === 'otp_required' ? null : result);
      setFieldErrors({});
      return;
    }
    setFieldErrors(result.fieldErrors ?? {});
    setFailure(result);
    if (result.existingTokenId) rememberToken(result.existingTokenId);
    focusFirstError(formRef.current);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A check made for another number does not count for this one.
    const proof = verification && verification.phone === cleanPhone(phone) ? verification.id : undefined;
    void attempt(proof);
  }

  const closedNotice = (() => {
    if (!selected || availability.open) return null;
    const dayWord = day === 'today' ? 'today' : 'tomorrow';
    const other = day === 'today' ? 'tomorrow' : 'today';
    if (availability.reason === 'online_disabled') {
      return (
        <Notice kind="warning" title="Online booking is switched off.">
          Please come to the clinic reception to get a token.
        </Notice>
      );
    }
    if (availability.reason === 'closed') {
      const title =
        availability.closedReason === 'holiday'
          ? `The clinic is closed ${dayWord}.`
          : availability.closedReason === 'leave'
            ? `${selected.name} is not available ${dayWord}.`
            : `${selected.opd} has no OPD ${dayWord}.`;
      return (
        <Notice kind="warning" title={title}>
          You can try {other}{day === 'today' ? '' : ' or another day'}, or choose another OPD.
        </Notice>
      );
    }
    if (availability.reason === 'ended') {
      return (
        <Notice kind="warning" title={`Today's OPD for ${selected.opd} is over.`}>
          You can book a token for tomorrow.
        </Notice>
      );
    }
    if (availability.reason === 'doctor_unavailable') {
      return (
        <Notice kind="warning" title="This doctor is not available for booking.">
          Please choose another OPD or contact the clinic reception.
        </Notice>
      );
    }
    return (
      <Notice kind="warning" title={`All ${availability.limit} tokens are booked.`}>
        {selected.opd} has no tokens left for {dayWord}.
        {day === 'today' ? ' You can try tomorrow or another OPD.' : ' You can try today or another OPD.'}
      </Notice>
    );
  })();

  return (
    <>
      <PageHeader
        title="Book a token"
        intro={
          <>
            Get your place in the line from home. No app needed. <DemoTag />
          </>
        }
      />

      {booking.load !== 'ready' ? (
        <ClinicNotice load={booking.load} message={booking.message} />
      ) : doctors.length === 0 ? (
        <Notice kind="warning" title="No doctor is available for booking right now.">
          Please contact the clinic reception.
        </Notice>
      ) : (
        <form ref={formRef} onSubmit={submit} noValidate className="card">
          <fieldset>
            <legend>Choose a doctor or OPD</legend>
            <div className="choice-list">
              {doctors.map((doctor) => {
                const info = doctor[day];
                return (
                  <label className="choice" key={doctor.id}>
                    <input
                      type="radio"
                      name="doctor"
                      value={doctor.id}
                      checked={doctor.id === doctorId}
                      onChange={() => setDoctorChoice(doctor.id)}
                    />
                    <span className="choice__body">
                      <span className="choice__title">{doctor.opd}</span>
                      <br />
                      <span className="muted small">
                        {doctor.name}.{' '}
                        {timingsFor(doctor, day).length === 0
                          ? 'No OPD on this day.'
                          : `Timings: ${timingsFor(doctor, day).map(timing).join(' and ')}`}
                      </span>
                      <br />
                      <span className="small">{dayLine(info)}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <fieldset>
            <legend>Choose the day</legend>
            <div className="segmented">
              {(['today', 'tomorrow'] as const).map((choice) => (
                <label className="choice" key={choice}>
                  <input type="radio" name="day" value={choice} checked={day === choice} onChange={() => setDay(choice)} />
                  <span className="choice__body">
                    <span className="choice__title">{choice === 'today' ? 'Today' : 'Tomorrow'}</span>
                    <br />
                    <span className="muted small">
                      {formatDate(choice === 'today' ? today : booking.tomorrow)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {availability.open && slots.length > 1 && (
            <fieldset>
              <legend>Choose a session</legend>
              <div className="choice-list">
                {slots.map((slot) => (
                  <label className="choice" key={slot.start} aria-disabled={!slot.open || undefined}>
                    <input
                      type="radio"
                      name="session"
                      value={slot.start}
                      disabled={!slot.open}
                      checked={slot.start === sessionStart}
                      onChange={() => setSessionChoice(slot.start)}
                    />
                    <span className="choice__body">
                      <span className="choice__title">{timing(slot)}</span>
                      {!slot.open && (
                        <>
                          <br />
                          <span className="muted small">This session has ended.</span>
                        </>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <TextField
            label="Patient name"
            name="name"
            autoComplete="name"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={fieldErrors.name}
          />
          <TextField
            label="Mobile number"
            name="phone"
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            maxLength={16}
            prefix="+91"
            hint="10 digit number. Used only to find your token at the clinic."
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            error={fieldErrors.phone}
          />
          {IS_SUPABASE && (
            <TextField
              label="Email address (optional)"
              name="email"
              type="email"
              autoComplete="email"
              maxLength={254}
              hint="We will email your booking confirmation here. Leave it empty if you do not want an email."
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={fieldErrors.email}
            />
          )}

          <div className="stack">
            {closedNotice}
            {failure && !failure.fieldErrors && (
              <Notice kind="error" title={failure.message}>
                {failure.existingTokenId && (
                  <p>
                    <Link to={`/token/${failure.existingTokenId}`}>View the existing token</Link>
                  </p>
                )}
              </Notice>
            )}
            {failure?.fieldErrors && <Notice kind="error" title="Please fix the highlighted fields." />}
            <Button type="submit" variant="primary" size="lg" block icon={Ticket} disabled={!availability.open}>
              Book Token
            </Button>
          </div>
        </form>
      )}

      {verifying && (
        <div style={{ marginTop: 16 }}>
          <PhoneVerification
            purpose="booking"
            phone={phone}
            email={email}
            onCancel={() => setVerifying(false)}
            onVerified={({ verification: id, phone: verifiedPhone }) => {
              setVerification({ id, phone: verifiedPhone });
              setVerifying(false);
              // Verified: book straight away, so the patient does not have to press the button again.
              void attempt(id);
            }}
          />
        </div>
      )}

      <p style={{ marginTop: 24 }}>
        <ButtonLink to={`/queue${doctorId ? `?doctor=${doctorId}` : ''}`} icon={Users} block>
          View the live queue
        </ButtonLink>
      </p>
    </>
  );
}
