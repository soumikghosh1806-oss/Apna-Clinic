// staff-account: everything about a staff member's sign in account that needs the project's secret key.
//
//   create               The clinic owner adds a doctor or receptionist with a temporary password.
//   resend               The owner re-sends the welcome email to someone who has not chosen a password yet.
//   reset_temp_password  The owner sets a new temporary password for someone who has not chosen one yet.
//   change_password      Any signed in person chooses a new password (this is the forced change on first sign in).
//
// This file holds the logic only. Everything it needs from the outside (the secret key client, the email provider,
// the clock of the environment) is passed in as `deps`, so the same code runs in Deno (index.ts), in unit tests and in
// the browser test stand-in. The secret key never leaves the server.

import { readEmailConfig, sendTemplate, type SendResult } from '../_shared/email/send.ts';
import type { TemplateName } from '../_shared/email/templates.ts';
import { passwordProblem } from '../_shared/password.ts';

type Json = Record<string, unknown>;
type RpcResult = { data: any; error: { message: string } | null };

export interface Deps {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  getUser: (token: string) => Promise<{ id: string; email: string } | null>;
  verifyPassword: (email: string, password: string) => Promise<boolean>;
  rpc: (fn: string, args: Json) => Promise<RpcResult>;
  createUser: (a: { email: string; password: string; fullName: string }) => Promise<{ id?: string; error?: 'exists' | 'failed' }>;
  setPassword: (userId: string, password: string) => Promise<{ error?: string }>;
  deleteUser: (userId: string) => Promise<void>;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: Json, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const failure = (code: string, message: string, status: number, extra: Json = {}) =>
  reply({ ok: false, code, message, ...extra }, status);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const NAME = /^[\p{L}\p{M}][\p{L}\p{M}.'\- ]{1,59}$/u;
const STATUS: Record<string, number> = { forbidden: 403, invalid_input: 400, rate_limited: 429, duplicate: 409, not_found: 404, invalid_transition: 409, stale: 409 };

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const clean = (v: unknown) => str(v).replace(/\s+/g, ' ');
const firstName = (full: string) => full.split(' ')[0] ?? '';

/** Turns a database refusal into the HTTP answer. */
function refusal(r: Json) {
  const code = String(r.code ?? 'invalid_input');
  return failure(code, String(r.message ?? 'This could not be done.'), STATUS[code] ?? 400,
    r.field_errors ? { field_errors: r.field_errors } : {});
}
const serverError = (what: string) => failure('server_error', `${what} Please try again in a moment.`, 500);

async function logEmail(deps: Deps, clinic: string | null, template: TemplateName, to: string, r: SendResult) {
  await deps.rpc('log_email_event', {
    p_clinic: clinic, p_template: template, p_recipient: to, p_status: r.status === 'sent' ? 'sent' : r.status === 'failed' ? 'failed' : 'skipped',
    p_provider_id: r.providerId ?? null, p_error: r.status === 'sent' ? null : r.message ?? null,
  }).catch(() => undefined);
}

/** Sends a template and records what happened. Returns what the owner is told. */
async function deliver(deps: Deps, clinic: string | null, template: TemplateName, to: string, data: Json, key: string) {
  const cfg = readEmailConfig(deps.env);
  const loginUrl = cfg.ok ? `${cfg.config.appBaseUrl}/login` : undefined;
  const result = await sendTemplate(cfg, deps.fetch, to, template, { actionUrl: loginUrl, ...data }, key);
  await logEmail(deps, clinic, template, to, result);
  return { status: result.status, message: result.message } as { status: SendResult['status']; message?: string };
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return failure('invalid_input', 'Use POST.', 405);
  const bearer = /^bearer\s+(\S+)/i.exec(req.headers.get('Authorization') ?? '');
  if (!bearer) return failure('forbidden', 'Sign in first.', 401);
  const user = await deps.getUser(bearer[1]);
  if (!user) return failure('forbidden', 'Your sign in has expired. Please sign in again.', 401);

  let input: Json;
  try { input = await req.json(); } catch { return failure('invalid_input', 'Send the details as JSON.', 400); }

  switch (str(input.action) || 'create') {
    case 'create': return createStaff(input, user, deps);
    case 'resend': return resend(input, user, deps);
    case 'reset_temp_password': return resetTemp(input, user, deps);
    case 'change_password': return changePassword(input, user, deps);
    default: return failure('invalid_input', 'Unknown request.', 400);
  }
}

// ------------------------------------------------------------------------------------------------------------------
async function createStaff(input: Json, owner: { id: string }, deps: Deps): Promise<Response> {
  const clinicId = str(input.clinicId);
  if (!UUID.test(clinicId)) return failure('invalid_input', 'The clinic is missing.', 400);
  const fullName = clean(input.fullName);
  const email = str(input.email).toLowerCase();
  const role = str(input.role);
  const temp = typeof input.tempPassword === 'string' ? input.tempPassword : '';
  const confirm = typeof input.confirmPassword === 'string' ? input.confirmPassword : '';
  const doctorId = str(input.doctorId) || null;
  const nd = (input.newDoctor && typeof input.newDoctor === 'object' ? input.newDoctor : null) as Json | null;

  const errors: Record<string, string> = {};
  if (!NAME.test(fullName)) errors.fullName = 'Enter the full name, 2 to 60 letters (digits and symbols are not allowed).';
  if (!EMAIL.test(email)) errors.email = 'Enter a valid email address.';
  if (role !== 'doctor' && role !== 'receptionist') errors.role = 'Choose Doctor or Receptionist.';
  const problem = passwordProblem(temp, { email, name: fullName });
  if (problem) errors.tempPassword = problem;
  if (!errors.tempPassword && temp !== confirm) errors.confirmPassword = 'The two passwords do not match.';
  if (doctorId && !UUID.test(doctorId)) errors.doctorId = 'Choose a doctor from the list.';
  if (role === 'doctor' && !doctorId && !nd) errors.doctorId = 'Choose a doctor from the list, or enter the details of a new doctor.';
  if (Object.keys(errors).length > 0) return failure('invalid_input', 'Please fix the highlighted fields.', 400, { field_errors: errors });

  const newDoctor = role === 'doctor' && !doctorId && nd
    ? { specialization: str(nd.specialization), qualification: str(nd.qualification), phone: str(nd.phone),
        consultation_fee: str(String(nd.consultationFee ?? '')), opd: str(nd.opd) }
    : null;

  const pre = await deps.rpc('staff_precheck', {
    p_clinic: clinicId, p_email: email, p_role: role, p_doctor_id: doctorId, p_inviter: owner.id, p_full_name: fullName, p_new_doctor: newDoctor,
  });
  if (pre.error) return serverError('The staff check could not be completed.');
  if (!pre.data?.ok) return refusal(pre.data);
  const { state, clinic_name: clinicName, inviter_name: inviterName } = pre.data as Json;
  const roleLabel = role === 'doctor' ? 'Doctor' : 'Receptionist';

  if (state === 'already_member') {
    return failure('duplicate', 'This email address is already on your team.', 409,
      { field_errors: { email: 'This email address is already on your team.' } });
  }

  if (state === 'existing_user') {
    // Someone who already has an Apna Clinic account. They are not added until they accept, and their password is not touched.
    const inv = await deps.rpc('create_invitation', {
      p_clinic: clinicId, p_user_id: pre.data.user_id, p_role: role, p_doctor_id: doctorId, p_new_doctor: newDoctor, p_inviter: owner.id,
    });
    if (inv.error) return serverError('The invitation could not be saved.');
    if (!inv.data?.ok) return refusal(inv.data);
    const emailResult = await deliver(deps, clinicId, 'staff_invitation', email,
      { firstName: firstName(String(pre.data.full_name ?? fullName)), clinicName, roleLabel, inviterName }, `staff-invitation-${inv.data.invitation_id}`);
    return reply({ ok: true, kind: 'invitation', email: emailResult });
  }

  // A brand new account with a temporary password. Supabase Auth hashes it; we never store or send it.
  const created = await deps.createUser({ email, password: temp, fullName });
  if (created.error === 'exists') {
    return failure('duplicate', 'An account with this email address already exists. Add them again to send an invitation.', 409,
      { field_errors: { email: 'An account with this email address already exists.' } });
  }
  if (!created.id) return serverError('The account could not be created.');

  const prov = await deps.rpc('provision_staff', {
    p_clinic: clinicId, p_user_id: created.id, p_role: role, p_doctor_id: doctorId, p_new_doctor: newDoctor,
    p_inviter: owner.id, p_full_name: fullName, p_must_change: true,
  });
  if (prov.error || !prov.data?.ok) {
    await deps.deleteUser(created.id).catch(() => undefined); // nothing half made is left behind
    return prov.error ? serverError('The account could not be set up.') : refusal(prov.data);
  }
  const emailResult = await deliver(deps, clinicId, 'staff_activation', email,
    { firstName: firstName(fullName), clinicName, roleLabel, inviterName }, `staff-activation-${created.id}`);
  return reply({ ok: true, kind: 'account', userId: created.id, email: emailResult });
}

// ------------------------------------------------------------------------------------------------------------------
async function pendingStaff(input: Json, owner: { id: string }, deps: Deps) {
  const clinicId = str(input.clinicId);
  const userId = str(input.userId);
  if (!UUID.test(clinicId) || !UUID.test(userId)) return { response: failure('invalid_input', 'Choose a staff member.', 400) };
  const st = await deps.rpc('staff_first_login_status', { p_clinic: clinicId, p_user_id: userId, p_inviter: owner.id });
  if (st.error) return { response: serverError('The staff member could not be checked.') };
  if (!st.data?.ok) return { response: refusal(st.data) };
  if (!st.data.pending) {
    return { response: failure('invalid_transition', 'This person has already chosen their own password, so their sign in cannot be reset from here. They can use "Forgot password" on the sign in page.', 409) };
  }
  return { clinicId, userId, data: st.data as Json };
}

async function resend(input: Json, owner: { id: string }, deps: Deps): Promise<Response> {
  const p = await pendingStaff(input, owner, deps);
  if (p.response) return p.response;
  const emailAddress = String(p.data.email ?? '');
  const result = await deliver(deps, p.clinicId, 'staff_activation', emailAddress, {
    firstName: firstName(String(p.data.full_name ?? '')), clinicName: p.data.clinic_name,
    roleLabel: p.data.role === 'doctor' ? 'Doctor' : 'Receptionist',
  }, `staff-activation-resend-${p.userId}-${Date.now()}`);
  await deps.rpc('log_staff_event', { p_clinic: p.clinicId, p_user_id: p.userId, p_action: 'staff.activation_resent', p_inviter: owner.id });
  return reply({ ok: true, email: result });
}

async function resetTemp(input: Json, owner: { id: string }, deps: Deps): Promise<Response> {
  const p = await pendingStaff(input, owner, deps);
  if (p.response) return p.response;
  const temp = typeof input.tempPassword === 'string' ? input.tempPassword : '';
  const confirm = typeof input.confirmPassword === 'string' ? input.confirmPassword : '';
  const errors: Record<string, string> = {};
  const problem = passwordProblem(temp, { email: String(p.data.email ?? ''), name: String(p.data.full_name ?? '') });
  if (problem) errors.tempPassword = problem;
  else if (temp !== confirm) errors.confirmPassword = 'The two passwords do not match.';
  if (Object.keys(errors).length > 0) return failure('invalid_input', 'Please fix the highlighted fields.', 400, { field_errors: errors });
  const set = await deps.setPassword(p.userId, temp);
  if (set.error) return serverError('The temporary password could not be changed.');
  await deps.rpc('log_staff_event', { p_clinic: p.clinicId, p_user_id: p.userId, p_action: 'staff.password_reset', p_inviter: owner.id });
  const result = await deliver(deps, p.clinicId, 'staff_activation', String(p.data.email ?? ''), {
    firstName: firstName(String(p.data.full_name ?? '')), clinicName: p.data.clinic_name,
    roleLabel: p.data.role === 'doctor' ? 'Doctor' : 'Receptionist',
  }, `staff-activation-reset-${p.userId}-${Date.now()}`);
  return reply({ ok: true, email: result });
}

// ------------------------------------------------------------------------------------------------------------------
async function changePassword(input: Json, user: { id: string; email: string }, deps: Deps): Promise<Response> {
  const current = typeof input.currentPassword === 'string' ? input.currentPassword : '';
  const next = typeof input.newPassword === 'string' ? input.newPassword : '';
  const confirm = typeof input.confirmPassword === 'string' ? input.confirmPassword : '';
  const errors: Record<string, string> = {};
  if (!current) errors.currentPassword = 'Enter the temporary or current password.';
  const problem = passwordProblem(next, { email: user.email });
  if (problem) errors.newPassword = problem;
  else if (next === current) errors.newPassword = 'Choose a password that is different from the one you have now.';
  else if (confirm !== next) errors.confirmPassword = 'The two passwords do not match.';
  if (Object.keys(errors).length > 0) return failure('invalid_input', 'Please fix the highlighted fields.', 400, { field_errors: errors });

  if (!(await deps.verifyPassword(user.email, current))) {
    return failure('invalid_input', 'The current password is not correct.', 400, { field_errors: { currentPassword: 'The current password is not correct.' } });
  }
  const set = await deps.setPassword(user.id, next);
  if (set.error) return serverError('Your password could not be changed.');
  const done = await deps.rpc('finish_first_login', { p_user_id: user.id });
  if (done.error) return serverError('Your password was changed, but the account could not be unlocked.');

  const profile = await deps.rpc('staff_profile_name', { p_user_id: user.id });
  const name = typeof profile.data === 'string' ? profile.data : '';
  const when = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date());
  const result = await deliver(deps, null, 'password_changed', user.email, { firstName: firstName(name), whenLabel: `${when} IST` }, `password-changed-${user.id}-${Date.now()}`);
  return reply({ ok: true, email: result });
}
