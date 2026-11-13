// booking-public: Deno entry point. All the logic is in handler.ts. This file only connects it to the real services.
//
// This function is PUBLIC (deploy with verify_jwt = false): patients are not signed in. handler.ts protects it.
//
// Secrets (Supabase provides the first two to every Edge Function):
//   SUPABASE_URL, SUPABASE_SECRET_KEYS or SUPABASE_SERVICE_ROLE_KEY
// Set by you (see docs/EMAIL_SETUP.md):
//   OTP_HASH_SECRET                       a long random string (32+ characters); signs the one time codes
//   RESEND_API_KEY, EMAIL_FROM, APP_BASE_URL, optionally EMAIL_REPLY_TO, SUPPORT_EMAIL     (email)
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM  (text messages)

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
const secret = readKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');

const deps: Deps | null = url && secret ? (() => {
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    env: (name) => Deno.env.get(name),
    fetch: (input, init) => fetch(input, init),
    rpc: async (fn, args) => {
      const { data, error } = await admin.rpc(fn, args);
      return { data, error: error ? { message: error.message } : null };
    },
  } satisfies Deps;
})() : null;

Deno.serve((req) => {
  if (!deps) {
    console.error('booking-public: the project keys are not available to this function');
    return new Response(JSON.stringify({ ok: false, code: 'server_error', message: 'Booking verification is not set up correctly.' }),
      { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
  return handle(req, deps);
});
