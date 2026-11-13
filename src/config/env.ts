// Reads and checks the settings the app starts with. Pure functions, so the rules can be tested.
//
// Two rules matter most:
//  1. A secret or service role key is refused in every mode. Vite copies VITE_ values into the public site.
//  2. Messages never repeat the key itself, so a mistake cannot leak into screenshots or logs.

import { classifySupabaseKey, isBrowserSafeKey, isSecretKey, type SupabaseKeyKind } from './publicKey';

export type RawEnv = Record<string, string | undefined>;

export interface DemoConfig {
  backend: 'demo';
}

export interface SupabaseConfig {
  backend: 'supabase';
  /** Project URL without a trailing slash. */
  supabaseUrl: string;
  /** Publishable (or legacy anon) key. Safe to ship in the browser. */
  supabaseKey: string;
}

export type AppConfig = DemoConfig | SupabaseConfig;

export type ConfigResult = { ok: true; config: AppConfig } | { ok: false; problems: string[] };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

function checkUrl(url: string, problems: string[]): string | null {
  if (!url) {
    problems.push('VITE_SUPABASE_URL is required when VITE_BACKEND is "supabase".');
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    problems.push('VITE_SUPABASE_URL is not a valid web address. Use the project URL from the Supabase dashboard.');
    return null;
  }
  if (parsed.username || parsed.password) {
    problems.push('VITE_SUPABASE_URL must not contain a user name or password.');
    return null;
  }
  const local = LOCAL_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    problems.push('VITE_SUPABASE_URL must start with https:// (http:// is allowed only for localhost).');
    return null;
  }
  return parsed.origin;
}

function describeKeyProblem(kind: SupabaseKeyKind): string {
  switch (kind) {
    case 'other-jwt':
      return 'VITE_SUPABASE_PUBLISHABLE_KEY is a token for a different role. Use the publishable key (sb_publishable_...) or the legacy anon key.';
    case 'unrecognised':
      return 'VITE_SUPABASE_PUBLISHABLE_KEY is not recognised as a publishable key. It should start with sb_publishable_ (or be the legacy anon key).';
    default:
      return 'VITE_SUPABASE_PUBLISHABLE_KEY is not a browser safe key.';
  }
}

export function parseConfig(raw: RawEnv): ConfigResult {
  const problems: string[] = [];

  const mode = clean(raw.VITE_BACKEND) || 'demo';
  if (mode !== 'demo' && mode !== 'supabase') {
    problems.push('VITE_BACKEND must be "demo" or "supabase".');
  }

  const key = clean(raw.VITE_SUPABASE_PUBLISHABLE_KEY);
  const keyKind = key ? classifySupabaseKey(key) : null;

  // Refused in every mode: the value would be copied into the public website.
  if (keyKind !== null && isSecretKey(keyKind)) {
    problems.push(
      'VITE_SUPABASE_PUBLISHABLE_KEY holds a secret or service role key. Remove it now and treat that key as exposed: ' +
        'create a new one in the Supabase dashboard and disable the old one. Secret keys belong only on a server or in an Edge Function.',
    );
  }

  let url: string | null = null;
  if (mode === 'supabase') {
    url = checkUrl(clean(raw.VITE_SUPABASE_URL), problems);
    if (!key) {
      problems.push('VITE_SUPABASE_PUBLISHABLE_KEY is required when VITE_BACKEND is "supabase".');
    } else if (keyKind !== null && !isBrowserSafeKey(keyKind) && !isSecretKey(keyKind)) {
      problems.push(describeKeyProblem(keyKind));
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  if (mode === 'demo') return { ok: true, config: { backend: 'demo' } };
  return { ok: true, config: { backend: 'supabase', supabaseUrl: url as string, supabaseKey: key } };
}

/** The only place that reads import.meta.env. Vite needs each name written out in full. */
export function readViteEnv(): RawEnv {
  return {
    VITE_BACKEND: import.meta.env.VITE_BACKEND,
    VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  };
}

export function loadConfig(): ConfigResult {
  return parseConfig(readViteEnv());
}
