import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from './env';
import { classifySupabaseKey } from './publicKey';
import { createSupabaseClient, getSupabase } from '../lib/supabase';

// Fake keys are built at run time on purpose. The build runs a scan that rejects anything shaped like a real secret key,
// and these tests should not trip it.
const b64url = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (role: string) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ iss: 'supabase', role })}.${'s'.repeat(24)}`;
const publishable = ['sb', 'publishable', 'a1B2c3D4e5F6g7H8'].join('_');
const secret = ['sb', 'secret', 'z9Y8x7W6v5U4t3S2r1Q0'].join('_');

const URL_OK = 'https://abcdefgh.supabase.co';

describe('classifySupabaseKey', () => {
  it('accepts the publishable key and the legacy anon key', () => {
    expect(classifySupabaseKey(publishable)).toBe('publishable');
    expect(classifySupabaseKey(jwt('anon'))).toBe('legacy-anon');
  });

  it('recognises secret and service role keys', () => {
    expect(classifySupabaseKey(secret)).toBe('secret');
    expect(classifySupabaseKey(jwt('service_role'))).toBe('service-role');
  });

  it('does not treat other tokens as project keys', () => {
    expect(classifySupabaseKey(jwt('authenticated'))).toBe('other-jwt');
    expect(classifySupabaseKey('not-a-key')).toBe('unrecognised');
    expect(classifySupabaseKey('')).toBe('unrecognised');
    expect(classifySupabaseKey('a.b.c')).toBe('unrecognised');
  });

  it('ignores surrounding spaces', () => {
    expect(classifySupabaseKey(`  ${publishable}\n`)).toBe('publishable');
  });
});

describe('parseConfig', () => {
  it('defaults to demo mode with no settings at all', () => {
    expect(parseConfig({})).toEqual({ ok: true, config: { backend: 'demo' } });
    expect(parseConfig({ VITE_BACKEND: '' })).toEqual({ ok: true, config: { backend: 'demo' } });
    expect(parseConfig({ VITE_BACKEND: 'demo' })).toEqual({ ok: true, config: { backend: 'demo' } });
  });

  it('does not need Supabase settings in demo mode', () => {
    expect(parseConfig({ VITE_BACKEND: 'demo', VITE_SUPABASE_URL: 'not a url' }).ok).toBe(true);
  });

  it('rejects an unknown backend', () => {
    const result = parseConfig({ VITE_BACKEND: 'firebase' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toMatch(/demo.*supabase/);
  });

  it('requires both the URL and the key in Supabase mode', () => {
    const result = parseConfig({ VITE_BACKEND: 'supabase' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toHaveLength(2);
  });

  it('accepts a valid Supabase setup and tidies the URL', () => {
    const result = parseConfig({
      VITE_BACKEND: 'supabase',
      VITE_SUPABASE_URL: `${URL_OK}/`,
      VITE_SUPABASE_PUBLISHABLE_KEY: publishable,
    });
    expect(result).toEqual({ ok: true, config: { backend: 'supabase', supabaseUrl: URL_OK, supabaseKey: publishable } });
  });

  it('accepts the legacy anon key', () => {
    const key = jwt('anon');
    const result = parseConfig({ VITE_BACKEND: 'supabase', VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: key });
    expect(result.ok).toBe(true);
  });

  it('allows plain http only for a local Supabase', () => {
    const base = { VITE_BACKEND: 'supabase', VITE_SUPABASE_PUBLISHABLE_KEY: publishable };
    expect(parseConfig({ ...base, VITE_SUPABASE_URL: 'http://127.0.0.1:54321' }).ok).toBe(true);
    expect(parseConfig({ ...base, VITE_SUPABASE_URL: 'http://localhost:54321' }).ok).toBe(true);
    expect(parseConfig({ ...base, VITE_SUPABASE_URL: 'http://abcdefgh.supabase.co' }).ok).toBe(false);
    expect(parseConfig({ ...base, VITE_SUPABASE_URL: 'ftp://abcdefgh.supabase.co' }).ok).toBe(false);
  });

  it('rejects a URL with a password in it, or one that is not a URL', () => {
    const base = { VITE_BACKEND: 'supabase', VITE_SUPABASE_PUBLISHABLE_KEY: publishable };
    expect(parseConfig({ ...base, VITE_SUPABASE_URL: 'https://user:pass@abcdefgh.supabase.co' }).ok).toBe(false);
    expect(parseConfig({ ...base, VITE_SUPABASE_URL: 'abcdefgh' }).ok).toBe(false);
  });

  it('refuses secret and service role keys in Supabase mode', () => {
    for (const key of [secret, jwt('service_role')]) {
      const result = parseConfig({ VITE_BACKEND: 'supabase', VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: key });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problems.join(' ')).toMatch(/secret or service role key/);
    }
  });

  it('refuses secret and service role keys even in demo mode, because Vite would still publish them', () => {
    for (const key of [secret, jwt('service_role')]) {
      expect(parseConfig({ VITE_BACKEND: 'demo', VITE_SUPABASE_PUBLISHABLE_KEY: key }).ok).toBe(false);
      expect(parseConfig({ VITE_SUPABASE_PUBLISHABLE_KEY: key }).ok).toBe(false);
    }
  });

  it('refuses tokens for other roles and unrecognised values', () => {
    for (const key of [jwt('authenticated'), 'hello']) {
      const result = parseConfig({ VITE_BACKEND: 'supabase', VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_PUBLISHABLE_KEY: key });
      expect(result.ok).toBe(false);
    }
  });

  it('never repeats a key inside an error message', () => {
    for (const key of [secret, jwt('service_role'), jwt('authenticated'), 'hello-world-not-a-key']) {
      const result = parseConfig({ VITE_BACKEND: 'supabase', VITE_SUPABASE_URL: 'nope', VITE_SUPABASE_PUBLISHABLE_KEY: key });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problems.join('\n')).not.toContain(key);
    }
  });
});

describe('Supabase client', () => {
  it('is not available while the app runs in demo mode', async () => {
    await expect(getSupabase()).rejects.toThrow(/not enabled/);
  });

  it('can be built from a URL and a publishable key without any network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = await createSupabaseClient({ supabaseUrl: URL_OK, supabaseKey: publishable });
    expect(typeof client.auth.getSession).toBe('function');
    expect(typeof client.from).toBe('function');
    expect(typeof client.rpc).toBe('function');
    expect(typeof client.storage.from).toBe('function');
    await client.auth.stopAutoRefresh();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
