// The patient side of a real clinic: one call to read the clinic's public details, shared by every public page.
// It never carries patient names, phone numbers or medical information.

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { ActionsContext, TimezoneContext } from '../state/context';
import { useClinicSlug } from './clinicRoute';
import { mapPublicClinic, type PublicClinicData } from './mappers';
import { createRemoteActions } from './remoteActions';
import { rpc } from './rpc';
import { useRemote } from './useRemote';

export type PublicLoad = 'no_clinic' | 'loading' | 'ready' | 'not_found' | 'error';

export interface PublicClinicValue {
  slug: string | null;
  load: PublicLoad;
  message?: string;
  data: PublicClinicData | null;
  updatedAt: Date | null;
  refresh(): void;
}

export const PublicClinicContext = createContext<PublicClinicValue | null>(null);

export function usePublicClinicContext(): PublicClinicValue | null {
  return useContext(PublicClinicContext);
}

/** Wraps the public pages. It passes through when the address has no clinic in it, such as the login page. */
export function PublicClinicGate(): ReactNode {
  const slug = useClinicSlug();
  const remote = useRemote(
    async () => {
      const answer = await rpc('get_public_clinic', { p_slug: slug ?? '' });
      return answer.ok ? { ok: true as const, value: mapPublicClinic(answer.data) } : answer;
    },
    [slug],
    { enabled: slug !== null, intervalMs: 10000 },
  );

  const actions = useMemo(() => createRemoteActions({ slug, clinicId: null, refresh: async () => undefined }), [slug]);

  const value = useMemo<PublicClinicValue>(() => {
    let load: PublicLoad = 'loading';
    let message: string | undefined;
    if (slug === null) load = 'no_clinic';
    else if (remote.data) load = 'ready';
    else if (remote.failure) {
      load = remote.failure.code === 'not_found' ? 'not_found' : 'error';
      message = remote.failure.message;
    }
    return { slug, load, message, data: remote.data ?? null, updatedAt: remote.updatedAt, refresh: remote.refresh };
  }, [slug, remote.data, remote.failure, remote.updatedAt, remote.refresh]);

  return (
    <ActionsContext.Provider value={actions}>
      <TimezoneContext.Provider value={remote.data?.timezone ?? null}>
        <PublicClinicContext.Provider value={value}>
          <Outlet />
        </PublicClinicContext.Provider>
      </TimezoneContext.Provider>
    </ActionsContext.Provider>
  );
}
