// Screen 12 with the real backend: staff sign in with an email address and a password.

import { LogIn } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useSupabaseAuth } from '../backend/auth';
import { Button, ButtonLink, LiveRegion, Notice, PageHeader, TextField } from '../components/ui';
import { ROLE_HOME, canOpenPath } from '../domain/permissions';
import { useFocusFirstError } from '../state/hooks';

const ROLE_NAME = { reception: 'Receptionist', doctor: 'Doctor', owner: 'Clinic owner' } as const;

export function RemoteLoginScreen() {
  const auth = useSupabaseAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const focusFirstError = useFocusFirstError();
  const formRef = useRef<HTMLFormElement>(null);
  const busy = useRef(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState('');
  const [info, setInfo] = useState('');
  const [working, setWorking] = useState(false);

  const from = (location.state as { from?: string } | null)?.from;
  const active = auth.active;

  // Once the account and its clinic are known, go to the right screen. This also covers a returning visitor who is
  // already signed in.
  useEffect(() => {
    // Someone with a temporary password goes straight to the screen where they choose their own.
    if (auth.phase === 'signed_in' && auth.mustChangePassword && active) {
      navigate(ROLE_HOME[active.role], { replace: true });
      return;
    }
    if (auth.phase === 'signed_in' && active && from) {
      navigate(canOpenPath(active.role, from) ? from : ROLE_HOME[active.role], { replace: true });
    }
  }, [auth.phase, auth.mustChangePassword, active, from, navigate]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    setInfo('');
    const next: Record<string, string> = {};
    if (!email.trim()) next.email = 'Enter your email address.';
    if (!password) next.password = 'Enter your password.';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      setProblem('');
      focusFirstError(formRef.current);
      return;
    }
    busy.current = true;
    setWorking(true);
    const result = await auth.signIn(email.trim(), password);
    busy.current = false;
    setWorking(false);
    if (result.ok) {
      setErrors({});
      setProblem('');
      setPassword('');
      return;
    }
    setErrors({});
    setProblem(result.message);
  }

  async function forgot() {
    setProblem('');
    if (!email.trim()) {
      setErrors({ email: 'Enter your email address first, then choose "Forgot your password?".' });
      focusFirstError(formRef.current);
      return;
    }
    setErrors({});
    setWorking(true);
    const result = await auth.sendPasswordReset(email.trim());
    setWorking(false);
    if (result.ok) setInfo('If that email address has an account, a link to choose a new password is on its way.');
    else setProblem(result.message);
  }

  if (auth.phase === 'loading') {
    return (
      <>
        <PageHeader title="Staff login" />
        <p className="muted" role="status">
          Loading...
        </p>
      </>
    );
  }

  if (auth.phase === 'error') {
    return (
      <>
        <PageHeader title="Staff login" />
        <Notice kind="error" title="We could not check your account.">
          <p>Check your internet connection and try again.</p>
        </Notice>
        <p style={{ marginTop: 16 }}>
          <Button variant="primary" onClick={() => void auth.reload()}>
            Try again
          </Button>
        </p>
      </>
    );
  }

  if (auth.phase === 'signed_in') {
    if (!active) {
      return (
        <>
          <PageHeader title="Staff login" />
          <div className="card stack">
            <Notice kind="info" title="This account is not linked to a clinic yet." live={false}>
              <p>
                You are signed in as <strong>{auth.email}</strong>. If you own a clinic, register it. If you work at a
                clinic, ask the clinic owner to send you an invitation to this email address.
              </p>
            </Notice>
            {auth.pendingInvitations > 0 && (
              <Notice kind="success" title={`You have ${auth.pendingInvitations} clinic invitation${auth.pendingInvitations === 1 ? '' : 's'} waiting.`}>
                <p>
                  <ButtonLink to="/invitations" variant="primary">
                    See my invitations
                  </ButtonLink>
                </p>
              </Notice>
            )}
            <div className="row">
              <ButtonLink to="/register" variant="primary">
                Register a clinic
              </ButtonLink>
              <Button onClick={() => void auth.signOut()}>Log out</Button>
            </div>
          </div>
        </>
      );
    }
    return (
      <>
        <PageHeader title="Staff login" />
        <div className="card stack">
          <p>
            You are signed in as <strong>{auth.fullName || auth.email}</strong>, {ROLE_NAME[active.role].toLowerCase()} at{' '}
            <strong>{active.name}</strong>.
          </p>
          {auth.pendingInvitations > 0 && (
            <Notice kind="success" title={`You have ${auth.pendingInvitations} clinic invitation${auth.pendingInvitations === 1 ? '' : 's'} waiting.`}>
              <p>
                <ButtonLink to="/invitations">See my invitations</ButtonLink>
              </p>
            </Notice>
          )}
          <div className="row">
            <ButtonLink to={ROLE_HOME[active.role]} variant="primary">
              Open my screens
            </ButtonLink>
            <Button onClick={() => void auth.signOut()}>Log out</Button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Staff login" intro="Receptionists, doctors and the clinic owner sign in here." />
      <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate className="card">
        <TextField
          label="Email address"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        <LiveRegion>
          {problem && <Notice kind="error" title={problem} />}
          {info && <Notice kind="success" title={info} />}
        </LiveRegion>
        <div className="stack stack--sm">
          <Button type="submit" variant="primary" size="lg" block icon={LogIn} disabled={working}>
            {working ? 'Please wait...' : 'Log in'}
          </Button>
          <Button variant="quiet" block disabled={working} onClick={() => void forgot()}>
            Forgot your password?
          </Button>
        </div>
      </form>
      <p className="muted" style={{ marginTop: 16 }}>
        New clinic? <Link to="/register">Register your clinic</Link>. Staff who were invited get an email with a link to
        choose a password.
      </p>
    </>
  );
}
