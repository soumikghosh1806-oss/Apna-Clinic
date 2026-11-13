// The owner's staff card: add a doctor or receptionist with a temporary password, see who has not signed in yet, resend
// the welcome email, set a new temporary password, and manage invitations sent to people who already have an account.

import { MailCheck, UserPlus, Users } from 'lucide-react';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { StaffMember } from '../backend/mappers';
import type { Failure } from '../domain/types';
import { suggestPassword } from '../lib/passwords';
import type { EmailOutcome, StaffCreated } from '../state/actions';
import { useActions } from '../state/context';
import { useFocusFirstError } from '../state/hooks';
import { useStaffList } from '../state/staffData';
import { Dialog } from './Dialog';
import { PasswordField, useShowPasswords } from './PasswordInputs';
import { Button, LiveRegion, Notice, SelectField, TextField } from './ui';

const ROLE_LABEL: Record<StaffMember['role'], string> = { owner: 'Owner', reception: 'Receptionist', doctor: 'Doctor' };

type Banner = { kind: 'success' | 'warning' | 'error'; title: string; body?: ReactNode };

/** Says what really happened to the email. "Sent" appears only when the email provider accepted the message. */
export function emailBanner(email: EmailOutcome, sentTitle: string, notSentTitle: string, extra?: ReactNode): Banner {
  if (email.status === 'sent') return { kind: 'success', title: sentTitle, body: extra };
  return {
    kind: 'warning',
    title: notSentTitle,
    body: (
      <>
        <p>{email.message ?? 'The email could not be sent.'}</p>
        {extra}
      </>
    ),
  };
}

function createdBanner(result: StaffCreated, name: string, email: string): Banner {
  const loginUrl = `${window.location.origin}/login`;
  if (result.kind === 'invitation') {
    return emailBanner(
      result.email,
      `${name} already has an Apna Clinic account, so an invitation was sent to ${email}.`,
      `${name} already has an account and an invitation was saved, but the email was NOT sent.`,
      <p className="muted small">They are added to your clinic only after they accept. Their own password was not changed.</p>,
    );
  }
  return emailBanner(
    result.email,
    `Account created for ${name}. A welcome email with the sign in link was sent to ${email}.`,
    `Account created for ${name}, but the welcome email was NOT sent.`,
    <p className="muted small">
      Give {name.split(' ')[0]} the temporary password yourself (never by email). Sign in page: {loginUrl}. They must choose a new
      password at first sign in.
    </p>,
  );
}

