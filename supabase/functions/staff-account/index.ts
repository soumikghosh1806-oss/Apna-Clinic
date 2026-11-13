// staff-account: Deno entry point. All the logic is in handler.ts. This file only connects it to the real services.
//
// Secrets (Supabase provides the first three to every Edge Function):
//   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEYS or SUPABASE_ANON_KEY, SUPABASE_SECRET_KEYS or SUPABASE_SERVICE_ROLE_KEY
// Set by you (see docs/EMAIL_SETUP.md): RESEND_API_KEY, EMAIL_FROM, APP_BASE_URL, and optionally EMAIL_REPLY_TO, SUPPORT_EMAIL.

import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
import { handle, type Deps } from './handler.ts';

function readKey(dictionaryName: string, legacyName: string): string | undefined {
  try {
    const dictionary = JSON.parse(Deno.env.get(dictionaryName) ?? '{}');
    if (dictionary?.default) return String(dictionary.default);
  } catch { /* fall through to the legacy secret */ }
  return Deno.env.get(legacyName) ?? undefined;
}

const url = Deno.env.get('SUPABASE_URL');
const publishable = readKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
const secret = readKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
const options = { auth: { persistSession: false, autoRefreshToken: false } };

const deps: Deps | null = url && publishable && secret ? (() => {
  const admin = createClient(url, secret, options);
  return {
    env: (name) => Deno.env.get(name),
    fetch: (input, init) => fetch(input, init),
    getUser: async (token) => {
      const { data, error } = await admin.auth.getUser(token);
      return error || !data.user?.email ? null : { id: data.user.id, email: data.user.email };
    },
    verifyPassword: async (email, password) => {
      const probe = createClient(url, publishable, options);
      const { error } = await probe.auth.signInWithPassword({ email, password });
      return !error;
    },
    rpc: async (fn, args) => {
      const { data, error } = await admin.rpc(fn, args);
      return { data, error: error ? { message: error.message } : null };
    },
    createUser: async ({ email, password, fullName }) => {
      // email_confirm: the owner vouches for this address and the person must change the password on first sign in.
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
      if (error) return { error: error.code === 'email_exists' || /already|registered|exists/i.test(error.message) ? 'exists' : 'failed' };
      return { id: data.user.id };
    },
    setPassword: async (userId, password) => {
      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      return error ? { error: error.message } : {};
    },
    deleteUser: async (userId) => { await admin.auth.admin.deleteUser(userId); },
  } satisfies Deps;
})() : null;

Deno.serve((req) => {
  if (!deps) {
    console.error('staff-account: the project keys are not available to this function');
    return new Response(JSON.stringify({ ok: false, code: 'server_error', message: 'The staff service is not set up correctly.' }),
      { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
  return handle(req, deps);
});
