// Demo entry point. Lists every screen so a reviewer can open each one.

import { Link } from 'react-router-dom';
import { ButtonLink, DemoTag, PageHeader } from '../components/ui';
import { IS_SUPABASE } from '../backend/mode';
import { DEMO_OTP } from '../domain/demoStaff';
import { RemoteHomeScreen } from './RemoteHomeScreen';

interface ScreenEntry {
  number: number;
  name: string;
  area: string;
  path: string;
  access: string;
  newTab?: boolean;
}

const SCREENS: ScreenEntry[] = [
  { number: 1, name: 'Token booking', area: 'Patient', path: '/book', access: 'Open to everyone' },
  { number: 2, name: 'Token confirmation', area: 'Patient', path: '/book', access: 'Shown after booking a token' },
  { number: 3, name: 'Live queue', area: 'Patient', path: '/queue', access: 'Open to everyone' },
  { number: 4, name: "Today's list", area: 'Reception', path: '/reception', access: 'Reception login' },
  { number: 5, name: 'Walk-in entry', area: 'Reception', path: '/reception/walk-in', access: 'Reception login' },
  { number: 6, name: 'Patient search', area: 'Reception', path: '/reception/patients', access: 'Reception login' },
  { number: 7, name: 'Next patient', area: 'Doctor', path: '/doctor', access: 'Doctor login' },
  { number: 8, name: 'Patient history', area: 'Doctor', path: '/doctor', access: 'Doctor login, opened from a patient' },
  { number: 9, name: 'Waiting room display', area: 'Waiting room', path: '/tv', access: 'Open to everyone', newTab: true },
  { number: 10, name: 'Daily report', area: 'Clinic owner', path: '/report', access: 'Owner or doctor login' },
  { number: 11, name: 'Settings', area: 'Clinic owner', path: '/settings', access: 'Owner login' },
  { number: 12, name: 'Staff login', area: 'Staff', path: '/login', access: 'Open to everyone' },
];

export function HomeScreen() {
  if (IS_SUPABASE) return <RemoteHomeScreen />;
  return (
    <>
      <PageHeader
        title="Cliniq"
        intro={
          <>
            Clinic queue management. A working prototype of a token and queue system. <DemoTag />
          </>
        }
      />

      <div className="grid grid--3">
        <section className="card" aria-labelledby="home-patient">
          <h2 id="home-patient">Patients</h2>
          <p className="muted">Book a token from your phone and follow the queue. No app and no login.</p>
          <div className="stack--sm stack">
            <ButtonLink to="/book" variant="primary" block>
              Book a token
            </ButtonLink>
            <ButtonLink to="/queue" block>
              View live queue
            </ButtonLink>
          </div>
        </section>

        <section className="card" aria-labelledby="home-staff">
          <h2 id="home-staff">Clinic staff</h2>
          <p className="muted">
            Reception, doctor and owner screens. Demo login code is <span className="mono">{DEMO_OTP}</span>.
          </p>
          <ButtonLink to="/login" variant="primary" block>
            Staff login
          </ButtonLink>
        </section>

        <section className="card" aria-labelledby="home-tv">
          <h2 id="home-tv">Waiting room</h2>
          <p className="muted">A large display for a TV or monitor. It shows token numbers only.</p>
          <a className="btn btn--block" href="/tv" target="_blank" rel="noopener noreferrer">
            Open waiting room display
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </section>
      </div>

      <section className="card" style={{ marginTop: 24 }} aria-labelledby="home-try">
        <h2 id="home-try">Try the whole flow</h2>
        <ol>
          <li>
            Book a token on <Link to="/book">Book a token</Link>. Note the token number.
          </li>
          <li>
            In a second tab of this browser, <Link to="/login">log in as reception</Link>. The token is in today's list.
            Add a walk-in patient from the Walk-in entry screen.
          </li>
          <li>
            In a third tab, log in as the General OPD doctor and press NEXT. Open the waiting room display in another
            tab.
          </li>
          <li>The live queue, reception list and waiting room display all change together.</li>
        </ol>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Tabs share data because the demo keeps everything in this browser. Different devices do not share data.
        </p>
      </section>

      <section style={{ marginTop: 24 }} aria-labelledby="home-screens">
        <h2 id="home-screens">All 12 screens</h2>
        <div className="table-wrap">
          <table className="table table--stack">
            <caption className="sr-only">All screens in this prototype</caption>
            <thead>
              <tr>
                <th scope="col">No.</th>
                <th scope="col">Screen</th>
                <th scope="col">Area</th>
                <th scope="col">Access</th>
              </tr>
            </thead>
            <tbody>
              {SCREENS.map((screen) => (
                <tr key={screen.number}>
                  <td data-label="No.">{screen.number}</td>
                  <td data-label="Screen">
                    {screen.newTab ? (
                      <a href={screen.path} target="_blank" rel="noopener noreferrer">
                        {screen.name}
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    ) : (
                      <Link to={screen.path}>{screen.name}</Link>
                    )}
                  </td>
                  <td data-label="Area">{screen.area}</td>
                  <td data-label="Access">{screen.access}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
