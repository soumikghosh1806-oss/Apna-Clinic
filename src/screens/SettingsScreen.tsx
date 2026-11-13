// Screen 11: Clinic settings (owner)

import { CalendarClock, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { PublicLinksCard, PublicProfileCard, StaffSection } from '../components/ClinicAdmin';
import { ScheduleEditor } from '../components/ScheduleEditor';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { ResetDemoButton } from '../components/Shell';
import {
  Button,
  CardTitle,
  DemoTag,
  LiveRegion,
  Notice,
  PageHeader,
  TextField,
} from '../components/ui';
import { IS_SUPABASE } from '../backend/mode';
import { formatMinutes, parseHM } from '../domain/dates';
import { activeDoctors, dailyLimitFor, minutesPerPatientFor } from '../domain/queue';
import { openTokenCount, LIMIT_MAX, LIMIT_MIN, MINUTES_MAX, MINUTES_MIN } from '../domain/settings';
import type { Doctor, Failure, OpdSession } from '../domain/types';
import { useActions } from '../state/context';
import { useFocusFirstError, useLiveQueue } from '../state/hooks';

/** Empty box means "use the clinic setting". Anything else must be a whole number, checked by the domain rules. */
function parseOptionalNumber(text: string): number | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : Number(trimmed);
}

