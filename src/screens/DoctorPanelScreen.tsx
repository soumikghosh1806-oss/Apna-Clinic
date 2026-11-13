// Screen 7: Doctor panel, next patient

import { Check, History, Pause, Play, SkipForward, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Button,
  CardTitle,
  DemoTag,
  LiveRegion,
  Notice,
  PageHeader,
  StatusBadge,
  TokenNumber,
} from '../components/ui';
import { toDateKey } from '../domain/dates';
import {
  currentToken,
  getDoctor,
  getPatient,
  ordinal,
  tokensWithStatus,
  upcomingTokens,
  visitNumber,
  waitingTokens,
} from '../domain/queue';
import type { Result, Token } from '../domain/types';
import { useActions, useAuth } from '../state/context';
import { useLiveQueue } from '../state/hooks';

/** After NEXT is pressed the button stays locked for this long, so a double tap cannot advance two patients. */
const NEXT_LOCK_MS = 900;

type Message = { kind: 'success' | 'error' | 'info'; text: string };

export function DoctorPanelScreen() {
  const { session } = useAuth();
  const { state, now } = useLiveQueue();
  const actions = useActions();
  const [message, setMessage] = useState<Message | null>(null);
  const [locked, setLocked] = useState(false);
  const lock = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const doctor = session?.doctorId ? getDoctor(state, session.doctorId) : undefined;
  if (!doctor || !doctor.active) {
    return (
      <>
        <PageHeader title="Next patient" />
        <Notice kind="warning" title="This doctor account is not linked to an active OPD.">
          Ask the clinic owner to check the doctor list in Settings.
        </Notice>
      </>
    );
  }

  const today = toDateKey(now);
  const current = currentToken(state, doctor.id, today);
  const currentPatient = current ? getPatient(state, current.patientId) : undefined;
  const upcoming = upcomingTokens(state, doctor.id, today, 3);
  const waitingCount = waitingTokens(state, doctor.id, today).length;
  const completedCount = tokensWithStatus(state, doctor.id, today, 'completed').length;
  const held = tokensWithStatus(state, doctor.id, today, 'on_hold');
  const skipped = tokensWithStatus(state, doctor.id, today, 'skipped');
  const first = upcoming[0];
  const canNext = Boolean(current || first);

  async function report(pending: Promise<Result<Token>>, success: (t: Token) => string) {
    const result = await pending;
    setMessage(result.ok ? { kind: 'success', text: success(result.value) } : { kind: 'error', text: result.message });
  }

  async function pressNext() {
    if (lock.current) return;
    lock.current = true;
    setLocked(true);
    timer.current = window.setTimeout(() => {
      lock.current = false;
      setLocked(false);
    }, NEXT_LOCK_MS);

    const result = await actions.callNext(doctor!.id, current?.id ?? null);
    if (!result.ok) {
      setMessage({ kind: result.code === 'empty' ? 'info' : 'error', text: result.message });
      return;
    }
    const { completed, called } = result.value;
    if (called && completed) setMessage({ kind: 'success', text: `Finished #${completed.number}. Now calling #${called.number}.` });
    else if (called) setMessage({ kind: 'success', text: `Now calling #${called.number}.` });
    else if (completed) setMessage({ kind: 'success', text: `Finished #${completed.number}. No other patient is waiting.` });
  }

  const nextHint = current
    ? first
      ? `Finishes #${current.number} and calls #${first.number}`
      : `Finishes #${current.number}. No other patient is waiting`
    : first
      ? `Calls #${first.number}`
      : 'No patient is waiting';

  return (
    <>
      <PageHeader
        title="Next patient"
        intro={
          <>
            {doctor.opd}, {doctor.name} <DemoTag />
          </>
        }
      />

      <div className="grid grid--2">
        <div className="stack">
          <section className="card" aria-label="Current patient">
            <p className="kpi__label">Now with the doctor</p>
            {current && currentPatient ? (
              <div className="stack">
                <div>
                  <TokenNumber number={current.number} className="token-hero__number" />
                  <p style={{ margin: '8px 0 0', fontSize: '1.25rem' }}>
                    <strong>{currentPatient.name}</strong>
                    <span className="muted"> . {ordinal(visitNumber(state, current))} visit</span>
                  </p>
                </div>
                <div className="row">
                  <Link className="btn btn--sm" to={`/doctor/history/${currentPatient.id}`}>
                    <History size={16} aria-hidden="true" />
                    Patient history
                  </Link>
                </div>
                <div className="row">
                  <Button icon={Check} onClick={() => report(actions.complete(current.id), (t) => `Finished #${t.number}.`)}>
                    Mark completed
                  </Button>
                  <Button icon={SkipForward} onClick={() => report(actions.skip(current.id), (t) => `Skipped #${t.number}.`)}>
                    Skip patient
                  </Button>
                  <Button icon={Pause} onClick={() => report(actions.hold(current.id), (t) => `#${t.number} is on hold.`)}>
                    Hold
                  </Button>
                </div>
              </div>
            ) : (
              <p className="muted" style={{ fontSize: '1.125rem', margin: 0 }}>
                No patient is with the doctor. {first ? 'Press NEXT to call the first patient.' : 'No patient is waiting.'}
              </p>
            )}
          </section>

          <div>
            <Button
              variant="primary"
              size="lg"
              block
              icon={Play}
              onClick={() => void pressNext()}
              disabled={!canNext || locked}
              aria-describedby="next-hint"
            >
              NEXT
            </Button>
            <p className="muted small" id="next-hint" style={{ margin: '8px 0 0' }}>
              {nextHint}
            </p>
          </div>

          <LiveRegion>{message && <Notice kind={message.kind} title={message.text} />}</LiveRegion>
        </div>

        <div className="stack">
          <section className="card" aria-label="Next in line">
            <CardTitle>Next in line</CardTitle>
            {upcoming.length === 0 ? (
              <p className="muted">No patient is waiting.</p>
            ) : (
              <ol className="list-plain next-three">
                {upcoming.map((token) => {
                  const patient = getPatient(state, token.patientId);
                  return (
                    <li key={token.id}>
                      <TokenNumber number={token.number} />
                      <span className="grow" style={{ flex: '1 1 auto', minWidth: 0 }}>
                        <strong>{patient?.name}</strong>
                        <br />
                        <span className="muted small">{token.arrivedAt ? 'Arrived' : 'Not arrived yet'}</span>
                      </span>
                      <Button
                        size="sm"
                        icon={SkipForward}
                        onClick={() => report(actions.skip(token.id), (t) => `Skipped #${t.number}.`)}
                      >
                        Skip<span className="sr-only"> token {token.number}</span>
                      </Button>
                    </li>
                  );
                })}
              </ol>
            )}
            <p className="muted small" style={{ margin: '12px 0 0' }}>
              {waitingCount} waiting. {completedCount} completed today.
            </p>
          </section>

          <section className="card" aria-label="On hold">
            <CardTitle>On hold</CardTitle>
            {held.length === 0 ? (
              <p className="muted">No patient is on hold.</p>
            ) : (
              <ul className="list-plain list-rows">
                {held.map((token) => (
                  <li key={token.id}>
                    <TokenNumber number={token.number} />
                    <span className="grow">{getPatient(state, token.patientId)?.name}</span>
                    <StatusBadge status="on_hold" />
                    <Button
                      size="sm"
                      icon={Play}
                      onClick={() =>
                        report(actions.resume(token.id), (t) => `#${t.number} is first in line. Press NEXT to call them.`)
                      }
                    >
                      Resume<span className="sr-only"> token {token.number}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-label="Skipped">
            <CardTitle>Skipped</CardTitle>
            {skipped.length === 0 ? (
              <p className="muted">No patient was skipped.</p>
            ) : (
              <ul className="list-plain list-rows">
                {skipped.map((token) => (
                  <li key={token.id}>
                    <TokenNumber number={token.number} />
                    <span className="grow">{getPatient(state, token.patientId)?.name}</span>
                    <StatusBadge status="skipped" />
                    <Button
                      size="sm"
                      icon={Undo2}
                      onClick={() => report(actions.requeue(token.id), (t) => `#${t.number} is back at the end of the line.`)}
                    >
                      Return to queue<span className="sr-only"> token {token.number}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
