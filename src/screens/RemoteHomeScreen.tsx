// The home page with the real backend. Without a clinic address it is the Cliniq landing page. With a clinic
// address (/c/<clinic>) it is that clinic's own front page for patients.

import { ClinicDirectory } from '../components/ClinicDirectory';
import { ClinicNotice } from '../components/ClinicNotice';
import { ButtonLink, PageHeader } from '../components/ui';
import { clinicPath, useClinicSlug } from '../backend/clinicRoute';
import { usePublicClinicContext } from '../backend/publicClinic';
import { useSupabaseAuth } from '../backend/auth';
import { ROLE_HOME } from '../domain/permissions';

export function RemoteHomeScreen() {
  const slug = useClinicSlug();
  return slug ? <ClinicHome slug={slug} /> : <Landing />;
}

function ClinicHome({ slug }: { slug: string }) {
  const clinic = usePublicClinicContext();
  if (!clinic || clinic.load !== 'ready' || !clinic.data) {
    return (
      <>
        <PageHeader title="Cliniq" />
        <ClinicNotice load={clinic?.load ?? 'loading'} message={clinic?.message} />
      </>
    );
  }
  const { clinicName, onlineBookingEnabled } = clinic.data;
  return (
    <>
      <PageHeader
        title={clinicName}
        intro={
          onlineBookingEnabled
            ? 'Book a token from your phone and follow the queue. No app and no login.'
            : 'Online booking is switched off right now. You can still follow the queue, or book at the reception desk.'
        }
      />
      <div className="grid grid--3">
        <section className="card" aria-labelledby="home-patient">
          <h2 id="home-patient">Patients</h2>
          <p className="muted">Get a token number and see how many people are ahead of you.</p>
          <div className="stack--sm stack">
            <ButtonLink to="/book" variant="primary" block>
              Book a token
            </ButtonLink>
            <ButtonLink to="/queue" block>
              View live queue
            </ButtonLink>
          </div>
        </section>
        <section className="card" aria-labelledby="home-tv">
          <h2 id="home-tv">Waiting room</h2>
          <p className="muted">A large display for a TV or monitor. It shows token numbers only.</p>
          <a className="btn btn--block" href={clinicPath(slug, 'tv')} target="_blank" rel="noopener noreferrer">
            Open waiting room display
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </section>
        <section className="card" aria-labelledby="home-staff">
          <h2 id="home-staff">Clinic staff</h2>
          <p className="muted">Reception, doctors and the clinic owner.</p>
          <a className="btn btn--block" href="/login">
            Staff login
          </a>
        </section>
      </div>
    </>
  );
}

function Landing() {
  const auth = useSupabaseAuth();
  const active = auth.phase === 'signed_in' ? auth.active : null;
  return (
    <>
      <PageHeader
        title="Book Your Doctor Appointment"
        intro="Find your clinic, pick a doctor and get a token on your phone. Follow the live queue from home and go to the clinic when your turn is near."
      />

      <ClinicDirectory />

      <section aria-labelledby="how-title" className="how">
        <h2 id="how-title">How it works</h2>
        <ol className="how__steps">
          <li className="card">
            <h3>1. Choose</h3>
            <p className="muted">Search for your clinic, then pick the doctor and the day. Sessions and timings are the doctor&apos;s own.</p>
          </li>
          <li className="card">
            <h3>2. Get your token</h3>
            <p className="muted">
              Enter your name and mobile number. Some clinics send a 6 digit code first to check it is really you. You get a token number at once.
            </p>
          </li>
          <li className="card">
            <h3>3. Follow the queue</h3>
            <p className="muted">
              Open the live queue to see who is being seen now, how many are waiting and an estimated time. Estimates are guesses and change during the day.
            </p>
          </li>
        </ol>
        <p className="muted small">
          Only clinics that choose to be listed appear here. Patient names and phone numbers are never shown to the public.
        </p>
      </section>

      <div className="grid grid--2">
        <section className="card" aria-labelledby="home-owner">
          <h2 id="home-owner">Clinic owners</h2>
          <p className="muted">Set up your clinic, add your doctors and their timings, and add your reception staff.</p>
          <ButtonLink to="/register" variant="primary" block>
            Register your clinic
          </ButtonLink>
        </section>
        <section className="card" aria-labelledby="home-staff">
          <h2 id="home-staff">Clinic staff</h2>
          <p className="muted">Doctors, reception and clinic owners sign in with their email address.</p>
          <ButtonLink to={active ? ROLE_HOME[active.role] : '/login'} block>
            {active ? 'Open my screens' : 'Staff login'}
          </ButtonLink>
        </section>
      </div>
    </>
  );
}
