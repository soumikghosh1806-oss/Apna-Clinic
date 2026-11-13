import {
  ChartColumn,
  ClipboardList,
  Info,
  LogIn,
  LogOut,
  Monitor,
  Play,
  RotateCcw,
  Search,
  Settings as SettingsIcon,
  Stethoscope,
  Ticket,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useOptionalSupabaseAuth, useSupabaseAuth } from '../backend/auth';
import { clinicPath, useClinicSlug } from '../backend/clinicRoute';
import { IS_SUPABASE, PLATFORM_NAME } from '../backend/mode';
import { usePublicClinicContext } from '../backend/publicClinic';
import { useStaffContext } from '../backend/staffGate';
import { ROLE_HOME } from '../domain/permissions';
import type { Role } from '../domain/types';
import { useActions, useAuth, useOptionalAppState } from '../state/context';
import { forgetAllTokens } from '../state/hooks';
import { ConfirmDialog } from './Dialog';
import { Button, LiveRegion, Notice } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Opens in a new tab, used for the waiting room display. */
  newTab?: boolean;
  /** A plain link that leaves the clinic address prefix, for example from /c/sunrise/book to /login. */
  external?: boolean;
  end?: boolean;
}

const PUBLIC_NAV: NavItem[] = [
  { to: '/book', label: 'Book a token', icon: Ticket },
  { to: '/queue', label: 'Live queue', icon: Users },
];

const STAFF_NAV: Record<Role, NavItem[]> = {
  reception: [
    { to: '/reception', label: "Today's list", icon: ClipboardList, end: true },
    { to: '/reception/walk-in', label: 'Walk-in entry', icon: UserPlus },
    { to: '/reception/patients', label: 'Patient search', icon: Search },
    { to: '/tv', label: 'Waiting room display', icon: Monitor, newTab: true },
  ],
  doctor: [
    { to: '/doctor', label: 'Next patient', icon: Play },
    { to: '/report', label: 'Daily report', icon: ChartColumn },
    { to: '/tv', label: 'Waiting room display', icon: Monitor, newTab: true },
  ],
  owner: [
    { to: '/report', label: 'Daily report', icon: ChartColumn },
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
    { to: '/tv', label: 'Waiting room display', icon: Monitor, newTab: true },
  ],
};

const ROLE_LABEL: Record<Role, string> = {
  reception: 'Reception',
  doctor: 'Doctor',
  owner: 'Clinic owner',
};

function DemoBanner() {
  return (
    <section className="demo-banner" aria-label="Demo notice">
      <div className="demo-banner__inner">
        <Info size={16} aria-hidden="true" />
        <span>
          Demo with sample data only. Please do not enter real patient details. Nothing is sent to any server, SMS or
          WhatsApp.
        </span>
      </div>
    </section>
  );
}

function NavLinks({ items, label }: { items: NavItem[]; label: string }) {
  return (
    <nav className="main-nav" aria-label={label}>
      {items.map((item) =>
        item.newTab ? (
          <a key={item.to} href={item.to} target="_blank" rel="noopener noreferrer">
            <item.icon size={18} aria-hidden="true" />
            {item.label}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : item.external ? (
          <a key={item.to} href={item.to}>
            <item.icon size={18} aria-hidden="true" />
            {item.label}
          </a>
        ) : (
          <NavLink key={item.to} to={item.to} end={item.end}>
            <item.icon size={18} aria-hidden="true" />
            {item.label}
          </NavLink>
        ),
      )}
    </nav>
  );
}

export function ResetDemoButton() {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const actions = useActions();

  return (
    <>
      <button type="button" className="btn btn--quiet btn--sm" onClick={() => setOpen(true)}>
        <RotateCcw size={16} aria-hidden="true" />
        Reset demo data
      </button>
      <LiveRegion>{done ? <span className="sr-only">Demo data was reset.</span> : null}</LiveRegion>
      <ConfirmDialog
        open={open}
        title="Reset all demo data?"
        confirmLabel="Reset demo data"
        danger
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          actions.resetDemo();
          forgetAllTokens();
          setOpen(false);
          setDone(true);
        }}
      >
        <p>
          This removes every booking, walk-in, note and setting you changed in this browser and brings back the original
          sample data. It cannot be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <p className="muted" style={{ margin: 0 }}>
          {IS_SUPABASE
            ? `${PLATFORM_NAME} keeps each clinic's records separate and private.`
            : 'Demo data is saved in this browser only. It is not a secure database.'}
        </p>
        <ul>
          <li>
            <Link to="/privacy">Privacy Policy</Link>
          </li>
          <li>
            <Link to="/terms">Terms and Conditions</Link>
          </li>
          {!IS_SUPABASE && (
            <li>
              <ResetDemoButton />
            </li>
          )}
        </ul>
      </div>
    </footer>
  );
}

/** The clinic's name: from the staff data on staff screens, from the public clinic details on patient pages. */
function useClinicName(): string {
  const state = useOptionalAppState();
  const publicClinic = usePublicClinicContext();
  return state?.settings.clinicName ?? publicClinic?.data?.clinicName ?? PLATFORM_NAME;
}

