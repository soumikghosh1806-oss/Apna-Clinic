// Real sign in with Supabase Auth. It fills the same session shape the demo login used, so screens, route guards
// and the header keep working, and it adds what a real account needs: sign up, password reset, several clinics.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Result } from '../domain/types';
import { getSupabase } from '../lib/supabase';
import { AuthContext, type DemoSession } from '../state/context';
import { callFunction } from './functions';
import { mapInvitations, mapMemberships, type Invitation, type Membership } from './mappers';
import { networkFailure, rpc } from './rpc';

export type AuthPhase = 'loading' | 'signed_out' | 'signed_in' | 'error';

export interface SupabaseAuthValue {
  phase: AuthPhase;
  email: string | null;
  fullName: string;
  memberships: Membership[];
  /** The clinic the staff screens are showing. */
  active: Membership | null;
  /** The account has a temporary password. Nothing else works until the person chooses their own. */
  mustChangePassword: boolean;
  /** Clinic invitations waiting for this person to accept or decline. */
  pendingInvitations: number;
  setActive(clinicId: string): void;
  signIn(email: string, password: string): Promise<Result<null>>;
  signUp(input: { email: string; password: string; fullName: string }): Promise<Result<{ signedIn: boolean }>>;
  signOut(): Promise<void>;
  /** Reads the clinics this account works in again, for example after registering a new clinic. */
  reload(): Promise<void>;
  sendPasswordReset(email: string): Promise<Result<null>>;
  setPassword(password: string): Promise<Result<null>>;
  /** The forced first sign in change. Checks the current (temporary) password on the server. */
  changePassword(input: { currentPassword: string; newPassword: string; confirmPassword: string }): Promise<Result<{ emailNotice: string | null }>>;
  listInvitations(): Promise<Result<Invitation[]>>;
  respondInvitation(id: string, accept: boolean): Promise<Result<{ accepted: boolean }>>;
}

const SupabaseAuthContext = createContext<SupabaseAuthValue | null>(null);

export function useSupabaseAuth(): SupabaseAuthValue {
  const value = useContext(SupabaseAuthContext);
  if (!value) throw new Error('SupabaseAuthProvider is missing');
  return value;
}

/** The same value, or null in demo mode where there is no real sign in. */
export function useOptionalSupabaseAuth(): SupabaseAuthValue | null {
  return useContext(SupabaseAuthContext);
}

const ACTIVE_KEY = 'cliniq-active-clinic';
export const MIN_PASSWORD_LENGTH = 8;

