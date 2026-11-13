// Clinic registration with the real backend. Step 1 creates the owner's account, step 2 creates the clinic.
// The database makes the signed in person the owner and keeps the clinic's data separate from every other clinic.

import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MIN_PASSWORD_LENGTH, useSupabaseAuth } from '../backend/auth';
import { rpc } from '../backend/rpc';
import { SLUG_MAX, isValidSlug, slugify } from '../backend/slug';
import { Button, Notice, PageHeader, TextField } from '../components/ui';
import { ROLE_HOME } from '../domain/permissions';
import { useFocusFirstError } from '../state/hooks';

const TIMEZONE = 'Asia/Kolkata';

export function RegisterClinicScreen() {
  const auth = useSupabaseAuth();

  if (auth.phase === 'loading') {
    return (
      <>
        <PageHeader title="Register your clinic" />
        <p className="muted" role="status">
          Loading...
        </p>
      </>
    );
  }
  if (auth.phase === 'error') {
    return (
      <>
        <PageHeader title="Register your clinic" />
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
  return auth.phase === 'signed_out' ? <AccountStep /> : <ClinicStep />;
}

function AccountStep() {
  const auth = useSupabaseAuth();
  const focusFirstError = useFocusFirstError();
  const formRef = useRef<HTMLFormElement>(null);
  const busy = useRef(false);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState('');
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const next: Record<string, string> = {};
    if (fullName.trim().length < 2) next.fullName = 'Enter your name (2 to 60 characters).';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) next.email = 'Enter a valid email address.';
    if (password.length < MIN_PASSWORD_LENGTH) next.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    if (Object.keys(next).length > 0) {
      setErrors(next);
      setProblem('');
      focusFirstError(formRef.current);
      return;
    }
    busy.current = true;
    setWorking(true);
    const result = await auth.signUp({ email: email.trim(), password, fullName: fullName.trim() });
    busy.current = false;
    setWorking(false);
    if (!result.ok) {
      setErrors({});
      setProblem(result.message);
      return;
    }
    setProblem('');
    setErrors({});
    // When the project asks people to confirm their email first, there is no session yet.
    if (!result.value.signedIn) setNeedsConfirm(true);
  }

  if (needsConfirm) {
    return (
      <>
        <PageHeader title="Check your email" />
        <Notice kind="success" title="We sent you a link to confirm your email address.">
          <p>
            Open the link in that email, then <Link to="/login">log in</Link> and come back to this page to register
            your clinic.
          </p>
        </Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Register your clinic"
        intro="Step 1 of 2. Create the account you will use as the clinic owner."
      />
      <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate className="card">
        <TextField
          label="Your name"
          autoComplete="name"
          maxLength={60}
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          error={errors.fullName}
        />
        <TextField
          label="Email address"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        {problem && <Notice kind="error" title={problem} />}
        <Button type="submit" variant="primary" size="lg" block disabled={working}>
          {working ? 'Please wait...' : 'Create account'}
        </Button>
      </form>
      <p className="muted" style={{ marginTop: 16 }}>
        Already have an account? <Link to="/login">Log in</Link>.
      </p>
    </>
  );
}

function ClinicStep() {
  const auth = useSupabaseAuth();
  const navigate = useNavigate();
  const focusFirstError = useFocusFirstError();
  const formRef = useRef<HTMLFormElement>(null);
  const busy = useRef(false);

  const [clinicName, setClinicName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [ownerName, setOwnerName] = useState(auth.fullName);
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [stateName, setStateName] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState('');
  const [working, setWorking] = useState(false);

  function changeName(value: string) {
    setClinicName(value);
    if (!slugTouched) setSlug(slugify(value));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const next: Record<string, string> = {};
    if (clinicName.trim().length < 2) next.clinicName = 'The clinic name needs 2 to 60 characters.';
    if (ownerName.trim().length < 2) next.ownerName = 'Your name needs 2 to 60 characters.';
    if (!isValidSlug(slug)) next.slug = 'Use 3 to 40 lowercase letters, numbers and single hyphens.';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      setProblem('');
      focusFirstError(formRef.current);
      return;
    }
    busy.current = true;
    setWorking(true);
    const answer = await rpc('register_clinic', {
      p_clinic_name: clinicName,
      p_slug: slug,
      p_owner_name: ownerName,
      p_phone: phone.trim() || null,
      p_city: city.trim() || null,
      p_state: stateName.trim() || null,
      p_timezone: TIMEZONE,
    });
    if (!answer.ok) {
      busy.current = false;
      setWorking(false);
      setErrors(answer.fieldErrors ?? {});
      setProblem(answer.fieldErrors ? '' : answer.message);
      focusFirstError(formRef.current);
      return;
    }
    // Read the clinics again so the new clinic becomes the active one, then open the owner's first screen.
    await auth.reload();
    busy.current = false;
    setWorking(false);
    navigate(ROLE_HOME.owner, { replace: true });
  }

  return (
    <>
      <PageHeader
        title="Register your clinic"
        intro={
          <>
            Step 2 of 2. Signed in as <strong>{auth.email}</strong>. You will be the clinic owner.
          </>
        }
      />
      <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate className="card">
        <TextField
          label="Clinic name"
          maxLength={60}
          value={clinicName}
          onChange={(e) => changeName(e.target.value)}
          error={errors.clinicName}
        />
        <TextField
          label="Clinic web address"
          maxLength={SLUG_MAX}
          autoCapitalize="none"
          spellCheck={false}
          hint={
            <>
              Patients open <span className="mono">/c/{slug || 'your-clinic'}/book</span> to book a token. You cannot
              change this later without telling your patients.
            </>
          }
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value.toLowerCase());
          }}
          error={errors.slug}
        />
        <TextField
          label="Your name"
          autoComplete="name"
          maxLength={60}
          value={ownerName}
          onChange={(e) => setOwnerName(e.target.value)}
          error={errors.ownerName}
        />
        <TextField
          label="Clinic phone (optional)"
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          prefix="+91"
          maxLength={16}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          error={errors.phone}
        />
        <div className="grid grid--2">
          <TextField label="City (optional)" maxLength={60} value={city} onChange={(e) => setCity(e.target.value)} />
          <TextField label="State (optional)" maxLength={60} value={stateName} onChange={(e) => setStateName(e.target.value)} />
        </div>
        {errors.timezone && <Notice kind="error" title={errors.timezone} />}
        {problem && <Notice kind="error" title={problem} />}
        <Button type="submit" variant="primary" size="lg" block disabled={working}>
          {working ? 'Creating your clinic...' : 'Create clinic'}
        </Button>
      </form>
      <p className="muted" style={{ marginTop: 16 }}>
        Next you can add doctors under Settings, then invite your receptionist and doctors by email.
      </p>
    </>
  );
}