function Brand({ to = '/' }: { to?: string }) {
  const name = useClinicName();
  return (
    <Link to={to} className="brand">
      <span className="brand__mark">
        <Stethoscope size={20} aria-hidden="true" />
      </span>
      <span className="brand__name">{name}</span>
    </Link>
  );
}

function Frame({ children, header }: { children: React.ReactNode; header: React.ReactNode }) {
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="site-header">
        <div className="site-header__inner">{header}</div>
      </header>
      {!IS_SUPABASE && <DemoBanner />}
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <Footer />
    </div>
  );
}

/** Layout for patients and public pages. Patients do not sign in. */
export function PublicLayout({ wide = false }: { wide?: boolean }) {
  const { session } = useAuth();
  const slug = useClinicSlug();
  // With a real backend, patient pages sit under /c/<clinic address>, and staff pages do not. Links from one to
  // the other must leave that prefix, so they are plain links.
  const staffItem: NavItem = session
    ? { to: ROLE_HOME[session.role], label: 'Staff screens', icon: ClipboardList, external: IS_SUPABASE && slug !== null }
    : { to: '/login', label: 'Staff login', icon: LogIn, external: IS_SUPABASE && slug !== null };
  const items: NavItem[] =
    IS_SUPABASE && slug === null
      ? [{ to: '/register', label: 'Register your clinic', icon: UserPlus }, staffItem]
      : [...PUBLIC_NAV, staffItem];
  return (
    <Frame
      header={
        <>
          <Brand />
          <NavLinks items={items} label="Main" />
        </>
      }
    >
      <div className={wide ? 'container' : 'container container--narrow'}>
        <Outlet />
      </div>
    </Frame>
  );
}

/** Layout for logged in staff. Navigation depends on the demo role. */
export function StaffLayout() {
  const { session, logout, loading } = useAuth();
  const staff = useStaffContext();
  const auth = useOptionalSupabaseAuth();
  const navigate = useNavigate();
  const location = useLocation();
  if (loading) {
    return (
      <Frame header={<Brand />}>
        <div className="container">
          <p className="muted" role="status">
            Loading...
          </p>
        </div>
      </Frame>
    );
  }
  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  // The waiting room display is a public page of this clinic, so with a real backend it lives under the clinic address.
  const items = STAFF_NAV[session.role].map((item) =>
    IS_SUPABASE && item.to === '/tv' && staff ? { ...item, to: clinicPath(staff.clinic.slug, 'tv') } : item,
  );
  return (
    <Frame
      header={
        <>
          <Brand to={IS_SUPABASE ? ROLE_HOME[session.role] : '/'} />
          <NavLinks items={items} label={`${ROLE_LABEL[session.role]} screens`} />
          <div className="header-user">
            {IS_SUPABASE && <ClinicSwitcher />}
            <span>
              <span className="sr-only">Signed in as </span>
              <strong>{ROLE_LABEL[session.role]}</strong>
              {!IS_SUPABASE && session.role === 'doctor' && <span className="muted"> (demo)</span>}
            </span>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => {
                void (async () => {
                  await logout();
                  navigate('/login');
                })();
              }}
            >
              <LogOut size={16} aria-hidden="true" />
              Log out
            </button>
          </div>
        </>
      }
    >
      <div className="container">
        {IS_SUPABASE && auth && auth.pendingInvitations > 0 && (
          <div style={{ marginBottom: 16 }}>
            <Notice kind="info" title="A clinic has invited you to join.">
              <p>
                <Link to="/invitations">See your invitations</Link>
              </p>
            </Notice>
          </div>
        )}
        {staff?.status.stale && (
          <div style={{ marginBottom: 16 }}>
            <Notice kind="warning" title="You are seeing the last saved view.">
              <p>The connection to the clinic is not working right now. What you see may be out of date.</p>
              <Button size="sm" onClick={() => void staff.reload()}>
                Try again
              </Button>
            </Notice>
          </div>
        )}
        <Outlet />
      </div>
    </Frame>
  );
}

/** Lets an account that works in several clinics choose which one the staff screens show. */
function ClinicSwitcher() {
  const auth = useSupabaseAuth();
  const navigate = useNavigate();
  if (auth.memberships.length < 2) return null;
  return (
    <select
      className="select"
      aria-label="Clinic"
      value={auth.active?.clinicId ?? ''}
      onChange={(e) => {
        const chosen = auth.memberships.find((m) => m.clinicId === e.target.value);
        if (!chosen) return;
        auth.setActive(chosen.clinicId);
        // The same person can have a different role in another clinic, so start from that role's home screen.
        navigate(ROLE_HOME[chosen.role]);
      }}
    >
      {auth.memberships.map((m) => (
        <option key={m.clinicId} value={m.clinicId}>
          {m.name}
        </option>
      ))}
    </select>
  );
}
