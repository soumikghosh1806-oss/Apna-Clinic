// Screen 12: Staff login (demo only, no real authentication)

import { KeyRound, LogIn } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, ButtonLink, DemoTag, Notice, PageHeader, TextField } from '../components/ui';
import { DEMO_OTP, DEMO_STAFF, checkDemoLogin, type DemoStaff } from '../domain/demoStaff';
import { ROLE_HOME, canOpenPath } from '../domain/permissions';
import { formatPhone } from '../domain/validation';
import { getDoctor } from '../domain/queue';
import { useAppState, useAuth, type DemoSession } from '../state/context';
import { useFocusFirstError } from '../state/hooks';

const ROLE_NAME = { reception: 'Reception', doctor: 'Doctor', owner: 'Clinic owner' } as const;

export function LoginScreen() {
  const { session, login, logout } = useAuth();
  const state = useAppState();
  const navigate = useNavigate();
  const location = useLocation();
  const focusFirstError = useFocusFirstError();
  const formRef = useRef<HTMLFormElement>(null);

  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const from = (location.state as { from?: string } | null)?.from;

  function toSession(staff: DemoStaff): DemoSession {
    const doctor = staff.doctorId ? getDoctor(state, staff.doctorId) : undefined;
    return {
      role: staff.role,
      doctorId: staff.doctorId,
      label: doctor ? `${doctor.name}, ${doctor.opd}` : staff.label,
    };
  }

  function enter(staff: DemoStaff) {
    login(toSession(staff));
    navigate(from && canOpenPath(staff.role, from) ? from : ROLE_HOME[staff.role], { replace: true });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const check = checkDemoLogin(phone, otp);
    if (!check.ok) {
      setErrors({ [check.field]: check.message });
      focusFirstError(formRef.current);
      return;
    }
    enter(check.staff);
  }

  if (session) {
    return (
      <>
        <PageHeader title="Staff login" />
        <div className="card stack">
          <p>
            You are signed in as <strong>{ROLE_NAME[session.role]}</strong> in this tab.
          </p>
          <div className="row">
            <ButtonLink to={ROLE_HOME[session.role]} variant="primary">
              Open my screens
            </ButtonLink>
            <Button onClick={logout}>Log out</Button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Staff login" intro={<>Reception, doctors and the clinic owner. <DemoTag>Demo login</DemoTag></>} />

      <div className="stack">
        <Notice kind="info" title="This is a demo login, not real security." live={false}>
          <p>
            No code is sent to any phone. Use one of the demo numbers below with the code <strong className="mono">{DEMO_OTP}</strong>,
            or use the quick buttons.
          </p>
        </Notice>

        <form ref={formRef} onSubmit={submit} noValidate className="card">
          <TextField
            label="Mobile number"
            name="phone"
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            prefix="+91"
            maxLength={16}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            error={errors.phone}
          />
          <TextField
            label="One time code"
            name="otp"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={4}
            hint={`Demo code: ${DEMO_OTP}`}
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
            error={errors.otp}
          />
          <Button type="submit" variant="primary" size="lg" block icon={LogIn}>
            Log in
          </Button>
        </form>

        <section className="card" aria-labelledby="demo-access">
          <h2 id="demo-access" className="card__title">
            <KeyRound size={20} aria-hidden="true" />
            Demo access
          </h2>
          <ul className="list-plain list-rows">
            {DEMO_STAFF.map((staff) => {
              const doctor = staff.doctorId ? getDoctor(state, staff.doctorId) : undefined;
              const name = doctor ? `${ROLE_NAME[staff.role]}, ${doctor.opd}` : ROLE_NAME[staff.role];
              return (
                <li key={staff.phone}>
                  <span className="grow">
                    <strong>{name}</strong>
                    <br />
                    <span className="muted small mono">{formatPhone(staff.phone)}</span>
                  </span>
                  <Button size="sm" onClick={() => enter(staff)}>
                    Open as {name.toLowerCase()}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </>
  );
}
