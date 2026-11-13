// The owner's editor for one doctor's OPD timetable (real backend only).
//
//   * Weekly timings: any start and end time (the time box takes typing or the browser's picker), several timings a
//     day, a break inside a timing, a closed day, and copy one day to others.
//   * Leave and holidays, different timings for one date, and extra sessions.
//   * Changes that would leave booked patients outside the new timings are explained first. Nothing is cancelled,
//     and the owner decides whether to go ahead.
//
// Times are wall clock times in the clinic's own time zone.

import { CalendarPlus, Copy, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { formatShortDate } from '../domain/dates';
import {
  describeConflict,
  describeDay,
  nextSession,
  sameSchedule,
  sessionsProblem,
  sortSessions,
  weeklyProblems,
  WEEKDAY_NAMES,
  WEEK_ORDER,
  copyDay,
  describeSession,
  REASON_MAX,
  type DoctorSchedule,
  type ExceptionKind,
  type ScheduleException,
  type WeekdayNumber,
  type WeeklySchedule,
} from '../domain/schedule';
import type { DateKey, Doctor, Failure, ScheduleConflict, TimedSession } from '../domain/types';
import { useActions } from '../state/context';
import { Button, LiveRegion, Notice, SelectField, TextField } from './ui';

// ---------------------------------------------------------------------------------------------------------------
// Timings for one day
// ---------------------------------------------------------------------------------------------------------------

interface SessionRowsProps {
  /** Unique within the page, so labels point at the right box. */
  idPrefix: string;
  /** Spoken to screen readers: "Monday". */
  dayLabel: string;
  sessions: TimedSession[];
  onChange: (next: TimedSession[]) => void;
  invalid?: boolean;
  describedBy?: string;
}

function TimeBox({ id, label, value, onChange, invalid, describedBy }: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  describedBy?: string;
}) {
  return (
    <div className="sched-time">
      <div className="field">
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          className="input"
          type="time"
          value={value}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}

export function SessionRows({ idPrefix, dayLabel, sessions, onChange, invalid, describedBy }: SessionRowsProps) {
  const set = (index: number, patch: Partial<TimedSession>) =>
    onChange(sessions.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  const withoutBreak = (s: TimedSession): TimedSession => ({ start: s.start, end: s.end });

  return (
    <div>
      {sessions.map((session, index) => {
        const n = index + 1;
        const hasBreak = session.breakStart !== undefined || session.breakEnd !== undefined;
        return (
          <div className="sched-session" key={index}>
            <TimeBox
              id={`${idPrefix}-start-${index}`}
              label={`From${sessions.length > 1 ? ` (timing ${n})` : ''}`}
              value={session.start}
              onChange={(v) => set(index, { start: v })}
              invalid={invalid}
              describedBy={describedBy}
            />
            <TimeBox
              id={`${idPrefix}-end-${index}`}
              label={`To${sessions.length > 1 ? ` (timing ${n})` : ''}`}
              value={session.end}
              onChange={(v) => set(index, { end: v })}
              invalid={invalid}
              describedBy={describedBy}
            />
            <Button
              size="sm"
              variant="quiet"
              onClick={() => onChange(sessions.map((s, i) => (i === index ? (hasBreak ? withoutBreak(s) : { ...s, breakStart: '', breakEnd: '' }) : s)))}
              aria-expanded={hasBreak}
            >
              {hasBreak ? 'No break' : 'Add a break'}
              <span className="sr-only">
                {' '}
                for {dayLabel} timing {n}
              </span>
            </Button>
            <Button size="sm" variant="quiet" icon={X} onClick={() => onChange(sessions.filter((_, i) => i !== index))}>
              Remove<span className="sr-only"> {dayLabel} timing {n}</span>
            </Button>
            {hasBreak && (
              <div className="sched-break">
                <TimeBox
                  id={`${idPrefix}-bstart-${index}`}
                  label={`Break from${sessions.length > 1 ? ` (timing ${n})` : ''}`}
                  value={session.breakStart ?? ''}
                  onChange={(v) => set(index, { breakStart: v })}
                  invalid={invalid}
                  describedBy={describedBy}
                />
                <TimeBox
                  id={`${idPrefix}-bend-${index}`}
                  label={`Break to${sessions.length > 1 ? ` (timing ${n})` : ''}`}
                  value={session.breakEnd ?? ''}
                  onChange={(v) => set(index, { breakEnd: v })}
                  invalid={invalid}
                  describedBy={describedBy}
                />
              </div>
            )}
          </div>
        );
      })}
      <Button size="sm" icon={Plus} onClick={() => onChange([...sessions, nextSession(sessions)])}>
        Add timing<span className="sr-only"> for {dayLabel}</span>
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The warning shown before a change affects booked patients
// ---------------------------------------------------------------------------------------------------------------

interface PendingWarning {
  message: string;
  conflicts: ScheduleConflict[];
  confirmLabel: string;
  run: () => Promise<void>;
}

function ConflictWarning({ warning, busy, onCancel }: { warning: PendingWarning; busy: boolean; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Move focus to the warning so it is read out and the next Tab lands on its buttons.
  useEffect(() => ref.current?.focus(), []);
  return (
    <div ref={ref} className="sched-warning stack stack--sm" tabIndex={-1} role="alertdialog" aria-labelledby="sched-warning-title" aria-describedby="sched-warning-text">
      <Notice kind="warning" live={false}>
        <p id="sched-warning-title">
          <strong>Some booked patients are affected</strong>
        </p>
        <p id="sched-warning-text">{warning.message}</p>
        <ul>
          {warning.conflicts.map((c, i) => (
            <li key={`${c.doctorId}-${c.date}-${c.session?.start ?? i}`}>{describeConflict(c, formatShortDate)}</li>
          ))}
        </ul>
      </Notice>
      <div className="row">
        <Button variant="primary" disabled={busy} onClick={() => void warning.run()}>
          {busy ? 'Saving...' : warning.confirmLabel}
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          Go back, change nothing
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------------------------------------------

interface ScheduleEditorProps {
  doctor: Doctor;
  onClose: () => void;
}

export function ScheduleEditor({ doctor, onClose }: ScheduleEditorProps) {
  const actions = useActions();
  const [schedule, setSchedule] = useState<DoctorSchedule | null>(null);
  const [loadError, setLoadError] = useState('');
  const [weekly, setWeekly] = useState<WeeklySchedule | null>(null);
  const [saved, setSaved] = useState<WeeklySchedule | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [warning, setWarning] = useState<PendingWarning | null>(null);

  const load = useCallback(async () => {
    const result = await actions.getSchedule(doctor.id);
    if (!result.ok) {
      setLoadError(result.message);
      return;
    }
    setLoadError('');
    setSchedule(result.value);
    setWeekly(result.value.weekly);
    setSaved(result.value.weekly);
  }, [actions, doctor.id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Shows what a refused change means, or the plain error. Returns true when it was a booked-patients warning. */
  function explain(failure: Failure, confirmLabel: string, run: () => Promise<void>): void {
    if (failure.code === 'schedule_conflict') {
      setError('');
      setWarning({ message: failure.message, conflicts: failure.conflicts ?? [], confirmLabel, run });
    } else {
      setWarning(null);
      setError(failure.message);
    }
  }

  async function saveWeek(confirm: boolean) {
    if (!weekly || busy) return;
    setBusy(true);
    setMessage('');
    const result = await actions.saveWeeklySchedule(doctor.id, weekly, confirm);
    setBusy(false);
    if (!result.ok) {
      explain(result, 'Save anyway and keep those bookings', () => saveWeek(true));
      return;
    }
    setWarning(null);
    setError('');
    setMessage(
      result.value.kept.length > 0
        ? 'Weekly timings saved. The booked patients listed above keep their tokens and stay in the queue.'
        : 'Weekly timings saved. Booking and the queue use them from now on.',
    );
    await load();
  }

  if (loadError) return <Notice kind="error" title={loadError} />;
  if (!schedule || !weekly || !saved) return <p role="status">Loading the timetable...</p>;

  const problems = weeklyProblems(weekly);
  const hasProblems = Object.keys(problems).length > 0;
  const changed = !sameSchedule(weekly, saved);

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        {doctor.name}, {doctor.opd}. All times are in the clinic's time zone ({schedule.timezone}). Patients can book only
        inside these timings, and the queue follows them.
      </p>

      <LiveRegion>
        {message && <Notice kind="success" title={message} />}
        {error && <Notice kind="error" title={error} />}
      </LiveRegion>

      <section aria-labelledby="weekly-title">
        <h3 id="weekly-title" style={{ marginBottom: 8 }}>
          Weekly timings
        </h3>
        <p className="muted small">A day with no timing is a weekly holiday. Use "Copy to other days" to repeat a day.</p>

        {WEEK_ORDER.map((day) => (
          <DayCard
            key={day}
            day={day}
            sessions={weekly[day]}
            problem={problems[day]}
            onChange={(next) => {
              setWeekly({ ...weekly, [day]: next });
              setMessage('');
            }}
            onCopy={(targets) => {
              setWeekly(copyDay(weekly, day, targets));
              setMessage('');
            }}
          />
        ))}

        {warning && <ConflictWarning warning={warning} busy={busy} onCancel={() => setWarning(null)} />}

        {hasProblems && (
          <Notice kind="error" title="Fix the days marked above before saving." />
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <Button variant="primary" disabled={busy || !changed || hasProblems} onClick={() => void saveWeek(false)}>
            {busy ? 'Saving...' : 'Save weekly timings'}
          </Button>
          <Button disabled={busy || !changed} onClick={() => setWeekly(saved)}>
            Undo my changes
          </Button>
        </div>
      </section>

      <ExceptionsSection
        doctor={doctor}
        schedule={schedule}
        reload={load}
        onMessage={(text) => {
          setMessage(text);
          setError('');
        }}
      />

      <div className="dialog__actions">
        <Button onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// One weekday
// ---------------------------------------------------------------------------------------------------------------

function DayCard({ day, sessions, problem, onChange, onCopy }: {
  day: WeekdayNumber;
  sessions: TimedSession[];
  problem?: string;
  onChange: (next: TimedSession[]) => void;
  onCopy: (targets: WeekdayNumber[]) => void;
}) {
  const name = WEEKDAY_NAMES[day];
  const base = useId();
  const errorId = `${base}-error`;
  const [targets, setTargets] = useState<WeekdayNumber[]>([]);
  const [copied, setCopied] = useState('');

  return (
    <div className={`sched-day${sessions.length === 0 ? ' sched-day--closed' : ''}`}>
      <div className="sched-day__head">
        <h4 className="sched-day__name">{name}</h4>
        <span className={sessions.length === 0 ? 'badge badge--neutral' : 'muted small'}>
          {sessions.length === 0 ? 'Closed (weekly holiday)' : problem ? '' : describeDay(sessions)}
        </span>
      </div>

      <SessionRows
        idPrefix={`d${day}`}
        dayLabel={name}
        sessions={sessions}
        onChange={onChange}
        invalid={Boolean(problem)}
        describedBy={problem ? errorId : undefined}
      />
      {problem && (
        <p className="field__error" id={errorId} role="alert">
          {name}: {problem}
        </p>
      )}

      {sessions.length > 0 && !problem && (
        <details className="sched-copy">
          <summary>Copy {name} to other days</summary>
          <div className="sched-copy__days" role="group" aria-label={`Days to copy ${name} to`}>
            {WEEK_ORDER.filter((d) => d !== day).map((d) => (
              <label key={d}>
                <input
                  type="checkbox"
                  checked={targets.includes(d)}
                  onChange={(e) => setTargets(e.target.checked ? [...targets, d] : targets.filter((t) => t !== d))}
                />
                {WEEKDAY_NAMES[d]}
              </label>
            ))}
          </div>
          <Button
            size="sm"
            icon={Copy}
            disabled={targets.length === 0}
            onClick={() => {
              onCopy(targets);
              setCopied(`${name} copied to ${targets.map((t) => WEEKDAY_NAMES[t]).join(', ')}. Save to apply.`);
              setTargets([]);
            }}
          >
            Copy
          </Button>
          <LiveRegion>{copied && <p className="muted small">{copied}</p>}</LiveRegion>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Leave, holidays, different timings for one date, extra sessions
// ---------------------------------------------------------------------------------------------------------------

const KIND_LABEL: Record<ExceptionKind, string> = {
  closed: 'Leave or holiday (no OPD)',
  override: 'Different timings on one date',
  special: 'Extra session on one date',
};

function describeException(e: ScheduleException): string {
  const dates = e.startDate === e.endDate ? formatShortDate(e.startDate) : `${formatShortDate(e.startDate)} to ${formatShortDate(e.endDate)}`;
  const who = e.clinicWide ? 'Whole clinic' : 'This doctor';
  if (e.kind === 'closed') return `${e.clinicWide ? 'Clinic holiday' : 'Leave'}: ${dates}`;
  const times = sortSessions(e.sessions).map(describeSession).join(' and ');
  return `${e.kind === 'override' ? 'Timings for' : 'Extra session on'} ${dates}: ${times} (${who})`;
}

function ExceptionsSection({ doctor, schedule, reload, onMessage }: {
  doctor: Doctor;
  schedule: DoctorSchedule;
  reload: () => Promise<void>;
  onMessage: (text: string) => void;
}) {
  const actions = useActions();
  const [kind, setKind] = useState<ExceptionKind>('closed');
  const [scope, setScope] = useState<'doctor' | 'clinic'>('doctor');
  const [start, setStart] = useState<DateKey>(schedule.today);
  const [end, setEnd] = useState<DateKey>(schedule.today);
  const [sessions, setSessions] = useState<TimedSession[]>([{ start: '09:00', end: '13:00' }]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [warning, setWarning] = useState<PendingWarning | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const needsSessions = kind !== 'closed';
  const sessionProblem = needsSessions ? sessionsProblem(sessions, { min: 1 }) : null;
  const clinicWide = kind !== 'override' && scope === 'clinic';

  async function add(confirm: boolean) {
    setBusy(true);
    setError('');
    const result = await actions.addScheduleException({
      doctorId: clinicWide ? null : doctor.id,
      kind,
      startDate: start,
      endDate: kind === 'closed' ? end : start,
      sessions: needsSessions ? sessions : [],
      reason,
      confirm,
    });
    setBusy(false);
    if (!result.ok) {
      setErrors(result.fieldErrors ?? {});
      if (result.code === 'schedule_conflict') {
        setWarning({
          message: result.message,
          conflicts: result.conflicts ?? [],
          confirmLabel: 'Save anyway and keep those bookings',
          run: () => add(true),
        });
      } else {
        setWarning(null);
        setError(result.message);
      }
      return;
    }
    setWarning(null);
    setErrors({});
    setReason('');
    onMessage(
      result.value.kept.length > 0
        ? 'Saved. Patients already booked on that day keep their tokens.'
        : kind === 'closed'
          ? 'Saved. Patients can no longer book on those days.'
          : 'Saved. The new timings apply on that date.',
    );
    await reload();
  }

  async function remove(e: ScheduleException, confirm: boolean) {
    setBusy(true);
    const result = await actions.removeScheduleException(e.id, confirm);
    setBusy(false);
    if (!result.ok) {
      if (result.code === 'schedule_conflict') {
        setWarning({
          message: result.message,
          conflicts: result.conflicts ?? [],
          confirmLabel: 'Remove anyway and keep those bookings',
          run: () => remove(e, true),
        });
      } else {
        setWarning(null);
        setError(result.message);
      }
      return;
    }
    setWarning(null);
    setError('');
    onMessage('Removed. The usual timings apply again on those days.');
    await reload();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || sessionProblem) return;
    void add(false);
  }

  return (
    <section aria-labelledby="exceptions-title">
      <h3 id="exceptions-title" style={{ marginBottom: 8 }}>
        Leave, holidays and special days
      </h3>

      {schedule.exceptions.length === 0 ? (
        <p className="muted">None planned.</p>
      ) : (
        <ul className="list-plain list-rows">
          {schedule.exceptions.map((e) => (
            <li key={e.id} className="row row--between">
              <span>
                {describeException(e)}
                {e.reason && <span className="muted small"> Note: {e.reason}</span>}
              </span>
              <Button size="sm" icon={Trash2} disabled={busy} onClick={() => void remove(e, false)}>
                Remove<span className="sr-only"> {describeException(e)}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}

      {error && <Notice kind="error" title={error} />}
      {warning && <ConflictWarning warning={warning} busy={busy} onCancel={() => setWarning(null)} />}

      <form ref={formRef} onSubmit={submit} noValidate className="card card--flat" style={{ marginTop: 12 }}>
        <h4 style={{ marginTop: 0 }}>Add leave, a holiday or a special day</h4>
        <SelectField
          label="What is happening?"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as ExceptionKind);
            setWarning(null);
          }}
        >
          {(Object.keys(KIND_LABEL) as ExceptionKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </SelectField>

        {kind !== 'override' && (
          <SelectField label="Who is affected?" value={scope} onChange={(e) => setScope(e.target.value as 'doctor' | 'clinic')}>
            <option value="doctor">{doctor.name} only</option>
            <option value="clinic">The whole clinic (every doctor)</option>
          </SelectField>
        )}

        <div className="grid grid--2">
          <TextField
            label={kind === 'closed' ? 'First day' : 'Date'}
            type="date"
            min={schedule.today}
            value={start}
            onChange={(e) => {
              setStart(e.target.value);
              if (end < e.target.value) setEnd(e.target.value);
            }}
            error={errors.date}
          />
          {kind === 'closed' && (
            <TextField label="Last day" type="date" min={start} value={end} onChange={(e) => setEnd(e.target.value)} />
          )}
        </div>

        {needsSessions && (
          <fieldset>
            <legend>{kind === 'override' ? 'Timings on that date (replace the usual ones)' : 'Extra session (added to the usual ones)'}</legend>
            <SessionRows
              idPrefix="exc"
              dayLabel="that date"
              sessions={sessions}
              onChange={setSessions}
              invalid={Boolean(sessionProblem || errors.sessions)}
              describedBy="exc-problem"
            />
            {(sessionProblem || errors.sessions) && (
              <p className="field__error" id="exc-problem" role="alert">
                {sessionProblem ?? errors.sessions}
              </p>
            )}
          </fieldset>
        )}

        <TextField
          label="Note for your staff (optional)"
          maxLength={REASON_MAX}
          hint="Only your staff can see this. Patients are told only that the doctor or clinic is not available."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={errors.reason}
        />

        <Button type="submit" variant="primary" icon={CalendarPlus} disabled={busy || Boolean(sessionProblem)}>
          {busy ? 'Saving...' : 'Add'}
        </Button>
      </form>
    </section>
  );
}
