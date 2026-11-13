// Screen 3: Live queue (patient)

import { Radio, Ticket } from 'lucide-react';
import { useParams, useSearchParams } from 'react-router-dom';
import { ClinicNotice } from '../components/ClinicNotice';
import { MyPlaceCheck } from '../components/MyPlaceCheck';
import { TokenStatusNotice } from '../components/TokenStatusNotice';
import { ButtonLink, DemoTag, Notice, PageHeader, SelectField, TokenNumber } from '../components/ui';
import { IS_SUPABASE } from '../backend/mode';
import { formatTimeWithSeconds, relativeDayLabel } from '../domain/dates';
import { describeEstimate } from '../domain/queue';
import { useMyTokenIds } from '../state/hooks';
import { useBoard, useMyToken } from '../state/publicData';

export function LiveQueueScreen() {
  const { tokenId } = useParams();
  const [params, setParams] = useSearchParams();
  const myIds = useMyTokenIds();

  // Which token to follow: the one in the link, otherwise the newest one this device booked.
  const mine = useMyToken({ explicitKey: tokenId, remembered: myIds });
  const following = mine.data;
  const doctorParam = params.get('doctor');
  const board = useBoard(doctorParam, !following && mine.load !== 'loading');

  const loading = mine.load === 'loading' || (!following && board.load === 'loading');

  if (loading) {
    return (
      <>
        <PageHeader title="Live queue" />
        <ClinicNotice load="loading" />
      </>
    );
  }

  if (tokenId && !following) {
    if (mine.load === 'error') {
      return (
        <>
          <PageHeader title="Live queue" />
          <ClinicNotice load="error" message={mine.message} />
        </>
      );
    }
    return (
      <>
        <PageHeader title="Live queue" />
        <Notice kind="warning" title="We could not find this token.">
          {IS_SUPABASE ? 'Check the link you were given.' : 'It may have been removed when the demo data was reset.'}
        </Notice>
        <p style={{ marginTop: 16 }}>
          <ButtonLink to="/book" variant="primary" block icon={Ticket}>
            Book a token
          </ButtonLink>
        </p>
      </>
    );
  }

  if (!following && board.load !== 'ready') {
    return (
      <>
        <PageHeader title="Live queue" />
        <ClinicNotice load={board.load} message={board.message} />
      </>
    );
  }

  const doctor = following ? following.doctor : board.doctor;
  if (!doctor) {
    return (
      <>
        <PageHeader title="Live queue" />
        <Notice kind="warning" title="No queue is available right now." />
      </>
    );
  }

  const token = following?.token;
  const view = following?.view;
  const today = following ? following.today : board.today;
  const date = token?.date ?? today;
  const status = following ? following.status : board.status;
  const currentNumber = following ? following.currentNumber : board.currentNumber;
  const updatedAt = following ? mine.updatedAt : board.updatedAt;
  const isFuture = date > today;

  return (
    <>
      <PageHeader
        title="Live queue"
        intro={
          <>
            {doctor.opd}, {doctor.name}
            {doctor.specialization ? ` · ${doctor.specialization}` : ''} <DemoTag />
          </>
        }
      />

      {!token && (
        <SelectField
          label="Choose a queue"
          value={doctor.id}
          onChange={(e) => setParams({ doctor: e.target.value })}
        >
          {board.doctors.map((d) => (
            <option key={d.id} value={d.id}>
              {d.opd} ({d.name})
            </option>
          ))}
        </SelectField>
      )}

      <section className="card token-hero token-hero--dark" aria-label="Now serving">
        <p className="token-hero__label">{isFuture ? 'Queue not open yet' : 'Now serving'}</p>
        {currentNumber !== null ? (
          <TokenNumber number={currentNumber} className="token-hero__number" />
        ) : (
          <p style={{ fontSize: '1.5rem', margin: 0 }}>{isFuture ? 'Opens on the day' : 'No patient yet'}</p>
        )}
      </section>

      <div className="stack" style={{ marginTop: 16 }}>
        <div className="card">
          <dl className="facts">
            <dt>Queue status</dt>
            <dd>{status.label}</dd>
            <dt>Day</dt>
            <dd>{relativeDayLabel(date, today)}</dd>
          </dl>
        </div>

        {IS_SUPABASE && !token && board.estimate && (
          <section className="card" aria-labelledby="queue-numbers">
            <h2 id="queue-numbers">The queue right now</h2>
            {(status.code === 'closed' || !board.estimate.queueOpen) && (
              <div style={{ marginBottom: 12 }}>
                <Notice kind="warning" title={status.code === 'closed' ? status.label : 'The queue is closed for today.'}>
                  <p>You can still book a token for another day.</p>
                </Notice>
              </div>
            )}
            <dl className="queue-stats">
              <div>
                <dt>Waiting</dt>
                <dd>{board.waitingCount ?? 0}</dd>
              </div>
              <div>
                <dt>Doctor</dt>
                <dd>{board.consulting ? 'With a patient' : board.onBreak ? 'On a short break' : 'Not with a patient'}</dd>
              </div>
              {board.estimate.queueOpen && !isFuture && (
                <div>
                  <dt>Wait if you book now</dt>
                  <dd>
                    {board.estimate.waitForNewBookingMinutes === 0 ? 'No wait' : `About ${board.estimate.waitForNewBookingMinutes} min`}
                    <span className="muted small"> (estimate)</span>
                  </dd>
                </div>
              )}
            </dl>
            <p className="muted small" style={{ margin: '12px 0 0' }}>
              Estimates use {board.estimate.minutesPerPatient} minutes per patient. They are guesses and change during the day.
            </p>
          </section>
        )}

        {token && view ? (
          <section className="card" aria-label="Your token">
            <div className="row row--between" style={{ marginBottom: 8 }}>
              <h2 style={{ margin: 0 }}>
                Your token <TokenNumber number={token.number} />
              </h2>
              {view.patientsAhead !== null && (
                <strong>{view.patientsAhead === 0 ? 'Your turn' : `${view.patientsAhead} ahead`}</strong>
              )}
            </div>

            {view.patientsAhead !== null && (
              <>
                <div
                  className="meter"
                  role="progressbar"
                  aria-label="Progress of the line in front of you"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(view.progress * 100)}
                >
                  <div className="meter__fill" style={{ width: `${Math.round(view.progress * 100)}%` }} />
                </div>
                <dl className="facts" style={{ marginTop: 16 }}>
                  <dt>Patients ahead</dt>
                  <dd>{view.patientsAhead}</dd>
                  <dt>Estimated wait</dt>
                  <dd>
                    {view.estimatedWaitMinutes === 0 ? 'No wait' : `About ${view.estimatedWaitMinutes} minutes`}{' '}
                    <span className="muted">(estimate)</span>
                  </dd>
                  <dt>Estimated time</dt>
                  <dd>
                    {describeEstimate(view)} <span className="muted">(estimate)</span>
                  </dd>
                </dl>
                <p className="muted small" style={{ margin: '12px 0 0' }}>
                  Estimates use {view.minutesPerPatient} minutes per patient and can change.
                </p>
              </>
            )}
            <div style={{ marginTop: 12 }}>
              <TokenStatusNotice token={token} />
            </div>
          </section>
        ) : (
          <section className="card" aria-label="Your token">
            <h2>Your token</h2>
            <p className="muted">You do not have a token for this queue on this device.</p>
            <ButtonLink to="/book" variant="primary" icon={Ticket} block>
              Book a token
            </ButtonLink>
          </section>
        )}

        {IS_SUPABASE && !token && <MyPlaceCheck doctorId={doctor.id} />}

        <p className="live-line">
          <span className="live-dot">
            <Radio size={16} aria-hidden="true" />
            Live
          </span>
          <span>Last updated {formatTimeWithSeconds(updatedAt)}</span>
          <span>
            {IS_SUPABASE
              ? 'The screen is checked every 10 seconds.'
              : 'Changes appear at once and the screen is also checked every 10 seconds.'}
          </span>
        </p>
      </div>
    </>
  );
}
