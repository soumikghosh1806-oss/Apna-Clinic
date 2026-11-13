// Screen 5: Walk-in entry (reception)

import { Printer, UserPlus } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { IS_SUPABASE } from '../backend/mode';
import { Button, ButtonLink, DemoTag, Notice, PageHeader, SelectField, TextField, TokenNumber } from '../components/ui';
import { formatDate, formatTime, toDateKey } from '../domain/dates';
import { activeDoctors, dailyLimitFor, describeEstimate, getDoctor, getToken, issuedCount, queueView } from '../domain/queue';
import type { Failure, Token } from '../domain/types';
import { useActions } from '../state/context';
import { useFocusFirstError, useLiveQueue } from '../state/hooks';

export function WalkInScreen() {
  const { state, now } = useLiveQueue();
  const actions = useActions();
  const focusFirstError = useFocusFirstError();
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);

  const doctors = activeDoctors(state);
  const [doctorChoice, setDoctorChoice] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [overLimit, setOverLimit] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const today = toDateKey(now);
  const doctorId = doctors.some((d) => d.id === doctorChoice) ? doctorChoice : (doctors[0]?.id ?? '');
  const doctor = getDoctor(state, doctorId);
  const limit = doctor ? dailyLimitFor(state, doctor) : 0;
  const issued = doctor ? issuedCount(state, doctor.id, today) : 0;
  const full = Boolean(doctor) && issued >= limit;

  // The panel on the right always reads the token from shared state, so it stays correct if the queue moves.
  const created: Token | undefined = createdId ? getToken(state, createdId) : undefined;
  const createdView = created ? queueView(state, created, now) : undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;

    const result = await actions.addWalkIn({ name, phone, doctorId, allowOverLimit: overLimit });
    submitting.current = false;
    if (result.ok) {
      setCreatedId(result.value.id);
      setName('');
      setPhone('');
      setOverLimit(false);
      setFieldErrors({});
      setFailure(null);
      nameRef.current?.focus();
      return;
    }
    setFieldErrors(result.fieldErrors ?? {});
    setFailure(result);
    focusFirstError(formRef.current);
  }

  return (
    <>
      <PageHeader
        title="Walk-in entry"
        intro={
          <>
            Create a token for a patient who comes to the clinic. They join the same line as online bookings. <DemoTag />
          </>
        }
      />

      {!state.settings.onlineBookingEnabled && (
        <div style={{ marginBottom: 16 }}>
          <Notice kind="info" title="Online booking is switched off." live={false}>
            Walk-in entry still works.
          </Notice>
        </div>
      )}

      <div className="grid grid--2">
        <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate className="card" aria-label="New walk-in patient">
          <TextField
            ref={nameRef}
            label="Patient name"
            name="name"
            autoComplete="off"
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
            autoComplete="off"
            prefix="+91"
            maxLength={16}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            error={fieldErrors.phone}
          />
          <SelectField
            label="Doctor or OPD"
            value={doctorId}
            onChange={(e) => {
              setDoctorChoice(e.target.value);
              setOverLimit(false);
            }}
          >
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.opd} ({d.name})
              </option>
            ))}
          </SelectField>

          <div className="stack">
            {doctor && (
              <p className="muted small" style={{ margin: 0 }}>
                {issued} of {limit} tokens issued today for {doctor.opd}.
              </p>
            )}
            {full && (
              <Notice kind="warning" title={`The daily limit of ${limit} tokens for ${doctor?.opd} is reached.`}>
                <label className="switch">
                  <input type="checkbox" checked={overLimit} onChange={(e) => setOverLimit(e.target.checked)} />
                  <span>Issue this token anyway</span>
                </label>
              </Notice>
            )}
            {failure && !failure.fieldErrors && (
              <Notice kind="error" title={failure.message}>
                {failure.existingTokenId && (
                  <p>
                    <Link to="/reception">Open today's list</Link>
                  </p>
                )}
              </Notice>
            )}
            {failure?.fieldErrors && <Notice kind="error" title="Please fix the highlighted fields." />}
            <Button type="submit" variant="primary" size="lg" block icon={UserPlus} disabled={!doctor || (full && !overLimit)}>
              Create token
            </Button>
          </div>
        </form>

        <section className="card" aria-label="New token" aria-live="polite">
          {created && createdView ? (
            <div className="stack">
              <div className="token-hero" style={{ padding: 0 }}>
                <p className="token-hero__label">New token</p>
                <TokenNumber number={created.number} className="token-hero__number" />
              </div>
              <Notice kind="success" title={`Token #${created.number} was added to the line.`} />
              <dl className="facts">
                <dt>OPD</dt>
                <dd>{createdView.doctor.opd}</dd>
                <dt>Patients ahead</dt>
                <dd>{createdView.patientsAhead ?? 'Not queued'}</dd>
                {createdView.patientsAhead !== null && (
                  <>
                    <dt>Estimated time</dt>
                    <dd>
                      {describeEstimate(createdView)} <span className="muted">(estimate)</span>
                    </dd>
                  </>
                )}
              </dl>
              <div className="row">
                <Button icon={Printer} onClick={() => window.print()}>
                  Print token slip
                </Button>
                <ButtonLink to="/reception">View in today's list</ButtonLink>
              </div>
              <p className="muted small" style={{ margin: 0 }}>
                Printing uses this browser's print dialog. {IS_SUPABASE ? 'No SMS is sent.' : 'No SMS is sent in this demo.'}
              </p>
            </div>
          ) : (
            <>
              <h2>New token</h2>
              <p className="muted">The token number appears here after you press Create token.</p>
            </>
          )}
        </section>
      </div>

      {created && createdView && (
        <div className="slip" aria-hidden="true">
          <p>
            <strong>{state.settings.clinicName}</strong>
            <br />
            {IS_SUPABASE ? 'Token slip' : 'Demo token slip. Sample data.'}
          </p>
          <p>
            {createdView.doctor.opd}
            <br />
            {formatDate(created.date)}, {formatTime(new Date(created.createdAt))}
          </p>
          <p className="slip__number">#{created.number}</p>
          <p>Patients ahead: {createdView.patientsAhead ?? 0}</p>
        </div>
      )}
    </>
  );
}
