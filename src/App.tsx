import { useEffect, useRef } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { IS_SUPABASE, PLATFORM_NAME } from './backend/mode';
import { PublicClinicGate } from './backend/publicClinic';
import { StaffDataGate } from './backend/staffGate';
import { RequireRole } from './components/RequireRole';
import { PublicLayout, StaffLayout } from './components/Shell';
import { BookScreen } from './screens/BookScreen';
import { ConfirmScreen } from './screens/ConfirmScreen';
import { DoctorPanelScreen } from './screens/DoctorPanelScreen';
import { HomeScreen } from './screens/HomeScreen';
import { InvitationsScreen } from './screens/InvitationsScreen';
import { NotFoundScreen, PrivacyScreen, TermsScreen } from './screens/LegalScreens';
import { LiveQueueScreen } from './screens/LiveQueueScreen';
import { LoginScreen } from './screens/LoginScreen';
import { PatientHistoryScreen } from './screens/PatientHistoryScreen';
import { PatientSearchScreen } from './screens/PatientSearchScreen';
import { ReceptionListScreen } from './screens/ReceptionListScreen';
import { RegisterClinicScreen } from './screens/RegisterClinicScreen';
import { RemoteLoginScreen } from './screens/RemoteLoginScreen';
import { ReportScreen } from './screens/ReportScreen';
import { SetPasswordScreen } from './screens/SetPasswordScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { TvScreen } from './screens/TvScreen';
import { WalkInScreen } from './screens/WalkInScreen';

const TITLES: [prefix: string, title: string][] = [
  ['/book', 'Book a token'],
  ['/token', 'Your token'],
  ['/queue', 'Live queue'],
  ['/login', 'Staff login'],
  ['/register', 'Register your clinic'],
  ['/set-password', 'Choose a password'],
  ['/invitations', 'Clinic invitations'],
  ['/reception/walk-in', 'Walk-in entry'],
  ['/reception/patients', 'Patient search'],
  ['/reception', "Today's list"],
  ['/doctor/history', 'Patient history'],
  ['/doctor', 'Next patient'],
  ['/tv', 'Waiting room display'],
  ['/report', 'Daily report'],
  ['/settings', 'Settings'],
  ['/privacy', 'Privacy Policy'],
  ['/terms', 'Terms and Conditions'],
];

function titleFor(pathname: string): string {
  const match = TITLES.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  if (pathname === '/') return IS_SUPABASE ? `${PLATFORM_NAME}: Book your doctor appointment` : PLATFORM_NAME;
  return match ? `${match[1]} | ${PLATFORM_NAME}` : `Page not found | ${PLATFORM_NAME}`;
}

/** Sets the page title and moves focus to the page heading after each navigation, for screen reader and keyboard users. */
function RouteEffects() {
  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    document.title = titleFor(pathname);
    if (first.current) {
      first.current = false;
      return;
    }
    // Wait for the new screen to render before looking for its heading.
    const id = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('main h1')?.focus({ preventScroll: false });
    });
    return () => window.cancelAnimationFrame(id);
  }, [pathname]);
  return null;
}

// With the real backend, patient pages read a clinic's public details and staff pages read the clinic's data. Each
// gate does that once for the pages inside it. A route with no element just passes through, which is what the demo gets.
const publicGate = IS_SUPABASE ? <PublicClinicGate /> : undefined;
const staffGate = IS_SUPABASE ? <StaffDataGate /> : undefined;

export function App() {
  return (
    <>
      <RouteEffects />
      <Routes>
        <Route element={publicGate}>
          <Route element={<PublicLayout />}>
            <Route path="/book" element={<BookScreen />} />
            <Route path="/token/:tokenId" element={<ConfirmScreen />} />
            <Route path="/queue/:tokenId?" element={<LiveQueueScreen />} />
            <Route path="/login" element={IS_SUPABASE ? <RemoteLoginScreen /> : <LoginScreen />} />
            {IS_SUPABASE && <Route path="/register" element={<RegisterClinicScreen />} />}
            {IS_SUPABASE && <Route path="/set-password" element={<SetPasswordScreen />} />}
            {IS_SUPABASE && <Route path="/invitations" element={<InvitationsScreen />} />}
          </Route>

          <Route element={<PublicLayout wide />}>
            <Route path="/" element={<HomeScreen />} />
            <Route path="/privacy" element={<PrivacyScreen />} />
            <Route path="/terms" element={<TermsScreen />} />
            <Route path="*" element={<NotFoundScreen />} />
          </Route>

          <Route path="/tv" element={<TvScreen />} />
        </Route>

        <Route element={staffGate}>
          <Route element={<StaffLayout />}>
            <Route element={<RequireRole roles={['reception']} />}>
              <Route path="/reception" element={<ReceptionListScreen />} />
              <Route path="/reception/walk-in" element={<WalkInScreen />} />
              <Route path="/reception/patients" element={<PatientSearchScreen />} />
            </Route>
            <Route element={<RequireRole roles={['doctor']} />}>
              <Route path="/doctor" element={<DoctorPanelScreen />} />
              <Route path="/doctor/history/:patientId" element={<PatientHistoryScreen />} />
            </Route>
            <Route element={<RequireRole roles={['owner', 'doctor']} />}>
              <Route path="/report" element={<ReportScreen />} />
            </Route>
            <Route element={<RequireRole roles={['owner']} />}>
              <Route path="/settings" element={<SettingsScreen />} />
            </Route>
          </Route>
        </Route>
      </Routes>
    </>
  );
}
