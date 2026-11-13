// Screen 2: Token confirmation (patient)

import { CircleCheck, Users } from 'lucide-react';
import { useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { IS_SUPABASE } from '../backend/mode';
import { notifyCancellation, type BookingEmailOutcome } from '../backend/verification';
import { ConfirmDialog } from '../components/Dialog';
import { TokenStatusNotice } from '../components/TokenStatusNotice';
import { Button, ButtonLink, DemoTag, EmptyState, LiveRegion, Notice, PageHeader, TokenNumber } from '../components/ui';
import { ClinicNotice } from '../components/ClinicNotice';
import { formatDate, formatMinutes, parseHM, relativeDayLabel } from '../domain/dates';
import { describeEstimate } from '../domain/queue';
import { useActions } from '../state/context';
import { useMyToken } from '../state/publicData';

export function ConfirmScreen() {
  const { tokenId = '' } = useParams();
  const mine = useMyToken({ explicitKey: tokenId, remembered: [] });
  const actions = useActions();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [cancelled, setCancelled] = useState(false);
  // What happened to the confirmation email, told to this page when the booking was made. Nothing is claimed otherwise.
  const location = useLocation();
  const bookingEmail = (location.state as { email?: BookingEmailOutcome } | null)?.email;
  const [cancelEmail, setCancelEmail] = useState<BookingEmailOutcome | null>(null);

  if (mine.load === 'loading') {
    return (
      <>
        <PageHeader title="Your token" />
        <ClinicNotice load="loading" />
      </>
    );
  }
  if (mine.load === 'error') {
    return (
      <>
        <PageHeader title="Your token" />
        <ClinicNotice load="error" message={mine.message} />
      </>
    );
  }
  if (!mine.data) {
    return (
      <>
        <PageHeader title="Token not found" />
        <EmptyState title="We could not find this token.">
          <p>{IS_SUPABASE ? 'Check the link you were given, or book a new token.' : 'It may have been removed when the demo data was reset.'}</p>
        </EmptyState>
        <p style={{ marginTop: 16 }}>
          <ButtonLink to="/book" variant="primary" block>
            Book a new token
          </ButtonLink>
        </p>
      </>
    );
  }

  const { token, view, today } = mine.data;
  const doctor = view.doctor;
  const queued = token.status === 'waiting';
  const firstName = mine.data.firstName || undefined;

  async function cancel() {
    const result = await actions.cancelOwnToken(token.id);
    setConfirming(false);
    if (result.ok) {
      setCancelled(true);
      setError('');
      mine.refresh();
      // Cancelled. If the patient gave an email address when booking, a notice goes there and we say how it went.
      if (IS_SUPABASE) void notifyCancellation(token.id).then(setCancelEmail);
    } else {
      setError(result.message);
    }
  }

  return (
    <>
      <PageHeader
        title={queued ? 'Token booked' : 'Your token'}
        intro={
          <>
            <DemoTag /> Keep this page or note the number.
          </>
        }
      />

      <section className="card token-hero" aria-label="Your token">
        {queued && <CircleCheck size={40} color="#0f6b6b" aria-hidden="true" />}
        <p className="token-hero__label">Your token</p>
        <TokenNumber number={token.number} className="token-hero__number" />
      </section>

      <div className="stack" style={{ marginTop: 16 }}>
        <LiveRegion>
          {cancelled && <Notice kind="success" title={`Token #${token.number} was cancelled.`} />}
          {cancelled && cancelEmail && cancelEmail.status !== 'skipped' && (
            <Notice kind={cancelEmail.status === 'sent' ? 'success' : 'warning'}>
              {cancelEmail.status === 'sent'
                ? 'We emailed you a cancellation notice.'
                : `${cancelEmail.message ?? 'We could not send the cancellation email.'} Your token is cancelled all the same.`}
            </Notice>
          )}
          {!cancelled && bookingEmail && bookingEmail.status !== 'skipped' && (
            <Notice kind={bookingEmail.status === 'sent' ? 'success' : 'warning'}>
              {bookingEmail.status === 'sent'
                ? 'We emailed your booking confirmation. If you do not see it, check your spam folder.'
                : `${bookingEmail.message ?? 'We could not send the confirmation email.'} Your token is booked all the same. Keep this page.`}
            </Notice>
          )}
          {error && <Notice kind="error" title={error} />}
        </LiveRegion>
        {!cancelled && <TokenStatusNotice token={token} />}

        <div className="card">
          <dl className="facts">
            {firstName && (
              <>
                <dt>Booked for</dt>
                <dd>{firstName}</dd>
              </>
            )}
            <dt>OPD</dt>
            <dd>{`${doctor.opd}, ${doctor.name}`}</dd>
            <dt>Date</dt>
            <dd>
              {relativeDayLabel(token.date, today)}, {formatDate(token.date)}
            </dd>
            {token.session && (
              <>
                <dt>Session</dt>
                <dd>{`${formatMinutes(parseHM(token.session.start))} to ${formatMinutes(parseHM(token.session.end))}`}</dd>
              </>
            )}
            {queued && (
              <>
                <dt>Estimated time</dt>
                <dd>
                  {describeEstimate(view)} <span className="muted">(estimate)</span>
                </dd>
                <dt>Patients ahead</dt>
                <dd>{view.patientsAhead}</dd>
              </>
            )}
          </dl>
          {queued && (
            <p className="muted small" style={{ marginTop: 12, marginBottom: 0 }}>
              The time is an estimate based on {view.minutesPerPatient} minutes per patient. It changes as the queue
              moves.
            </p>
          )}
        </div>

        <Notice kind="info" live={false}>
          {IS_SUPABASE
            ? 'No SMS or WhatsApp message is sent. Keep this page, or note your token number. Anyone with this page address can see your token.'
            : 'No SMS or WhatsApp message is sent in this demo. Please note your token number.'}
        </Notice>

        <ButtonLink to={`/queue/${token.id}`} variant="primary" size="lg" block icon={Users}>
          View live queue
        </ButtonLink>

        {queued && !cancelled && (
          <Button block onClick={() => setConfirming(true)}>
            Cancel this token
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirming}
        title={`Cancel token #${token.number}?`}
        confirmLabel="Cancel token"
        danger
        onCancel={() => setConfirming(false)}
        onConfirm={() => void cancel()}
      >
        <p>You will lose your place in the line. You can book a new token afterwards if tokens are still available.</p>
      </ConfirmDialog>
    </>
  );
}