function readActive(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

function writeActive(id: string | null) {
  try {
    if (id) window.localStorage.setItem(ACTIVE_KEY, id);
    else window.localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // Blocked storage only means the choice is not remembered.
  }
}

interface AuthErrorLike {
  message?: string;
  status?: number;
  code?: string;
}

/** Plain words for a sign in problem. It never says whether the email or the password was wrong. */
export function describeAuthError(error: AuthErrorLike, action: 'sign_in' | 'sign_up' | 'reset' | 'password'): string {
  const code = error.code ?? '';
  if (error.status === 429 || code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit') {
    return 'Too many attempts. Wait a few minutes and try again.';
  }
  if (code === 'email_not_confirmed') return 'Confirm your email address first. Open the link in the message we sent you.';
  if (code === 'weak_password') return `Choose a stronger password with at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (code === 'same_password') return 'Choose a password you have not used before.';
  if (action === 'sign_in') return 'The email or password is not correct.';
  if (action === 'sign_up') return 'This email cannot be used to create an account. If it is yours, log in instead.';
  if (action === 'reset') return 'The reset email could not be sent. Check the address and try again.';
  return 'The password could not be changed. Open the link in your email again and retry.';
}

function fail(code: 'invalid_input' | 'network', message: string): Result<never> {
  return { ok: false, code, message };
}

export function SupabaseAuthProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<AuthPhase>('loading');
  const [email, setEmail] = useState<string | null>(null);
  const [fullName, setFullName] = useState('');
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [activeId, setActiveId] = useState<string | null>(readActive);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [pendingInvitations, setPendingInvitations] = useState(0);
  const userId = useRef<string | null>(null);
  const sequence = useRef(0);

  /** Reads who this account is and which clinics it works in. */
  const loadAccount = useCallback(async (id: string, authEmail: string | null) => {
    const ticket = ++sequence.current;
    const answer = await rpc('my_clinics');
    if (ticket !== sequence.current) return;
    if (!answer.ok) {
      // A network problem must not look like "this account has no clinic".
      setPhase('error');
      return;
    }
    const account = mapMemberships(answer.data);
    userId.current = id;
    setMemberships(account.memberships);
    setMustChangePassword(account.mustChangePassword);
    setPendingInvitations(account.pendingInvitations);
    setFullName(account.fullName);
    setEmail(account.email || authEmail);
    setPhase('signed_in');
  }, []);

  const clear = useCallback(() => {
    sequence.current += 1;
    userId.current = null;
    setMemberships([]);
    setMustChangePassword(false);
    setPendingInvitations(0);
    setFullName('');
    setEmail(null);
    setPhase('signed_out');
  }, []);

  const apply = useCallback(
    async (session: { user: { id: string; email?: string | null } } | null) => {
      if (!session) {
        clear();
        return;
      }
      // Token refreshes and tab focus repeat the same user: nothing to reload.
      if (session.user.id === userId.current) return;
      await loadAccount(session.user.id, session.user.email ?? null);
    },
    [clear, loadAccount],
  );

  useEffect(() => {
    let stopped = false;
    let stop = () => undefined as void;
    getSupabase()
      .then((client) => {
        const { data } = client.auth.onAuthStateChange((_event, session) => {
          // Supabase must not be called from inside this callback, so the work is queued.
          setTimeout(() => {
            if (!stopped) void apply(session);
          }, 0);
        });
        stop = () => data.subscription.unsubscribe();
      })
      .catch(() => {
        if (!stopped) setPhase('error');
      });
    return () => {
      stopped = true;
      stop();
    };
  }, [apply]);

  const reload = useCallback(async () => {
    try {
      const client = await getSupabase();
      const { data } = await client.auth.getSession();
      userId.current = null;
      if (data.session) await loadAccount(data.session.user.id, data.session.user.email ?? null);
      else clear();
    } catch {
      setPhase('error');
    }
  }, [clear, loadAccount]);

  const signIn = useCallback<SupabaseAuthValue['signIn']>(
    async (address, password) => {
      try {
        const client = await getSupabase();
        const { data, error } = await client.auth.signInWithPassword({ email: address.trim(), password });
        if (error || !data.session) return fail('invalid_input', describeAuthError(error ?? {}, 'sign_in'));
        userId.current = null;
        await loadAccount(data.session.user.id, data.session.user.email ?? null);
        return { ok: true, value: null };
      } catch {
        return networkFailure();
      }
    },
    [loadAccount],
  );

  const signUp = useCallback<SupabaseAuthValue['signUp']>(
    async ({ email: address, password, fullName: name }) => {
      try {
        const client = await getSupabase();
        const { data, error } = await client.auth.signUp({
          email: address.trim(),
          password,
          options: { data: { full_name: name.trim() }, emailRedirectTo: `${window.location.origin}/login` },
        });
        if (error) return fail('invalid_input', describeAuthError(error, 'sign_up'));
        if (data.session) {
          userId.current = null;
          await loadAccount(data.session.user.id, data.session.user.email ?? null);
          return { ok: true, value: { signedIn: true } };
        }
        // The project asks for the email address to be confirmed first.
        return { ok: true, value: { signedIn: false } };
      } catch {
        return networkFailure();
      }
    },
    [loadAccount],
  );

  const signOut = useCallback(async () => {
    try {
      const client = await getSupabase();
      await client.auth.signOut();
    } catch {
      // Even if the server cannot be reached, this browser forgets the session below.
    }
    writeActive(null);
    setActiveId(null);
    clear();
  }, [clear]);

  const sendPasswordReset = useCallback<SupabaseAuthValue['sendPasswordReset']>(async (address) => {
    try {
      const client = await getSupabase();
      const { error } = await client.auth.resetPasswordForEmail(address.trim(), {
        redirectTo: `${window.location.origin}/set-password`,
      });
      return error ? fail('invalid_input', describeAuthError(error, 'reset')) : { ok: true, value: null };
    } catch {
      return networkFailure();
    }
  }, []);

  const setPassword = useCallback<SupabaseAuthValue['setPassword']>(async (password) => {
    try {
      const client = await getSupabase();
      const { error } = await client.auth.updateUser({ password });
      return error ? fail('invalid_input', describeAuthError(error, 'password')) : { ok: true, value: null };
    } catch {
      return networkFailure();
    }
  }, []);

  const changePassword = useCallback<SupabaseAuthValue['changePassword']>(
    async (input) => {
      const answer = await callFunction('staff-account', { action: 'change_password', ...input });
      if (!answer.ok) return answer;
      // The server has cleared the flag. Read the account again so the staff screens open.
      await reload();
      const mail = (answer.data.email ?? {}) as { status?: string };
      return { ok: true, value: { emailNotice: mail.status === 'sent' ? null : 'Your password was changed. We could not send the confirmation email.' } };
    },
    [reload],
  );

  const listInvitations = useCallback<SupabaseAuthValue['listInvitations']>(async () => {
    const answer = await rpc('my_invitations');
    return answer.ok ? { ok: true, value: mapInvitations(answer.data) } : answer;
  }, []);

  const respondInvitation = useCallback<SupabaseAuthValue['respondInvitation']>(
    async (id, accept) => {
      const answer = await rpc('respond_invitation', { p_invitation: id, p_accept: accept });
      if (!answer.ok) return answer;
      await reload();
      return { ok: true, value: { accepted: answer.data.accepted === true } };
    },
    [reload],
  );

  const setActive = useCallback((id: string) => {
    writeActive(id);
    setActiveId(id);
  }, []);

  const active = useMemo(
    () => memberships.find((m) => m.clinicId === activeId) ?? memberships[0] ?? null,
    [memberships, activeId],
  );

  const value = useMemo<SupabaseAuthValue>(
    () => ({
      phase, email, fullName, memberships, active, mustChangePassword, pendingInvitations, setActive, signIn, signUp, signOut, reload,
      sendPasswordReset, setPassword, changePassword, listInvitations, respondInvitation,
    }),
    [phase, email, fullName, memberships, active, mustChangePassword, pendingInvitations, setActive, signIn, signUp, signOut, reload,
      sendPasswordReset, setPassword, changePassword, listInvitations, respondInvitation],
  );

  // The same shape the demo login gave, so the route guards and the header work unchanged.
  const session = useMemo<DemoSession | null>(
    () => (active ? { role: active.role, doctorId: active.doctorId ?? undefined, label: fullName || email || active.name } : null),
    [active, fullName, email],
  );
  const shared = useMemo(
    () => ({ session, loading: phase === 'loading', login: () => undefined, logout: signOut }),
    [session, phase, signOut],
  );

  return (
    <SupabaseAuthContext.Provider value={value}>
      <AuthContext.Provider value={shared}>{children}</AuthContext.Provider>
    </SupabaseAuthContext.Provider>
  );
}