export function StaffSection() {
  const actions = useActions();
  const list = useStaffList();
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<StaffMember | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [busyId, setBusyId] = useState('');

  async function toggle(member: StaffMember) {
    setBusyId(member.userId);
    setBanner(null);
    const result = await actions.setStaffActive(member.userId, !member.isActive);
    setBusyId('');
    if (!result.ok) return setBanner({ kind: 'error', title: result.message });
    setBanner({
      kind: 'success',
      title: member.isActive
        ? `${member.fullName || member.email} can no longer sign in to this clinic.`
        : `${member.fullName || member.email} has access again.`,
    });
    list.refresh();
  }

  async function resend(member: StaffMember) {
    setBusyId(member.userId);
    setBanner(null);
    const result = await actions.resendStaffEmail(member.userId);
    setBusyId('');
    if (!result.ok) return setBanner({ kind: 'error', title: result.message });
    setBanner(emailBanner(result.value.email, `The welcome email was sent to ${member.email}.`, 'The welcome email was NOT sent.'));
  }

  async function revoke(id: string, email: string) {
    setBusyId(id);
    const result = await actions.revokeInvitation(id);
    setBusyId('');
    if (!result.ok) return setBanner({ kind: 'error', title: result.message });
    setBanner({ kind: 'success', title: `The invitation to ${email} was cancelled.` });
    list.refresh();
  }

  const data = list.data;

  return (
    <section className="card" style={{ marginTop: 16 }} aria-labelledby="staff-title">
      <div className="row row--between" style={{ marginBottom: 12 }}>
        <h2 id="staff-title" className="card__title" style={{ margin: 0 }}>
          <Users size={20} aria-hidden="true" /> Staff logins
        </h2>
        <Button icon={UserPlus} onClick={() => setAdding(true)}>
          Add staff
        </Button>
      </div>
      <p className="muted">
        Receptionists can run the queue and see patient names and visit dates. Doctors can also read and write clinical notes
        and prescriptions. You give each new person a temporary password; they choose their own when they first sign in.
      </p>

      <LiveRegion>
        {banner && (
          <Notice kind={banner.kind} title={banner.title}>
            {banner.body}
          </Notice>
        )}
      </LiveRegion>

      {list.loading && !data && <p className="muted">Loading...</p>}
      {list.failure && !data && <Notice kind="error" title={list.failure.message} />}

      {data && (
        <div className="table-wrap">
          <table className="table table--stack">
            <caption className="sr-only">People with a login for this clinic</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.staff.map((member) => (
                <tr key={member.userId}>
                  <td data-label="Name">
                    <strong>{member.fullName || 'Not given'}</strong>
                  </td>
                  <td data-label="Email" style={{ overflowWrap: 'anywhere' }}>
                    {member.email}
                  </td>
                  <td data-label="Role">
                    {ROLE_LABEL[member.role]}
                    {member.doctorName && <span className="muted small"> ({member.doctorName})</span>}
                  </td>
                  <td data-label="Status">
                    {!member.isActive ? 'Switched off' : member.firstLoginPending ? 'Waiting for first sign in' : 'Active'}
                  </td>
                  <td data-label="Actions">
                    {member.role === 'owner' ? (
                      <span className="muted small">Not applicable</span>
                    ) : (
                      <div className="row" style={{ gap: 8 }}>
                        <Button size="sm" disabled={busyId === member.userId} onClick={() => void toggle(member)}>
                          {member.isActive ? 'Switch off' : 'Switch on'}
                          <span className="sr-only"> {member.fullName || member.email}</span>
                        </Button>
                        {member.firstLoginPending && (
                          <>
                            <Button size="sm" disabled={busyId === member.userId} onClick={() => void resend(member)}>
                              Resend email<span className="sr-only"> to {member.fullName || member.email}</span>
                            </Button>
                            <Button size="sm" onClick={() => setResetting(member)}>
                              New temporary password<span className="sr-only"> for {member.fullName || member.email}</span>
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.pendingInvitations.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 className="card__title">
            <MailCheck size={18} aria-hidden="true" /> Invitations waiting for a reply
          </h3>
          <ul className="stack--sm" style={{ listStyle: 'none', padding: 0 }}>
            {data.pendingInvitations.map((inv) => (
              <li key={inv.id} className="row row--between">
                <span style={{ overflowWrap: 'anywhere' }}>
                  {inv.email} <span className="muted small">({ROLE_LABEL[inv.role]})</span>
                </span>
                <Button size="sm" disabled={busyId === inv.id} onClick={() => void revoke(inv.id, inv.email)}>
                  Cancel invitation<span className="sr-only"> for {inv.email}</span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Dialog open={adding} title="Add staff" onClose={() => setAdding(false)}>
        {adding && (
          <AddStaffForm
            doctors={data?.doctorsWithoutLogin ?? []}
            onCancel={() => setAdding(false)}
            onDone={(next) => {
              setBanner(next);
              setAdding(false);
              list.refresh();
            }}
          />
        )}
      </Dialog>

      <Dialog open={resetting !== null} title="New temporary password" onClose={() => setResetting(null)}>
        {resetting && (
          <ResetPasswordForm
            member={resetting}
            onCancel={() => setResetting(null)}
            onDone={(next) => {
              setBanner(next);
              setResetting(null);
            }}
          />
        )}
      </Dialog>
    </section>
  );
}

function AddStaffForm({
  doctors,
  onCancel,
  onDone,
}: {
  doctors: { id: string; name: string; opd: string }[];
  onCancel: () => void;
  onDone: (banner: Banner) => void;
}) {
  const actions = useActions();
  const focusFirstError = useFocusFirstError();
  const formRef = useRef<HTMLFormElement>(null);
  const busy = useRef(false);
  const shown = useShowPasswords();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'receptionist' | 'doctor'>('receptionist');
  const [existingDoctor, setExistingDoctor] = useState(false);
  const [doctorId, setDoctorId] = useState('');
  const [specialization, setSpecialization] = useState('');
  const [qualification, setQualification] = useState('');
  const [doctorPhone, setDoctorPhone] = useState('');
  const [fee, setFee] = useState('');
  const [opd, setOpd] = useState('');
  const [tempPassword, setTempPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    const result = await actions.createStaff({
      fullName,
      email,
      role,
      tempPassword,
      confirmPassword,
      doctorId: role === 'doctor' && existingDoctor ? doctorId : undefined,
      newDoctor: role === 'doctor' && !existingDoctor ? { specialization, qualification, phone: doctorPhone, consultationFee: fee, opd } : undefined,
    });
    busy.current = false;
    setSending(false);
    if (result.ok) {
      onDone(createdBanner(result.value, fullName.trim(), email.trim().toLowerCase()));
      return;
    }
    setErrors(result.fieldErrors ?? {});
    setFailure(result);
    focusFirstError(formRef.current);
  }

  return (
    <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate>
      <TextField label="Full name" maxLength={60} autoComplete="off" value={fullName} onChange={(e) => setFullName(e.target.value)} error={errors.fullName} />
      <TextField
        label="Email address"
        type="email"
        inputMode="email"
        autoComplete="off"
        hint="The welcome email goes here. Double check it: it is also the sign in name."
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={errors.email}
      />
      <SelectField label="Role" value={role} onChange={(e) => setRole(e.target.value as 'receptionist' | 'doctor')} error={errors.role}>
        <option value="receptionist">Receptionist</option>
        <option value="doctor">Doctor</option>
      </SelectField>

      {role === 'doctor' && (
        <fieldset className="stack--sm">
          <legend>Doctor details</legend>
          {doctors.length > 0 && (
            <SelectField
              label="Doctor record"
              value={existingDoctor ? 'existing' : 'new'}
              onChange={(e) => setExistingDoctor(e.target.value === 'existing')}
            >
              <option value="new">A new doctor</option>
              <option value="existing">A doctor already in the clinic who has no login</option>
            </SelectField>
          )}
          {existingDoctor ? (
            <SelectField label="Which doctor?" value={doctorId} onChange={(e) => setDoctorId(e.target.value)} error={errors.doctorId}>
              <option value="">Choose a doctor</option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.opd})
                </option>
              ))}
            </SelectField>
          ) : (
            <>
              <TextField label="Specialisation" maxLength={60} value={specialization} onChange={(e) => setSpecialization(e.target.value)}
                error={errors.specialization} hint="For example General Physician or Dermatologist." />
              <TextField label="Qualification (optional)" maxLength={120} value={qualification} onChange={(e) => setQualification(e.target.value)} error={errors.qualification} />
              <TextField label="Doctor's mobile number (optional)" type="tel" inputMode="tel" value={doctorPhone} onChange={(e) => setDoctorPhone(e.target.value)} error={errors.doctorPhone} />
              <TextField label="Consultation fee in rupees (optional)" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} error={errors.consultationFee} />
              <TextField label="OPD name (optional)" maxLength={40} value={opd} onChange={(e) => setOpd(e.target.value)} error={errors.opd}
                hint="Patients see this, for example Skin OPD. Leave empty for General OPD." />
              <p className="muted small">After saving, set this doctor's weekly timings under Doctor schedules. Patients cannot book until timings are set.</p>
            </>
          )}
        </fieldset>
      )}

      <fieldset className="stack--sm">
        <legend>Temporary password</legend>
        <PasswordField label="Temporary password" type={shown.type} autoComplete="new-password" value={tempPassword} onChange={setTempPassword}
          error={errors.tempPassword} hint="At least 10 characters with a letter and a number. Tell the person yourself; it is never emailed." />
        <PasswordField label="Confirm temporary password" type={shown.type} autoComplete="new-password" value={confirmPassword} onChange={setConfirmPassword} error={errors.confirmPassword} />
        {shown.toggle}
        <Button
          size="sm"
          onClick={() => {
            const next = suggestPassword();
            setTempPassword(next);
            setConfirmPassword(next);
          }}
        >
          Suggest a password
        </Button>
      </fieldset>

      {failure && !failure.fieldErrors && <Notice kind="error" title={failure.message} />}
      {failure?.fieldErrors && <Notice kind="error" title="Please fix the highlighted fields." />}

      <div className="dialog__actions">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={sending}>
          {sending ? 'Creating...' : 'Create account'}
        </Button>
      </div>
    </form>
  );
}

function ResetPasswordForm({ member, onCancel, onDone }: { member: StaffMember; onCancel: () => void; onDone: (b: Banner) => void }) {
  const actions = useActions();
  const shown = useShowPasswords();
  const [tempPassword, setTempPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState('');
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    const result = await actions.resetStaffPassword(member.userId, tempPassword, confirmPassword);
    setSending(false);
    if (result.ok) {
      onDone(
        emailBanner(result.value.email, `A new temporary password is set for ${member.fullName || member.email}, and the email was sent.`,
          `A new temporary password is set for ${member.fullName || member.email}, but the email was NOT sent.`,
          <p className="muted small">Tell them the new password yourself. They still choose their own at first sign in.</p>),
      );
      return;
    }
    setErrors(result.fieldErrors ?? {});
    setProblem(result.fieldErrors ? '' : result.message);
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <p>
        This replaces the temporary password for <strong>{member.fullName || member.email}</strong>. It works only until they choose their own.
      </p>
      <PasswordField label="New temporary password" type={shown.type} autoComplete="new-password" value={tempPassword} onChange={setTempPassword} error={errors.tempPassword} />
      <PasswordField label="Confirm new temporary password" type={shown.type} autoComplete="new-password" value={confirmPassword} onChange={setConfirmPassword} error={errors.confirmPassword} />
      {shown.toggle}
      <Button size="sm" onClick={() => { const next = suggestPassword(); setTempPassword(next); setConfirmPassword(next); }}>
        Suggest a password
      </Button>
      {problem && <Notice kind="error" title={problem} />}
      <div className="dialog__actions">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={sending}>
          {sending ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
