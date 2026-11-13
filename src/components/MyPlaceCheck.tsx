// "Check my place": a patient who has no link to their token proves their mobile number with a text message code and
// then sees where their own tokens stand with this doctor today. They see numbers and estimates only: no names, no
// phone numbers, no other patient. The proof lasts 30 minutes; after that the code step comes back.

import { Radio } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useClinicSlug } from '../backend/clinicRoute';
import { mapMyPosition, type MyPlace } from '../backend/mappers';
import { rpc } from '../backend/rpc';
import { useRemote } from '../backend/useRemote';
import { formatTime, formatTimeWithSeconds } from '../domain/dates';
import { Button, Notice, StatusBadge, TokenNumber } from './ui';
import { PhoneVerification } from './PhoneVerification';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function PlaceRow({ place }: { place: MyPlace }) {
  const waiting = place.patientsAhead !== null;
  return (
    <li>
      <div className="row row--between">
        <h3 style={{ margin: 0 }}>
          Token <TokenNumber number={place.number} />
        </h3>
        <StatusBadge status={place.status} />
      </div>
      {waiting ? (
        <dl className="facts" style={{ marginTop: 12 }}>
          <dt>Patients ahead</dt>
          <dd>{place.patientsAhead === 0 ? 'Your turn' : place.patientsAhead}</dd>
          <dt>Estimated wait</dt>
          <dd>
            {place.estimatedWaitMinutes === 0 ? 'No wait' : `About ${place.estimatedWaitMinutes} minutes`} <span className="muted">(estimate)</span>
          </dd>
          {place.estimatedTime && (
            <>
              <dt>Estimated time</dt>
              <dd>
                {formatTime(place.estimatedTime.at)}
                {place.estimatedTime.outsideHours ? ' (after OPD hours)' : ''} <span className="muted">(estimate)</span>
              </dd>
            </>
          )}
        </dl>
      ) : (
        <p className="muted" style={{ margin: '8px 0 0' }}>
          {place.status === 'completed' ? 'This visit is done.' : 'This token is no longer waiting in the queue.'}
        </p>
      )}
    </li>
  );
}

export function MyPlaceCheck({ doctorId }: { doctorId: string }) {
  const slug = useClinicSlug();
  const [asking, setAsking] = useState(false);
  const [proof, setProof] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  const remote = useRemote(
    async () => {
      const answer = await rpc('get_my_position', { p_slug: slug ?? '', p_doctor_id: UUID.test(doctorId) ? doctorId : null, p_verification: proof });
      return answer.ok ? { ok: true as const, value: mapMyPosition(answer.data) } : answer;
    },
    [slug, doctorId, proof],
    { enabled: slug !== null && proof !== null && UUID.test(doctorId), intervalMs: 10000 },
  );

  // The proof ran out (30 minutes) or was refused: start again from the code step.
  const proofLost = proof !== null && remote.failure !== null && (remote.failure.code === 'otp_expired' || remote.failure.code === 'otp_required');
  useEffect(() => {
    if (!proofLost) return;
    setProof(null);
    setEnded(true);
    setAsking(true);
  }, [proofLost]);

  if (proof === null && !asking) {
    return (
      <section className="card" aria-labelledby="my-place-title">
        <h2 id="my-place-title">Already booked?</h2>
        <p className="muted">
          If you do not have the link to your token, verify your mobile number with a text message code to see your own place in this queue.
        </p>
        <Button onClick={() => setAsking(true)}>Check my place in the queue</Button>
      </section>
    );
  }

  if (proof === null) {
    return (
      <>
        {ended && <Notice kind="info" title="Your verification has ended. Verify again to see your place." />}
        <PhoneVerification
          purpose="position"
          onCancel={() => {
            setAsking(false);
            setEnded(false);
          }}
          onVerified={({ verification }) => {
            setProof(verification);
            setAsking(false);
            setEnded(false);
          }}
        />
      </>
    );
  }

  const data = remote.data;
  return (
    <section className="card" aria-labelledby="my-place-title">
      <h2 id="my-place-title">Your place today</h2>
      {!data && !remote.failure && (
        <p className="muted" role="status">
          Loading...
        </p>
      )}
      {remote.failure && !data && <Notice kind="error" title={remote.failure.message} />}
      {data && data.places.length === 0 && (
        <Notice kind="info" live={false} title="No token found for this number with this doctor today.">
          <p>If you booked with a different number or for another doctor or day, check that queue instead.</p>
        </Notice>
      )}
      {data && data.places.length > 0 && (
        <ul className="my-places">
          {data.places.map((p) => (
            <PlaceRow key={p.number} place={p} />
          ))}
        </ul>
      )}
      <p className="live-line">
        <span className="live-dot">
          <Radio size={16} aria-hidden="true" />
          Live
        </span>
        <span>Last updated {formatTimeWithSeconds(remote.updatedAt ?? new Date())}</span>
      </p>
      <Button size="sm" onClick={() => setProof(null)}>
        Done
      </Button>
    </section>
  );
}
