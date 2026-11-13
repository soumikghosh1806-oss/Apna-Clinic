// A TEST ONLY stand-in for the Supabase HTTP API, backed by the throwaway Postgres that the database tests use.
//
// Why it exists: the sandbox cannot reach supabase.co, so the real browser to Supabase path cannot be run here.
// This lets the real built web app run in a real browser against the real SQL functions, policies and triggers from
// the migrations. It speaks just enough of: PostgREST rpc, Auth (password sign in, sign up, user, logout, recover,
// and the admin calls the staff function uses), Storage (upload, signed link), and it mounts the REAL code of the
// staff-account and booking-public Edge Functions (their handler.ts files) with a fake text message provider and a
// fake email provider that record what they are given. Start it with: bash scripts/run-e2e.sh e2e/<script>.cjs
//
// What it does NOT prove: Supabase's own Auth service (the admin calls are re-implemented here), real email or text
// message delivery, Realtime delivery, the hosted Storage service (file size and type limits), the Deno runtime that
// runs the Edge Functions, or any network setting. Those need a run against the real project.
// Never point this at a real project and never ship it.

import http from 'node:http';
import crypto from 'node:crypto';
import { startDb } from '../harness.mjs';
import { handle as staffAccount } from '../../functions/staff-account/handler.ts';
import { handle as bookingPublic } from '../../functions/booking-public/handler.ts';

const PORT = Number(process.env.SHIM_PORT ?? 54399);
const PG_PORT = Number(process.env.SHIM_PG_PORT ?? 54342);
let confirmEmail = process.env.SHIM_CONFIRM_EMAIL === '1';
const PUBLISHABLE = process.env.SHIM_KEY ?? 'sb_publishable_localshim_000000000000000000';

const db = await startDb({ port: PG_PORT });

const passwords = new Map(); // user id -> password
const confirmed = new Set(); // user ids that may sign in
const issued = new Map(); // access token -> user id
const refreshTokens = new Map(); // refresh token -> user id
const signedLinks = new Map(); // link token -> storage path
const outbox = []; // emails the app would have sent
let emailMode = 'ok'; // ok: the fake provider accepts mail. fail: it refuses (domain not verified). off: email is not configured.
let smsMode = 'ok'; // ok: the fake text message provider accepts messages. fail: it refuses. off: text messages are not configured.
const sms = []; // text messages the fake provider received. It plays the part of the patient's phone in tests.
const sentKeys = new Map(); // Idempotency-Key -> provider id. Resend answers a repeated key with the first answer and sends nothing new.
const files = new Map(); // storage path -> { size, type }

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const nowSec = () => Math.floor(Date.now() / 1000);

async function userById(id) {
  const r = await db.admin.query('select id, email, raw_user_meta_data, created_at from auth.users where id = $1', [id]);
  return r.rows[0] ?? null;
}
async function userByEmail(email) {
  const r = await db.admin.query('select id, email, raw_user_meta_data, created_at from auth.users where lower(email) = lower($1)', [email]);
  return r.rows[0] ?? null;
}
const userJson = (u) => ({
  id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.created_at,
  phone: '', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: u.raw_user_meta_data ?? {},
  identities: [], created_at: u.created_at, updated_at: u.created_at,
});

function newSession(u) {
  const iat = nowSec();
  const access = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', iat, exp: iat + 3600 })}.${crypto.randomBytes(8).toString('hex')}`;
  const refresh = crypto.randomUUID();
  issued.set(access, u.id);
  refreshTokens.set(refresh, u.id);
  return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: iat + 3600, refresh_token: refresh, user: userJson(u) };
}

// ---- helpers ----
const CORS = (req) => ({
  'Access-Control-Allow-Origin': req.headers.origin ?? '*',
  'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Max-Age': '600',
  'Access-Control-Expose-Headers': '*',
});
function send(req, res, status, body, extra = {}) {
  const payload = body === undefined ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...CORS(req), ...(typeof body === 'object' && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...extra });
  res.end(payload);
}
const readBody = (req) => new Promise((resolve) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });
const readJson = async (req) => { try { return JSON.parse((await readBody(req)).toString() || '{}'); } catch { return {}; } };

