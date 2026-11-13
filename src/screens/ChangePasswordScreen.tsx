// Shown instead of every staff screen while an account still has the temporary password the clinic gave it.
// The server enforces this too (the account has no role anywhere until the password is changed), so this screen is
// the friendly side of a rule that does not depend on the screen.

import { useRef, useState, type FormEvent } from 'react';
import { useSupabaseAuth } from '../backend/auth';
import { PasswordField, useShowPasswords } from '../components/PasswordInputs';
import { Button, Notice, PageHeader } from '../components/ui';
import { useFocusFirstError } from '../state/hooks';

export function ForcePasswordChange() {
  const auth = useSupabaseAuth();
  const focusFirstError = useFocusFirstError();
  const formRef = useRef<HTMLFormElement>(null);
  const busy = useRef(false);
  const shown = useShowPasswords();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState('');
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    const result = await auth.changePassword({ currentPassword: current, newPassword: next, confirmPassword: again });
    busy.current = false;
    setWorking(false);
    if (result.ok) return; // the account reloads and the staff screens open
    setErrors(result.fieldErrors ?? {});
    setProblem(result.fieldErrors ? '' : result.message);
    if (result.fieldErrors) focusFirstError(formRef.current);
  }

  return (
    <div className="app">
      <main id="main" tabIndex={-1}>
        <div className="container container--narrow">
          <PageHeader
            title="Choose your own password"
            intro={`Welcome${auth.fullName ? `, ${auth.fullName.split(' ')[0]}` : ''}! Your clinic gave you a temporary password. For your safety, choose a private password that only you know before you continue.`}
          />
          <form ref={formRef} className="card" onSubmit={(e) => void submit(e)} noValidate>
            <PasswordField label="Temporary password" type={shown.type} autoComplete="current-password" value={current} onChange={setCurrent}
              error={errors.currentPassword} hint="The one your clinic gave you." />
            <PasswordField label="New password" type={shown.type} autoComplete="new-password" value={next} onChange={setNext}
              error={errors.newPassword} hint="At least 10 characters with a letter and a number. Not the temporary password." />
            <PasswordField label="Confirm new password" type={shown.type} autoComplete="new-password" value={again} onChange={setAgain}
              error={errors.confirmPassword} />
            {shown.toggle}
            {problem && <Notice kind="error" title={problem} />}
            <div className="dialog__actions">
              <Button onClick={() => void auth.signOut()}>Log out</Button>
              <Button type="submit" variant="primary" disabled={working}>
                {working ? 'Saving...' : 'Save new password'}
              </Button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
