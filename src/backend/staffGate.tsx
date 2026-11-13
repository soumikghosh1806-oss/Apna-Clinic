// The staff side of a real clinic. Once a staff member is signed in, this loads the clinic's data, keeps it fresh,
// and gives every staff screen the same shared state and actions the demo gave them.

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { Button, Notice, PageHeader } from '../components/ui';
import { ActionsContext, StoreProvider, TimezoneContext } from '../state/context';
import { useSupabaseAuth } from './auth';
import type { Membership } from './mappers';
import { ForcePasswordChange } from '../screens/ChangePasswordScreen';
import { createRemoteActions } from './remoteActions';
import { rpc } from './rpc';
import { createStaffStore, type StaffStatus, type StaffStore } from './staffStore';
import { getSupabase } from '../lib/supabase';

interface StaffValue {
  clinic: Membership;
  status: StaffStatus;
  reload(): Promise<void>;
}

const StaffContext = createContext<StaffValue | null>(null);

/** The signed in clinic and the state of its data. Null in demo mode and before sign in. */
export function useStaffContext(): StaffValue | null {
  return useContext(StaffContext);
}

export function useStaffClinic(): Membership {
  const value = useContext(StaffContext);
  if (!value) throw new Error('Staff data is not loaded');
  return value.clinic;
}

async function listenToClinic(clinicId: string, onSignal: () => void): Promise<() => void> {
  const client = await getSupabase();
  const channel = client
    .channel(`queue:${clinicId}`)
    .on('broadcast', { event: 'queue_changed' }, onSignal)
    .subscribe();
  return () => void client.removeChannel(channel);
}

function Plain({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <main id="main" tabIndex={-1}>
        <div className="container container--narrow">{children}</div>
      </main>
    </div>
  );
}

export function StaffDataGate() {
  const auth = useSupabaseAuth();

  if (auth.phase === 'loading') {
    return (
      <Plain>
        <PageHeader title="Checking your sign in" />
        <p className="muted" role="status">
          One moment.
        </p>
      </Plain>
    );
  }
  if (auth.phase === 'error') {
    return (
      <Plain>
        <PageHeader title="We could not reach the clinic service" />
        <Notice kind="error" title="Check your internet connection and try again." />
        <p style={{ marginTop: 16 }}>
          <Button variant="primary" onClick={() => void auth.reload()}>
            Try again
          </Button>
        </p>
      </Plain>
    );
  }
  // A temporary password must be replaced before anything else. The database already treats this account as having
  // no role, so this is the friendly screen for a rule the server enforces.
  if (auth.phase === 'signed_in' && auth.mustChangePassword) return <ForcePasswordChange />;
  // Not signed in, or signed in with no clinic: the layout sends the visitor to the login page.
  if (!auth.active) return <Outlet />;
  return <StaffDataForClinic key={auth.active.clinicId} clinic={auth.active} />;
}

function StaffDataForClinic({ clinic }: { clinic: Membership }) {
  const auth = useSupabaseAuth();
  const [store, setStore] = useState<StaffStore | null>(null);

  // Created inside the effect so React's development double run cannot leave a stopped store behind.
  useEffect(() => {
    const created = createStaffStore(clinic, {
      fetchSnapshot: (clinicId) => rpc('get_staff_snapshot', { p_clinic: clinicId }),
      listen: listenToClinic,
    });
    setStore(created);
    return () => {
      created.dispose();
      setStore(null);
    };
  }, [clinic]);

  if (!store) return <Loading />;
  return <Ready store={store} clinic={clinic} onSignOut={auth.signOut} />;
}

function Loading() {
  return (
    <Plain>
      <PageHeader title="Loading your clinic" />
      <p className="muted" role="status">
        One moment.
      </p>
    </Plain>
  );
}

function Ready({ store, clinic, onSignOut }: { store: StaffStore; clinic: Membership; onSignOut: () => Promise<void> }) {
  const status = useSyncExternalStore(store.subscribeStatus, store.getStatus, store.getStatus);
  const actions = useMemo(
    () => createRemoteActions({ slug: clinic.slug, clinicId: clinic.clinicId, refresh: () => store.reload() }),
    [store, clinic],
  );
  const value = useMemo<StaffValue>(() => ({ clinic, status, reload: () => store.reload() }), [clinic, status, store]);

  if (status.phase === 'loading') return <Loading />;
  if (status.phase === 'error') {
    const denied = status.failure?.code === 'forbidden';
    return (
      <Plain>
        <PageHeader title={denied ? 'You no longer have access to this clinic' : 'We could not load your clinic'} />
        <Notice kind="error" title={status.failure?.message ?? 'Something went wrong.'} />
        <p className="row" style={{ marginTop: 16 }}>
          {!denied && (
            <Button variant="primary" onClick={() => void store.reload()}>
              Try again
            </Button>
          )}
          <Button onClick={() => void onSignOut()}>Log out</Button>
        </p>
      </Plain>
    );
  }

  return (
    <StoreProvider store={store}>
      <ActionsContext.Provider value={actions}>
        <TimezoneContext.Provider value={clinic.timezone}>
          <StaffContext.Provider value={value}>
            <Outlet />
          </StaffContext.Provider>
        </TimezoneContext.Provider>
      </ActionsContext.Provider>
    </StoreProvider>
  );
}