/** Who is calling: a signed in user, the public (project key), or nobody valid. */
function caller(req) {
  const bearer = (req.headers.authorization ?? '').replace(/^bearer\s+/i, '');
  if (!bearer || bearer === PUBLISHABLE) return { kind: 'anon', who: db.anon };
  const uid = issued.get(bearer);
  if (uid) return { kind: 'user', uid, who: db.as(uid) };
  return { kind: 'invalid' };
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const UUID_OK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The outside world of the staff-account function, replaced for tests. */
function functionDeps() {
  const rpcAsServer = async (fn, args) => {
    try { return { data: await db.rpc(db.service, fn, args), error: null }; }
    catch (error) { return { data: null, error: { message: error.message } }; }
  };
  return {
    env: (name) => ({
      OTP_HASH_SECRET: 'shim-only-otp-secret-not-for-production-0000',
      ...(emailMode === 'off' ? {} : { RESEND_API_KEY: 're_shim', EMAIL_FROM: 'Apna Clinic <no-reply@mail.shim.test>', APP_BASE_URL: 'http://localhost:4174' }),
      ...(smsMode === 'off' ? {} : { TWILIO_ACCOUNT_SID: 'ACshim', TWILIO_AUTH_TOKEN: 'shim-token', TWILIO_FROM: '+15005550006' }),
    }[name]),
    fetch: async (url, init) => {
      if (String(url).startsWith('https://api.twilio.com/')) {
        const form = new URLSearchParams(init.body);
        if (smsMode === 'fail') return new Response(JSON.stringify({ code: 21608, message: 'The number is unverified (shim).' }), { status: 400 });
        sms.push({ to: form.get('To'), body: form.get('Body') });
        return new Response(JSON.stringify({ sid: `SMshim${crypto.randomUUID().slice(0, 8)}`, status: 'queued' }), { status: 201 });
      }
      if (String(url) !== 'https://api.resend.com/emails') throw new Error(`shim: unexpected outgoing request to ${url}`);
      const mail = JSON.parse(init.body);
      if (emailMode === 'fail') return new Response(JSON.stringify({ statusCode: 403, name: 'validation_error', message: 'The mail.shim.test domain is not verified. Please, add and verify your domain.' }), { status: 403 });
      const key = init.headers['Idempotency-Key'];
      if (key && sentKeys.has(key)) return new Response(JSON.stringify({ id: sentKeys.get(key) }), { status: 200 });
      outbox.push({ type: 'email', to: mail.to[0], subject: mail.subject, html: mail.html, text: mail.text });
      const id = `shim_${crypto.randomUUID()}`;
      if (key) sentKeys.set(key, id);
      return new Response(JSON.stringify({ id }), { status: 200 });
    },
    getUser: async (token) => { const id = issued.get(token); const u = id ? await userById(id) : null; return u ? { id: u.id, email: u.email } : null; },
    verifyPassword: async (email, password) => { const u = await userByEmail(email); return Boolean(u) && passwords.get(u.id) === password; },
    rpc: rpcAsServer,
    createUser: async ({ email, password, fullName }) => {
      if (await userByEmail(email)) return { error: 'exists' };
      const id = await db.createUser(email, fullName);
      passwords.set(id, password);
      confirmed.add(id);
      return { id };
    },
    setPassword: async (id, password) => { passwords.set(id, password); return {}; },
    deleteUser: async (id) => { await db.admin.query('delete from auth.users where id = $1', [id]); passwords.delete(id); },
  };
}

// ---- routes ----
async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  if (req.method === 'OPTIONS') return send(req, res, 204);

  // Test control
  if (path === '/__shim/outbox') return send(req, res, 200, outbox);
  if (path === '/__shim/sms') return send(req, res, 200, sms);
  if (path === '/__shim/sms-mode' && req.method === 'POST') {
    smsMode = String((await readJson(req)).mode ?? 'ok');
    return send(req, res, 200, { smsMode });
  }
  if (path === '/__shim/query' && req.method === 'POST') {
    const { sql, params } = await readJson(req);
    try { return send(req, res, 200, (await db.admin.query(sql, params ?? [])).rows); }
    catch (error) { return send(req, res, 400, { message: error.message }); }
  }
  if (path === '/__shim/link' && req.method === 'POST') {
    // What clicking the link in an invitation or reset email would do: a session for that address.
    const { email } = await readJson(req);
    const u = await userByEmail(email);
    if (!u) return send(req, res, 404, { message: 'no such user' });
    confirmed.add(u.id);
    const s = newSession(u);
    return send(req, res, 200, { access_token: s.access_token, refresh_token: s.refresh_token, expires_in: 3600, token_type: 'bearer' });
  }
  if (path === '/__shim/confirm-mode' && req.method === 'POST') {
    // Hosted projects often require people to confirm their email before they can sign in. Switch that on or off.
    confirmEmail = Boolean((await readJson(req)).on);
    return send(req, res, 200, { confirmEmail });
  }
  if (path === '/__shim/confirm' && req.method === 'POST') {
    const { email } = await readJson(req);
    const u = await userByEmail(email);
    if (u) confirmed.add(u.id);
    return send(req, res, 200, { ok: Boolean(u) });
  }

  // ---- Auth ----
  if (path === '/auth/v1/signup' && req.method === 'POST') {
    const { email, password, data } = await readJson(req);
    if (!EMAIL.test(String(email ?? ''))) return send(req, res, 400, { code: 400, error_code: 'validation_failed', msg: 'Unable to validate email address: invalid format' });
    if (String(password ?? '').length < 8) return send(req, res, 422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 8 characters.' });
    if (await userByEmail(email)) {
      // Like Supabase with confirmation on: no hint that the address is taken.
      return send(req, res, 200, { id: crypto.randomUUID(), aud: 'authenticated', role: '', email, identities: [], app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() });
    }
    const id = await db.createUser(String(email).toLowerCase(), data?.full_name ?? '');
    passwords.set(id, password);
    const u = await userById(id);
    if (confirmEmail) { outbox.push({ type: 'confirm', email: u.email }); return send(req, res, 200, userJson(u)); }
    confirmed.add(id);
    return send(req, res, 200, newSession(u));
  }
  if (path === '/auth/v1/token' && req.method === 'POST') {
    const grant = url.searchParams.get('grant_type');
    const body = await readJson(req);
    if (grant === 'password') {
      const u = await userByEmail(String(body.email ?? ''));
      if (!u || passwords.get(u.id) !== body.password) return send(req, res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      if (!confirmed.has(u.id)) return send(req, res, 400, { code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
      return send(req, res, 200, newSession(u));
    }
    if (grant === 'refresh_token') {
      const uid = refreshTokens.get(body.refresh_token);
      const u = uid ? await userById(uid) : null;
      if (!u) return send(req, res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });
      refreshTokens.delete(body.refresh_token);
      return send(req, res, 200, newSession(u));
    }
    return send(req, res, 400, { code: 400, error_code: 'validation_failed', msg: 'unsupported grant type' });
  }
  if (path === '/auth/v1/user') {
    const c = caller(req);
    if (c.kind !== 'user') return send(req, res, 401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });
    if (req.method === 'PUT') {
      const body = await readJson(req);
      if (body.password !== undefined) {
        if (String(body.password).length < 8) return send(req, res, 422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 8 characters.' });
        passwords.set(c.uid, body.password);
      }
    }
    return send(req, res, 200, userJson(await userById(c.uid)));
  }
  if (path === '/auth/v1/logout') {
    const bearer = (req.headers.authorization ?? '').replace(/^bearer\s+/i, '');
    issued.delete(bearer);
    return send(req, res, 204);
  }
  if (path === '/auth/v1/recover' && req.method === 'POST') {
    const { email } = await readJson(req);
    const u = await userByEmail(String(email ?? ''));
    if (u) outbox.push({ type: 'recover', email: u.email });
    return send(req, res, 200, {}); // the same answer whether or not the address exists
  }

  // ---- PostgREST rpc ----
  const rpcMatch = /^\/rest\/v1\/rpc\/([a-z_0-9]+)$/.exec(path);
  if (rpcMatch && req.method === 'POST') {
    const c = caller(req);
    if (c.kind === 'invalid') return send(req, res, 401, { code: 'PGRST301', message: 'JWSError JWSInvalidSignature', details: null, hint: null });
    const args = await readJson(req);
    try {
      return send(req, res, 200, await db.rpc(c.who, rpcMatch[1], args));
    } catch (error) {
      const denied = error.code === '42501';
      return send(req, res, denied ? (c.kind === 'anon' ? 401 : 403) : error.code === '42883' ? 404 : 400,
        { code: error.code ?? 'P0001', message: error.message, details: null, hint: null });
    }
  }

  // ---- Storage ----
  const objectMatch = /^\/storage\/v1\/object\/(?!sign\/)([a-z-]+)\/(.+)$/.exec(path);
  if (objectMatch && (req.method === 'POST' || req.method === 'PUT')) {
    const c = caller(req);
    if (c.kind !== 'user') return send(req, res, 401, { statusCode: '401', error: 'Unauthorized', message: 'Unauthorized' });
    const [, bucket, name] = objectMatch;
    const body = await readBody(req);
    try {
      await db.query(c.who, 'insert into storage.objects (bucket_id, name, owner, metadata) values ($1, $2, $3, $4)',
        [bucket, decodeURIComponent(name), c.uid, JSON.stringify({ size: body.length })]);
    } catch (error) {
      return send(req, res, 403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
    }
    files.set(decodeURIComponent(name), { size: body.length });
    return send(req, res, 200, { Key: `${bucket}/${name}`, Id: crypto.randomUUID() });
  }
  const signMatch = /^\/storage\/v1\/object\/sign\/([a-z-]+)\/(.+)$/.exec(path);
  if (signMatch && req.method === 'POST') {
    const c = caller(req);
    if (c.kind !== 'user') return send(req, res, 401, { statusCode: '401', error: 'Unauthorized', message: 'Unauthorized' });
    const name = decodeURIComponent(signMatch[2]);
    // Storage hides a file the caller may not read, the same as a missing file.
    const rows = await db.query(c.who, 'select 1 from storage.objects where bucket_id = $1 and name = $2', [signMatch[1], name]);
    if (rows.length === 0) return send(req, res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
    const token = crypto.randomBytes(12).toString('hex');
    signedLinks.set(token, name);
    return send(req, res, 200, { signedURL: `/object/sign/${signMatch[1]}/${signMatch[2]}?token=${token}` });
  }
  if (signMatch && req.method === 'GET') {
    const token = url.searchParams.get('token') ?? '';
    if (!signedLinks.has(token)) return send(req, res, 400, { statusCode: '400', error: 'InvalidJWT', message: 'invalid signed link' });
    return send(req, res, 200, Buffer.from('%PDF-1.4 shim report'), { 'Content-Type': 'application/pdf' });
  }

  // ---- The staff-account Edge Function: the REAL handler code, with the outside services replaced ----
  // What is real here: every rule in supabase/functions/staff-account/handler.ts, the email templates and the database
  // functions. What is replaced: Supabase Auth (create user, set password) and the email provider, which is a local
  // fake that records each message and can be switched to refuse (see /__shim/email-mode).
  if (path === '/functions/v1/staff-account') {
    const body = (await readBody(req)).toString();
    const request = new Request(`http://127.0.0.1:${PORT}${path}`, {
      method: req.method, headers: { authorization: req.headers.authorization ?? '' }, body: req.method === 'POST' ? body : undefined,
    });
    const response = await staffAccount(request, functionDeps());
    return send(req, res, response.status, await response.text(), { 'Content-Type': 'application/json' });
  }
  // ---- The booking-public Edge Function: the REAL handler code, with the outside services replaced ----
  // Public, like the real one: no sign in is needed. The fake text message provider records each message in /__shim/sms.
  if (path === '/functions/v1/booking-public') {
    const body = (await readBody(req)).toString();
    const request = new Request(`http://127.0.0.1:${PORT}${path}`, {
      method: req.method, headers: { 'x-forwarded-for': String(req.headers['x-forwarded-for'] ?? '') }, body: req.method === 'POST' ? body : undefined,
    });
    const response = await bookingPublic(request, functionDeps());
    return send(req, res, response.status, await response.text(), { 'Content-Type': 'application/json' });
  }
  if (path === '/__shim/email-mode' && req.method === 'POST') {
    emailMode = String((await readJson(req)).mode ?? 'ok');
    return send(req, res, 200, { emailMode });
  }

  return send(req, res, 404, { message: `shim: no route for ${req.method} ${path}` });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error('shim error', error);
    if (!res.headersSent) send(req, res, 500, { message: String(error.message ?? error) });
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`shim ready on ${PORT} (confirm email: ${confirmEmail})`));

const shutdown = async () => { server.close(); await db.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
