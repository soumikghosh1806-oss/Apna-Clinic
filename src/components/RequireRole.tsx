import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { ROLE_HOME } from '../domain/permissions';
import type { Role } from '../domain/types';
import { IS_SUPABASE } from '../backend/mode';
import { useAuth } from '../state/context';
import { Notice, ButtonLink, PageHeader } from './ui';

/**
 * Route guard for demo roles. Without a session the visitor goes to the login screen.
 * With the wrong role they see a clear message and a link to their own screens.
 * This protects screens in the browser only. A real service must also check roles on its server.
 */
export function RequireRole({ roles }: { roles: Role[] }) {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <p className="muted" role="status">
        Loading...
      </p>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  if (!roles.includes(session.role)) {
    return (
      <>
        <PageHeader title="You cannot open this screen" />
        <Notice kind="warning" title={IS_SUPABASE ? 'Your role does not include this screen.' : 'Your demo role does not include this screen.'}>
          <p>
            You are signed in as <strong>{session.role === 'owner' ? 'clinic owner' : session.role}</strong>.{' '}
            {IS_SUPABASE
              ? 'Ask the clinic owner if you need access to this screen.'
              : 'Log out and sign in with another demo role to see it.'}
          </p>
        </Notice>
        <p style={{ marginTop: 16 }}>
          <ButtonLink to={ROLE_HOME[session.role]} variant="primary">
            Go to my screens
          </ButtonLink>
        </p>
      </>
    );
  }

  return <Outlet />;
}
