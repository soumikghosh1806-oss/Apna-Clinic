// Where invitation and password reset emails lead. The link signs the person in for a moment, then they choose a password.

import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MIN_PASSWORD_LENGTH, useSupabaseAuth } from '../backend/auth';
import { Button, Notice, PageHeader, TextField } from '../components/ui';
import { ROLE_HOME } from '../domain/permissions';
import { useFocusFirstError } from '../state/hooks';

export function SetPasswordScreen() {
  const auth = useSupabaseAuth();
  const navigate = useNavigate();
  const focusFirstError = useFocusFirstError();
  const formRef = useRef<HTMLFormElement>(null);
  const busy = useRef(false);

  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState('');
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const next: Record<string, string> = {};
    if (password.length < MIN_PASSWORD_LENGTH) next.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    if (again !== password) next.again = 'The two passwords do not match.';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      setProblem('');
      focusFirstError(formRef.current);
      return;
    }
    busy.current = true;
    setWorking(true);
    const result = await auth.setPassword(password);
    busy.current = false;
    setWorking(false);
    if (!result.ok) {
      setErrors({});
      setProblem(result.message);
      return;
    }
    navigate(auth.active ? ROLE_HOME[auth.active.role] : '/login', { replace: true });
  }

  if (auth.phase === 'loading') {
    return (
      <>
        <PageHeader title="Choose a password" />
        <p className="muted" role="status">
          Checking your link...
        </p>
      </>
    );
  }

  if (auth.phase === 'signed_out' || auth.phase === 'error') {
    return (
      <>
        <PageHeader title="Choose a password" />
        <Notice kind="warning" title="This link has expired or was already used.">
          <p>
            Go to the <Link to="/login">login page</Link> and choose "Forgot your password?" to get a new link. If you
            were invited to a clinic, ask the clinic owner to invite you again.
          </p>
        </Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Choose a password"
        intro={<>Signed in as <strong>{auth.email}</strong>. Choose a password for next time.</>}
      />
      <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate className="card">
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        <TextField
          label="Type the password again"
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          error={errors.again}
        />
        {problem && <Notice kind="error" title={problem} />}
        <Button type="submit" variant="primary" size="lg" block disabled={working}>
          {working ? 'Saving...' : 'Save password'}
        </Button>
      </form>
    </>
  );
}
