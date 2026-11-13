import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { shiftToZone } from '../backend/time';
import { ROLE_HOME } from '../domain/permissions';
import type { Actor, AppState, Role } from '../domain/types';
import { createActions, type Actions } from './actions';
import type { StateSource, Store } from './store';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const StoreContext = createContext<StateSource | null>(null);

export function StoreProvider({ store, children }: { store: StateSource; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): StateSource {
  const store = useContext(StoreContext);
  if (!store) throw new Error('StoreProvider is missing');
  return store;
}

/** The latest shared state. Re-renders the screen whenever any part of it changes. */
export function useAppState(): AppState {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

const noSubscribe = () => () => undefined;
const noState = () => null;

/** Like useAppState, but returns null on pages that have no shared state (public pages with a real backend). */
export function useOptionalAppState(): AppState | null {
  const store = useContext(StoreContext);
  return useSyncExternalStore(store ? store.subscribe : noSubscribe, store ? store.getState : noState, store ? store.getState : noState);
}

// ---------------------------------------------------------------------------
// Demo session
// ---------------------------------------------------------------------------

export interface DemoSession {
  role: Role;
  doctorId?: string;
  /** Shown in the header for reception and owner. */
  label: string;
}

const SESSION_KEY = 'clinic-queue-demo-session';

export interface AuthValue {
  session: DemoSession | null;
  /** True while a real sign in is still being checked. Always false in demo mode. */
  loading: boolean;
  login(session: DemoSession): void;
  logout(): void | Promise<void>;
}

export const AuthContext = createContext<AuthValue | null>(null);

function readSession(): DemoSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DemoSession>;
    if (parsed.role && parsed.role in ROLE_HOME && typeof parsed.label === 'string') {
      return { role: parsed.role, doctorId: parsed.doctorId, label: parsed.label };
    }
  } catch {
    // Unreadable session means signed out.
  }
  return null;
}

/** The demo session lives in sessionStorage, so each browser tab can sign in as a different role. */
export function AuthProvider({ children, initial }: { children: ReactNode; initial?: DemoSession | null }) {
  const [session, setSession] = useState<DemoSession | null>(() => (initial !== undefined ? initial : readSession()));

  const login = useCallback((next: DemoSession) => {
    try {
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    } catch {
      // Keep the session in memory only.
    }
    setSession(next);
  }, []);

  const logout = useCallback(() => {
    try {
      window.sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // Nothing to clean up.
    }
    setSession(null);
  }, []);

  const value = useMemo(() => ({ session, loading: false, login, logout }), [session, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider is missing');
  return value;
}

export function useActor(): Actor {
  return useAuth().session?.role ?? 'patient';
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const ActionsContext = createContext<Actions | null>(null);

/** Actions for the current page. The demo and the real backend each provide their own. */
export function useActions(): Actions {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error('ActionsContext is missing');
  return actions;
}

/** Demo mode: actions that check the demo role and change the local sample data. */
export function DemoActionsProvider({ store, children }: { store: Store; children: ReactNode }) {
  const { session } = useAuth();
  const actions = useMemo(
    () => createActions(store, { actor: session?.role ?? 'patient', doctorId: session?.doctorId }),
    [store, session],
  );
  return <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>;
}

// ---------------------------------------------------------------------------
// Live clock
// ---------------------------------------------------------------------------

/**
 * Returns the current time and refreshes it every `intervalMs`.
 * Each tick also re-reads saved data, so changes made in another tab show up even if the browser
 * did not announce them. Changes in the same tab appear immediately without waiting for the tick.
 */
export function useLiveClock(intervalMs = 10000): Date {
  const store = useContext(StoreContext);
  const zone = useContext(TimezoneContext);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => {
      store?.refresh();
      setNow(new Date());
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [store, intervalMs]);
  // With a real clinic, "today" and the time of day are the clinic's, not the visitor's device.
  return useMemo(() => shiftToZone(now, zone), [now, zone]);
}

/** The clinic's time zone, set on pages that belong to one real clinic. Null means the device's own clock. */
export const TimezoneContext = createContext<string | null>(null);