export function SettingsScreen() {
  const { state, now } = useLiveQueue();
  const actions = useActions();
  const focusFirstError = useFocusFirstError();
  const formRef = useRef<HTMLFormElement>(null);

  const { settings } = state;
  const doctors = activeDoctors(state);

  const [clinicName, setClinicName] = useState(settings.clinicName);
  const [online, setOnline] = useState(settings.onlineBookingEnabled);
  const [limit, setLimit] = useState(String(settings.defaultDailyLimit));
  const [minutes, setMinutes] = useState(String(settings.defaultMinutesPerPatient));
  const [perPhone, setPerPhone] = useState(String(settings.maxOnlineBookingsPerPhone ?? 4));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [doctorDialog, setDoctorDialog] = useState<{ doctor?: Doctor } | null>(null);
  const [scheduling, setScheduling] = useState<Doctor | null>(null);
  const [removing, setRemoving] = useState<Doctor | null>(null);
  const [removeError, setRemoveError] = useState('');

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    const result = await actions.saveSettings({
      clinicName,
      onlineBookingEnabled: online,
      defaultDailyLimit: limit.trim() === '' ? NaN : Number(limit),
      defaultMinutesPerPatient: minutes.trim() === '' ? NaN : Number(minutes),
      ...(IS_SUPABASE ? { maxOnlineBookingsPerPhone: perPhone.trim() === '' ? NaN : Number(perPhone) } : {}),
    });
    setSaving(false);
    if (result.ok) {
      setErrors({});
      setSaved(
        `Settings saved. Online booking is ${result.value.onlineBookingEnabled ? 'on' : 'off'}. Walk-in entry always works.`,
      );
      return;
    }
    setSaved('');
    setErrors(result.fieldErrors ?? { form: result.message });
    focusFirstError(formRef.current);
  }

  async function confirmRemove() {
    if (!removing) return;
    const result = await actions.removeDoctor(removing.id);
    if (result.ok) {
      setSaved(`${removing.name} was removed from the doctor list.`);
      setRemoving(null);
      setRemoveError('');
    } else {
      setRemoveError(result.message);
    }
  }

  return (
    <>
      <PageHeader
        title="Settings"
        intro={
          <>
            Clinic rules apply straight away to booking, estimates and the queue screens. <DemoTag />
          </>
        }
      />

      <LiveRegion>{saved && <Notice kind="success" title={saved} />}</LiveRegion>

      <form ref={formRef} onSubmit={(e) => void save(e)} noValidate className="card" style={{ marginTop: 16 }} aria-labelledby="clinic-rules">
        <h2 id="clinic-rules" className="card__title">
          Clinic rules
        </h2>

        <TextField
          label="Clinic name"
          maxLength={60}
          value={clinicName}
          onChange={(e) => setClinicName(e.target.value)}
          error={errors.clinicName}
        />

        <div className="field">
          <label className="switch">
            <input type="checkbox" role="switch" checked={online} onChange={(e) => setOnline(e.target.checked)} />
            <span>
              <strong>Online booking is {online ? 'on' : 'off'}</strong>
              <br />
              <span className="muted small">
                When off, patients cannot book tokens online. Reception can still add walk-in patients.
              </span>
            </span>
          </label>
        </div>

        <div className="grid grid--2">
          <TextField
            label="Daily token limit for each OPD"
            type="number"
            inputMode="numeric"
            min={LIMIT_MIN}
            max={LIMIT_MAX}
            hint={`A whole number from ${LIMIT_MIN} to ${LIMIT_MAX}. A doctor can have their own limit below.`}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            error={errors.defaultDailyLimit}
          />
          <TextField
            label="Minutes per patient"
            type="number"
            inputMode="numeric"
            min={MINUTES_MIN}
            max={MINUTES_MAX}
            hint="Used for waiting time estimates. They are estimates only."
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            error={errors.defaultMinutesPerPatient}
          />
        </div>

        {IS_SUPABASE && (
          <TextField
            label="Online tokens one phone number can book each day"
            type="number"
            inputMode="numeric"
            min={1}
            max={20}
            hint="Stops one number from taking many tokens. Family members can use one number, so keep it above 1. Walk-ins at the desk are not limited by this."
            value={perPhone}
            onChange={(e) => setPerPhone(e.target.value)}
            error={errors.maxOnlineBookingsPerPhone}
          />
        )}

        {errors.form && <Notice kind="error" title={errors.form} />}
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? 'Saving...' : 'Save settings'}
        </Button>
      </form>

      <section className="card" style={{ marginTop: 16 }} aria-labelledby="doctors-title">
        <div className="row row--between" style={{ marginBottom: 12 }}>
          <h2 id="doctors-title" className="card__title" style={{ margin: 0 }}>
            Doctors and OPD timings
          </h2>
          <Button icon={Plus} onClick={() => setDoctorDialog({})}>
            Add doctor
          </Button>
        </div>

        <div className="table-wrap">
          <table className="table table--stack">
            <caption className="sr-only">Doctors and their OPD timings</caption>
            <thead>
              <tr>
                <th scope="col">Doctor</th>
                <th scope="col">OPD</th>
                <th scope="col">{IS_SUPABASE ? "Today's timings" : 'Timings'}</th>
                <th scope="col">Token limit</th>
                <th scope="col">Minutes per patient</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {doctors.map((doctor) => (
                <tr key={doctor.id}>
                  <td data-label="Doctor">
                    <strong>{doctor.name}</strong>
                  </td>
                  <td data-label="OPD">{doctor.opd}</td>
                  <td data-label={IS_SUPABASE ? "Today's timings" : 'Timings'}>
                    {doctor.sessions.length === 0
                      ? 'No OPD today'
                      : doctor.sessions
                          .map((s) => `${formatMinutes(parseHM(s.start))} to ${formatMinutes(parseHM(s.end))}`)
                          .join(', ')}
                  </td>
                  <td data-label="Token limit">
                    {dailyLimitFor(state, doctor)}
                    {doctor.dailyLimit === null && <span className="muted small"> (clinic)</span>}
                  </td>
                  <td data-label="Minutes per patient">
                    {minutesPerPatientFor(state, doctor)}
                    {doctor.minutesPerPatient === null && <span className="muted small"> (clinic)</span>}
                  </td>
                  <td data-label="Actions">
                    <div className="actions">
                      {IS_SUPABASE && (
                        <Button size="sm" icon={CalendarClock} onClick={() => setScheduling(doctor)}>
                          Schedule<span className="sr-only"> for {doctor.name}</span>
                        </Button>
                      )}
                      <Button size="sm" icon={Pencil} onClick={() => setDoctorDialog({ doctor })}>
                        Edit<span className="sr-only"> {doctor.name}</span>
                      </Button>
                      <Button
                        size="sm"
                        icon={Trash2}
                        onClick={() => {
                          setRemoveError('');
                          setRemoving(doctor);
                        }}
                      >
                        Remove<span className="sr-only"> {doctor.name}</span>
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {IS_SUPABASE ? (
        <>
          <StaffSection />
          <PublicLinksCard />
          <PublicProfileCard />
        </>
      ) : (
        <section className="card" style={{ marginTop: 16 }} aria-labelledby="demo-data">
          <CardTitle>
            <span id="demo-data">Demo data</span>
          </CardTitle>
          <p>
            Everything in this prototype is stored in this browser only (local storage). It is not a secure database and
            it is never sent to a server. Do not enter real patient details.
          </p>
          <ResetDemoButton />
        </section>
      )}

      <Dialog
        open={doctorDialog !== null}
        title={doctorDialog?.doctor ? 'Edit doctor' : 'Add doctor'}
        onClose={() => setDoctorDialog(null)}
      >
        {doctorDialog && (
          <DoctorForm
            key={doctorDialog.doctor?.id ?? 'new'}
            doctor={doctorDialog.doctor}
            onCancel={() => setDoctorDialog(null)}
            onSaved={(text) => {
              setSaved(text);
              setDoctorDialog(null);
            }}
          />
        )}
      </Dialog>

      <Dialog open={scheduling !== null} title={`Timetable: ${scheduling?.name ?? ''}`} onClose={() => setScheduling(null)} wide>
        {scheduling && <ScheduleEditor key={scheduling.id} doctor={scheduling} onClose={() => setScheduling(null)} />}
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? 'doctor'}?`}
        confirmLabel="Remove doctor"
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() => void confirmRemove()}
      >
        <p>
          Patients will no longer be able to book {removing?.opd}. Past records and reports are kept.
          {removing && openTokenCount(state, removing.id, now) > 0 && (
            <>
              {' '}
              This doctor still has {openTokenCount(state, removing.id, now)} open{' '}
              {openTokenCount(state, removing.id, now) === 1 ? 'token' : 'tokens'} for today or tomorrow, so removal will be
              refused until they are finished.
            </>
          )}
        </p>
        {removeError && <Notice kind="error" title={removeError} />}
      </ConfirmDialog>
    </>
  );
}

interface DoctorFormProps {
  doctor?: Doctor;
  onCancel: () => void;
  onSaved: (message: string) => void;
}

function DoctorForm({ doctor, onCancel, onSaved }: DoctorFormProps) {
  const actions = useActions();
  const focusFirstError = useFocusFirstError();
  const formRef = useRef<HTMLFormElement>(null);

  const [name, setName] = useState(doctor?.name ?? '');
  const [opd, setOpd] = useState(doctor?.opd ?? '');
  const [sessions, setSessions] = useState<OpdSession[]>(doctor?.sessions ?? [{ start: '10:00', end: '14:00' }]);
  const [limit, setLimit] = useState(doctor?.dailyLimit === null || !doctor ? '' : String(doctor.dailyLimit));
  const [minutes, setMinutes] = useState(doctor?.minutesPerPatient === null || !doctor ? '' : String(doctor.minutesPerPatient));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saving, setSaving] = useState(false);

  function setSession(index: number, patch: Partial<OpdSession>) {
    setSessions(sessions.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const input = {
      name,
      opd,
      sessions,
      dailyLimit: parseOptionalNumber(limit),
      minutesPerPatient: parseOptionalNumber(minutes),
    };
    setSaving(true);
    const result = await (doctor ? actions.saveDoctor(doctor.id, input) : actions.addDoctor(input));
    setSaving(false);
    if (result.ok) {
      onSaved(doctor ? `${result.value.name} was updated.` : `${result.value.name} was added to the doctor list.`);
      return;
    }
    setErrors(result.fieldErrors ?? {});
    setFailure(result);
    focusFirstError(formRef.current);
  }

  return (
    <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate>
      <TextField label="Doctor name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
      <TextField
        label="OPD name"
        maxLength={40}
        hint="Patients see this name, for example General OPD."
        value={opd}
        onChange={(e) => setOpd(e.target.value)}
        error={errors.opd}
      />

      {IS_SUPABASE && doctor ? (
        <p className="muted small">
          To change OPD timings, breaks, leave or holidays, close this and press Schedule next to the doctor.
        </p>
      ) : (
      <fieldset aria-describedby={errors.sessions ? 'sessions-error' : undefined}>
        <legend>{IS_SUPABASE ? 'Usual OPD timings (every day, you can change each day afterwards)' : 'OPD timings'}</legend>
        {sessions.map((session, index) => (
          <div className="row" key={index} style={{ marginBottom: 8, alignItems: 'flex-end' }}>
            <div className="field" style={{ margin: 0 }}>
              <label className="field__label" htmlFor={`start-${index}`}>
                From<span className="sr-only"> (timing {index + 1})</span>
              </label>
              <input
                id={`start-${index}`}
                className="input"
                type="time"
                value={session.start}
                aria-invalid={errors.sessions ? true : undefined}
                onChange={(e) => setSession(index, { start: e.target.value })}
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label className="field__label" htmlFor={`end-${index}`}>
                To<span className="sr-only"> (timing {index + 1})</span>
              </label>
              <input
                id={`end-${index}`}
                className="input"
                type="time"
                value={session.end}
                aria-invalid={errors.sessions ? true : undefined}
                onChange={(e) => setSession(index, { end: e.target.value })}
              />
            </div>
            {sessions.length > 1 && (
              <Button size="sm" variant="quiet" icon={X} onClick={() => setSessions(sessions.filter((_, i) => i !== index))}>
                Remove<span className="sr-only"> timing {index + 1}</span>
              </Button>
            )}
          </div>
        ))}
        {errors.sessions && (
          <p className="field__error" id="sessions-error" role="alert">
            {errors.sessions}
          </p>
        )}
        {sessions.length < 3 && (
          <Button size="sm" icon={Plus} onClick={() => setSessions([...sessions, { start: '17:00', end: '20:00' }])}>
            Add timing
          </Button>
        )}
      </fieldset>
      )}

      <div className="grid grid--2">
        <TextField
          label="Token limit for this doctor"
          type="number"
          inputMode="numeric"
          hint="Leave empty to use the clinic limit."
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          error={errors.dailyLimit}
        />
        <TextField
          label="Minutes per patient"
          type="number"
          inputMode="numeric"
          hint="Leave empty to use the clinic value."
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          error={errors.minutesPerPatient}
        />
      </div>

      {failure && !failure.fieldErrors && <Notice kind="error" title={failure.message} />}
      {failure?.fieldErrors && <Notice kind="error" title="Please fix the highlighted fields." />}

      <div className="dialog__actions">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? 'Saving...' : doctor ? 'Save doctor' : 'Add doctor'}
        </Button>
      </div>
    </form>
  );
}
