// Screen 8: Patient history (doctor)

import { ArrowLeft, ExternalLink, Paperclip, Pencil, Pill, Plus, X } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Dialog } from '../components/Dialog';
import { ClinicNotice } from '../components/ClinicNotice';
import {
  Button,
  DemoTag,
  EmptyState,
  LiveRegion,
  Notice,
  PageHeader,
  TextAreaField,
  TextField,
} from '../components/ui';
import { IS_SUPABASE } from '../backend/mode';
import { formatDate, toDateKey } from '../domain/dates';
import { getDoctor } from '../domain/queue';
import type { Failure, Medicine, ReportFile, Visit } from '../domain/types';
import { maskPhone } from '../domain/validation';
import { useActions, useAuth } from '../state/context';
import { useFocusFirstError, useLiveQueue } from '../state/hooks';
import { usePatientHistory } from '../state/staffData';

interface FormTarget {
  /** Set when an existing visit is being edited. */
  visit?: Visit;
}

const MAX_MEDICINES = 30;
const MAX_NEW_FILES = 5;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PatientHistoryScreen() {
  const { patientId = '' } = useParams();
  const { state, now } = useLiveQueue();
  const { session } = useAuth();
  const actions = useActions();
  const history = usePatientHistory(patientId);
  const [target, setTarget] = useState<FormTarget | null>(null);
  const [prescribing, setPrescribing] = useState<Visit | null>(null);
  const [saved, setSaved] = useState('');
  const [problem, setProblem] = useState('');

  if (history.load === 'loading') {
    return (
      <>
        <PageHeader title="Patient history" />
        <ClinicNotice load="loading" />
      </>
    );
  }
  if (history.load === 'error') {
    return (
      <>
        <PageHeader title="Patient history" />
        <ClinicNotice load="error" message={history.message} />
        <p style={{ marginTop: 16 }}>
          <Link to="/doctor">Back to next patient</Link>
        </p>
      </>
    );
  }
  if (!history.data) {
    return (
      <>
        <PageHeader title="Patient history" />
        <EmptyState title="This patient could not be found.">
          <p>
            {IS_SUPABASE
              ? 'The patient may belong to another clinic, or the link may be wrong.'
              : 'The record may have been removed when the demo data was reset.'}
          </p>
        </EmptyState>
        <p style={{ marginTop: 16 }}>
          <Link to="/doctor">Back to next patient</Link>
        </p>
      </>
    );
  }

  const { patient, visits, otherReports } = history.data;
  const myDoctorId = session?.doctorId;

  async function openReport(report: ReportFile) {
    setProblem('');
    const result = await actions.openReport(report.id);
    if (!result.ok) setProblem(result.message);
  }

  function reportList(reports: ReportFile[]) {
    return (
      <ul className="list-plain">
        {reports.map((report) => (
          <li key={report.id} className="row" style={{ gap: 6 }}>
            <Paperclip size={14} aria-hidden="true" />
            <span style={{ overflowWrap: 'anywhere' }}>
              {report.name} <span className="muted small">({formatBytes(report.sizeBytes)})</span>
            </span>
            <Button size="sm" variant="quiet" icon={ExternalLink} onClick={() => void openReport(report)}>
              Open<span className="sr-only"> {report.name}</span>
            </Button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      <p>
        <Link to="/doctor" className="row" style={{ display: 'inline-flex' }}>
          <ArrowLeft size={16} aria-hidden="true" />
          Back to next patient
        </Link>
      </p>
      <PageHeader
        title={patient.name}
        intro={
          <>
            Phone <span className="mono">{maskPhone(patient.phone)}</span>. {visits.length}{' '}
            {visits.length === 1 ? 'visit' : 'visits'} in total.{' '}
            <DemoTag>{patient.sample ? 'Sample record' : 'Demo entry'}</DemoTag>
          </>
        }
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setTarget({})}>
            Add consultation note
          </Button>
        }
      />

      <div style={{ marginBottom: 16 }}>
        {IS_SUPABASE ? (
          <Notice kind="info" title="Private medical record." live={false}>
            <p>
              Only doctors of this clinic can open this page. Each time a history is opened it is written to the clinic's
              audit log. Notes are written by the doctor. This app never suggests diagnoses or medicines.
            </p>
          </Notice>
        ) : (
          <Notice kind="info" title="Sample medical records for the demo." live={false}>
            <p>
              Do not enter real patient information. Notes are written by the doctor. This app never suggests diagnoses or
              medicines.
            </p>
          </Notice>
        )}
      </div>

      <LiveRegion>
        {saved && <Notice kind="success" title={saved} />}
        {problem && <Notice kind="error" title={problem} />}
      </LiveRegion>

      <h2 style={{ marginTop: 16 }}>Visit timeline</h2>
      {visits.length === 0 ? (
        <EmptyState title="No visits on record yet.">
          <p>Add a consultation note to start the history.</p>
        </EmptyState>
      ) : (
        <ol className="timeline" aria-label="Visits, newest first">
          {visits.map((visit) => {
            const doctor = getDoctor(state, visit.doctorId);
            const noText = !visit.notes && !visit.advice && !visit.diagnosis;
            const mine = !IS_SUPABASE || visit.doctorId === myDoctorId;
            const reports = visit.reports ?? [];
            return (
              <li key={visit.id}>
                <article className="timeline__card">
                  <div className="row row--between">
                    <span>
                      <span className="timeline__date">{formatDate(visit.date)}</span>{' '}
                      <span className="muted small">
                        {doctor?.opd}, {doctor?.name}
                      </span>
                    </span>
                    {visit.sample && <DemoTag>Sample record</DemoTag>}
                  </div>
                  <h3 style={{ margin: '8px 0 0', fontSize: '1.0625rem' }}>{visit.title}</h3>

                  {noText ? (
                    <p className="muted" style={{ margin: '8px 0 0' }}>
                      No notes added yet.
                    </p>
                  ) : (
                    <>
                      {visit.symptoms && (
                        <>
                          <p className="timeline__label">Symptoms</p>
                          <p className="timeline__text">{visit.symptoms}</p>
                        </>
                      )}
                      {visit.diagnosis && (
                        <>
                          <p className="timeline__label">Diagnosis</p>
                          <p className="timeline__text">{visit.diagnosis}</p>
                        </>
                      )}
                      <p className="timeline__label">Consultation notes</p>
                      <p className="timeline__text">{visit.notes || 'None'}</p>
                      <p className="timeline__label">{IS_SUPABASE ? 'Advice' : 'Medication and advice'}</p>
                      <p className="timeline__text">{visit.advice || 'None'}</p>
                    </>
                  )}

                  {IS_SUPABASE && (visit.prescription || mine) && (
                    <>
                      <p className="timeline__label">Prescription</p>
                      {visit.prescription ? (
                        <>
                          <ul className="list-plain">
                            {visit.prescription.medicines.map((m, i) => (
                              <li key={i} className="row" style={{ gap: 6, alignItems: 'baseline' }}>
                                <Pill size={14} aria-hidden="true" />
                                <span>
                                  <strong>{m.name}</strong>
                                  {[m.dose, m.frequency, m.duration].filter(Boolean).length > 0 && (
                                    <span className="muted"> . {[m.dose, m.frequency, m.duration].filter(Boolean).join(', ')}</span>
                                  )}
                                  {m.notes && <span className="muted small"> ({m.notes})</span>}
                                </span>
                              </li>
                            ))}
                          </ul>
                          {visit.prescription.instructions && <p className="timeline__text">{visit.prescription.instructions}</p>}
                        </>
                      ) : (
                        <p className="muted" style={{ margin: 0 }}>
                          No prescription written.
                        </p>
                      )}
                      {mine && (
                        <div style={{ marginTop: 8 }}>
                          <Button size="sm" icon={Pill} onClick={() => setPrescribing(visit)}>
                            {visit.prescription ? 'Edit prescription' : 'Write prescription'}
                            <span className="sr-only"> for the visit on {formatDate(visit.date)}</span>
                          </Button>
                        </div>
                      )}
                    </>
                  )}

                  {IS_SUPABASE && reports.length > 0 && (
                    <>
                      <p className="timeline__label">Reports and images</p>
                      {reportList(reports)}
                    </>
                  )}

                  {!IS_SUPABASE && visit.attachments.length > 0 && (
                    <>
                      <p className="timeline__label">Attachments (file names only)</p>
                      <ul className="list-plain">
                        {visit.attachments.map((file) => (
                          <li key={file} className="row" style={{ gap: 6 }}>
                            <Paperclip size={14} aria-hidden="true" />
                            {file}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  {!visit.sample && mine && (
                    <div style={{ marginTop: 12 }}>
                      <Button size="sm" icon={Pencil} onClick={() => setTarget({ visit })}>
                        {noText ? 'Add notes' : 'Edit'}
                        <span className="sr-only"> for the visit on {formatDate(visit.date)}</span>
                      </Button>
                    </div>
                  )}
                </article>
              </li>
            );
          })}
        </ol>
      )}

      {IS_SUPABASE && otherReports.length > 0 && (
        <section style={{ marginTop: 16 }} aria-label="Other reports">
          <h2>Other reports</h2>
          {reportList(otherReports)}
        </section>
      )}

      <Dialog
        open={target !== null}
        title={target?.visit ? 'Edit visit' : 'Add consultation note'}
        onClose={() => setTarget(null)}
      >
        {target && (
          <VisitForm
            key={target.visit?.id ?? 'new'}
            patientId={patient.id}
            doctorId={session?.doctorId ?? ''}
            today={toDateKey(now)}
            visit={target.visit}
            onCancel={() => setTarget(null)}
            onSaved={(text, warnings) => {
              setSaved(text);
              setProblem(warnings && warnings.length > 0 ? `Some files were not uploaded. ${warnings.join(' ')}` : '');
              setTarget(null);
              history.reload();
            }}
          />
        )}
      </Dialog>

      <Dialog open={prescribing !== null} title="Prescription" onClose={() => setPrescribing(null)}>
        {prescribing && (
          <PrescriptionForm
            key={prescribing.id}
            visit={prescribing}
            onCancel={() => setPrescribing(null)}
            onSaved={() => {
              setSaved('Prescription saved.');
              setProblem('');
              setPrescribing(null);
              history.reload();
            }}
          />
        )}
      </Dialog>
    </>
  );
}

interface VisitFormProps {
  patientId: string;
  doctorId: string;
  today: string;
  visit?: Visit;
  onCancel: () => void;
  onSaved: (message: string, warnings?: string[]) => void;
}

function VisitForm({ patientId, doctorId, today, visit, onCancel, onSaved }: VisitFormProps) {
  const actions = useActions();
  const focusFirstError = useFocusFirstError();
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);

  const [date, setDate] = useState(visit?.date ?? today);
  const [title, setTitle] = useState(visit?.title ?? '');
  const [symptoms, setSymptoms] = useState(visit?.symptoms ?? '');
  const [diagnosis, setDiagnosis] = useState(visit?.diagnosis ?? '');
  const [notes, setNotes] = useState(visit?.notes ?? '');
  const [advice, setAdvice] = useState(visit?.advice ?? '');
  const [files, setFiles] = useState<string[]>(visit?.attachments ?? []);
  const [picked, setPicked] = useState<File[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    const result = await actions.saveVisit({
      visitId: visit?.id,
      patientId,
      doctorId: visit?.doctorId ?? doctorId,
      date,
      title,
      notes,
      advice,
      attachments: files,
      symptoms,
      diagnosis,
      files: picked,
    });
    busy.current = false;
    setSaving(false);
    if (result.ok) {
      onSaved(visit ? 'Visit updated.' : 'Consultation note added to the timeline.', result.value.uploadErrors);
      return;
    }
    setErrors(result.fieldErrors ?? {});
    setFailure(result);
    focusFirstError(formRef.current);
  }

  return (
    <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate>
      <TextField
        label="Visit date"
        type="date"
        max={today}
        value={date}
        onChange={(e) => setDate(e.target.value)}
        error={errors.date}
      />
      <TextField
        label="Reason for visit"
        maxLength={120}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        error={errors.title}
      />
      {IS_SUPABASE && (
        <>
          <TextAreaField
            label="Symptoms (optional)"
            maxLength={2000}
            value={symptoms}
            onChange={(e) => setSymptoms(e.target.value)}
            error={errors.symptoms}
          />
          <TextAreaField
            label="Diagnosis (optional)"
            maxLength={2000}
            value={diagnosis}
            onChange={(e) => setDiagnosis(e.target.value)}
            error={errors.diagnosis}
          />
        </>
      )}
      <TextAreaField
        label="Consultation notes"
        maxLength={2000}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        error={errors.notes}
      />
      <TextAreaField
        label={IS_SUPABASE ? 'Advice' : 'Medication and advice'}
        maxLength={2000}
        value={advice}
        onChange={(e) => setAdvice(e.target.value)}
        error={errors.advice}
      />

      <div className="field">
        <label className="field__label" htmlFor="attach">
          Attach a report or image (optional)
        </label>
        <span className="field__hint" id="attach-hint">
          {IS_SUPABASE
            ? `PDF, JPEG, PNG or WebP, up to 10 MB each, ${MAX_NEW_FILES} files at a time. Files are kept in private storage that only doctors of this clinic can open.`
            : 'Demo only. The file is not uploaded or stored. Only its name is saved.'}
        </span>
        <input
          ref={fileRef}
          id="attach"
          className="input"
          type="file"
          multiple={IS_SUPABASE}
          aria-describedby="attach-hint"
          accept={IS_SUPABASE ? '.pdf,.png,.jpg,.jpeg,.webp' : '.pdf,.png,.jpg,.jpeg'}
          onChange={(e) => {
            const chosen = Array.from(e.target.files ?? []);
            if (IS_SUPABASE) {
              setPicked((current) => [...current, ...chosen].slice(0, MAX_NEW_FILES));
            } else {
              const names = chosen.map((f) => f.name.slice(0, 80));
              setFiles((current) => [...new Set([...current, ...names])].slice(0, 5));
            }
            if (fileRef.current) fileRef.current.value = '';
          }}
        />
        {(IS_SUPABASE ? picked.map((f) => f.name) : files).length > 0 && (
          <ul className="list-plain" style={{ marginTop: 8 }}>
            {(IS_SUPABASE ? picked.map((f) => f.name) : files).map((file, index) => (
              <li key={`${file}-${index}`} className="row">
                <Paperclip size={14} aria-hidden="true" />
                <span style={{ overflowWrap: 'anywhere' }}>{file}</span>
                <Button
                  size="sm"
                  variant="quiet"
                  icon={X}
                  onClick={() =>
                    IS_SUPABASE ? setPicked(picked.filter((_, i) => i !== index)) : setFiles(files.filter((f) => f !== file))
                  }
                >
                  Remove<span className="sr-only"> {file}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {failure && !failure.fieldErrors && <Notice kind="error" title={failure.message} />}
      {failure?.fieldErrors && <Notice kind="error" title="Please fix the highlighted fields." />}

      <div className="dialog__actions">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

function PrescriptionForm({ visit, onCancel, onSaved }: { visit: Visit; onCancel: () => void; onSaved: () => void }) {
  const actions = useActions();
  const [medicines, setMedicines] = useState<Medicine[]>(
    visit.prescription && visit.prescription.medicines.length > 0 ? visit.prescription.medicines : [{ name: '' }],
  );
  const [instructions, setInstructions] = useState(visit.prescription?.instructions ?? '');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saving, setSaving] = useState(false);

  function change(index: number, patch: Partial<Medicine>) {
    setMedicines(medicines.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    // A row left completely empty is ignored. A row with something in it must have a name.
    const filled = medicines.filter((m) => Object.values(m).some((v) => (v ?? '').trim() !== ''));
    setSaving(true);
    const result = await actions.savePrescription({ visitId: visit.id, medicines: filled, instructions });
    setSaving(false);
    if (result.ok) {
      onSaved();
      return;
    }
    setFailure(result);
  }

  const problem = failure?.fieldErrors?.medicines ?? failure?.message;

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <p className="muted small">
        Written by the doctor for the visit on {formatDate(visit.date)}. This app never suggests medicines.
      </p>
      {medicines.map((m, index) => (
        <fieldset key={index} style={{ marginBottom: 12 }}>
          <legend>Medicine {index + 1}</legend>
          <TextField label="Name" maxLength={100} value={m.name} onChange={(e) => change(index, { name: e.target.value })} />
          <div className="grid grid--3">
            <TextField label="Dose" maxLength={100} value={m.dose ?? ''} onChange={(e) => change(index, { dose: e.target.value })} />
            <TextField
              label="How often"
              maxLength={100}
              value={m.frequency ?? ''}
              onChange={(e) => change(index, { frequency: e.target.value })}
            />
            <TextField
              label="For how long"
              maxLength={100}
              value={m.duration ?? ''}
              onChange={(e) => change(index, { duration: e.target.value })}
            />
          </div>
          <TextField label="Note (optional)" maxLength={200} value={m.notes ?? ''} onChange={(e) => change(index, { notes: e.target.value })} />
          {medicines.length > 1 && (
            <Button size="sm" variant="quiet" icon={X} onClick={() => setMedicines(medicines.filter((_, i) => i !== index))}>
              Remove<span className="sr-only"> medicine {index + 1}</span>
            </Button>
          )}
        </fieldset>
      ))}
      {medicines.length < MAX_MEDICINES && (
        <Button size="sm" icon={Plus} onClick={() => setMedicines([...medicines, { name: '' }])}>
          Add medicine
        </Button>
      )}
      <TextAreaField
        label="Instructions (optional)"
        maxLength={2000}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
      />
      {problem && <Notice kind="error" title={problem} />}
      <div className="dialog__actions">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? 'Saving...' : 'Save prescription'}
        </Button>
      </div>
    </form>
  );
}
