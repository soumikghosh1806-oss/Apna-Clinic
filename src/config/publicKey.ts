// Tells apart the Supabase keys that are safe in a browser from the ones that are not.
// It looks at the shape of the key only. It never sends the key anywhere and never prints it.

export type SupabaseKeyKind =
  /** New style key, sb_publishable_... Safe in a browser. Row level security still applies. */
  | 'publishable'
  /** Older JWT key with the anon role. Safe in a browser. Being phased out by Supabase. */
  | 'legacy-anon'
  /** New style secret key, sb_secret_... Bypasses row level security. Server side only. */
  | 'secret'
  /** Older JWT key with the service_role role. Bypasses row level security. Server side only. */
  | 'service-role'
  /** A JWT for some other role, for example a signed in user's session token. Not a project key. */
  | 'other-jwt'
  | 'unrecognised';

const PUBLISHABLE = /^sb_publishable_[A-Za-z0-9_-]{8,}$/;

function jwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const payload: unknown = JSON.parse(atob(padded));
    if (typeof payload === 'object' && payload !== null && 'role' in payload) {
      const role = (payload as { role: unknown }).role;
      return typeof role === 'string' ? role : null;
    }
  } catch {
    // Not a readable JWT.
  }
  return null;
}

export function classifySupabaseKey(key: string): SupabaseKeyKind {
  const value = key.trim();
  if (value.startsWith('sb_secret_')) return 'secret';
  if (PUBLISHABLE.test(value)) return 'publishable';
  const role = jwtRole(value);
  if (role === 'service_role') return 'service-role';
  if (role === 'anon') return 'legacy-anon';
  if (role !== null) return 'other-jwt';
  return 'unrecognised';
}

export function isBrowserSafeKey(kind: SupabaseKeyKind): boolean {
  return kind === 'publishable' || kind === 'legacy-anon';
}

export function isSecretKey(kind: SupabaseKeyKind): boolean {
  return kind === 'secret' || kind === 'service-role';
}
