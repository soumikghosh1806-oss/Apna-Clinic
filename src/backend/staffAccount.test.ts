// The staff-account Edge Function's logic, run with fake services. Real Supabase Auth and the real email provider are
// not reachable from here, so what these tests prove is the function's own rules: what it checks, what it refuses,
// what it sends, what it never sends, and what it tells the owner when email fails.
import { describe, expect, it } from 'vitest';
import { handle, type Deps } from '../../supabase/functions/staff-account/handler.ts';
import { passwordProblem } from '../../supabase/functions/_shared/password.ts';

const CLINIC = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const NEWUSER = '33333333-3333-4333-8333-333333333333';
const ENV: Record<string, string> = { RESEND_API_KEY: 're_test', EMAIL_FROM: 'Apna Clinic <no-reply@mail.example.com>', APP_BASE_URL: 'https://apna.example.com' };

interface Setup { rpcs?: Record<string, any>; env?: Record<string, string>; resend?: { ok: boolean; status?: number; body: any } | 'throw'; existing?: boolean }

function setup(o: Setup = {}) {
  const calls: { fn: string; args: any }[] = [];
  const sent: any[] = [];
  const created: any[] = [];
  const deleted: string[] = [];
  const setPw: any[] = [];
  const rpcs = {
    staff_precheck: { ok: true, state: 'new', clinic_name: 'Sunrise Clinic', inviter_name: 'Asha Owner' },
    provision_staff: { ok: true, doctor_id: null },
    create_invitation: { ok: true, invitation_id: 'inv-1' },
    staff_first_login_status: { ok: true, pending: true, email: 'staff@example.com', full_name: 'Ravi Kumar', clinic_name: 'Sunrise Clinic', role: 'receptionist' },
    finish_first_login: { ok: true }, staff_profile_name: 'Ravi Kumar', log_email_event: null, log_staff_event: null,
    ...o.rpcs,
  } as Record<string, any>;
  const deps: Deps = {
    env: (k) => (o.env ?? ENV)[k],
    fetch: (async (_url: any, init: any) => {
      if (o.resend === 'throw') throw new Error('network');
      sent.push(JSON.parse(init.body));
      const r = o.resend ?? { ok: true, body: { id: 'em_123' } };
      return new Response(JSON.stringify(r.body), { status: r.ok ? 200 : r.status ?? 403 });
    }) as typeof fetch,
    getUser: async (t) => (t === 'good' ? { id: OWNER, email: 'owner@example.com' } : null),
    verifyPassword: async (_e, p) => p === 'Temp-Pass-123',
    rpc: async (fn, args) => { calls.push({ fn, args }); return { data: rpcs[fn], error: null }; },
    createUser: async (a) => { created.push(a); return o.existing ? { error: 'exists' } : { id: NEWUSER }; },
    setPassword: async (id, pw) => { setPw.push({ id, pw }); return {}; },
    deleteUser: async (id) => { deleted.push(id); },
  };
  const call = (body: any, token: string | null = 'good') =>
    handle(new Request('https://f.test/staff-account', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) }), deps)
      .then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
  return { call, calls, sent, created, deleted, setPw };
}

const GOOD = { action: 'create', clinicId: CLINIC, fullName: 'Ravi Kumar', email: 'Staff@Example.com', role: 'receptionist', tempPassword: 'Temp-Pass-123', confirmPassword: 'Temp-Pass-123' };

describe('password rules', () => {
  it.each([['short1', 'at least 10'], ['alllettersnonumber', 'letter and one number'], ['password123', 'easy to guess'], ['staffname-9999', 'email']])(
    'rejects %s', (pw, text) => expect(passwordProblem(pw, { email: 'staffname@example.com' })).toContain(text));
  it('accepts a reasonable password', () => expect(passwordProblem('Blue-Tiger-42', { email: 'a@b.co' })).toBeNull());
});

describe('staff-account: create', () => {
  it('refuses a caller who is not signed in', async () => {
    const s = setup();
    expect((await s.call(GOOD, null)).status).toBe(401);
    expect((await s.call(GOOD, 'bad')).status).toBe(401);
    expect(s.created).toHaveLength(0);
  });

  it('checks every field and creates nothing when something is wrong', async () => {
    const s = setup();
    const r = await s.call({ ...GOOD, fullName: 'R2', email: 'nope', role: 'admin', tempPassword: 'short', confirmPassword: 'x' });
    expect(r.status).toBe(400);
    expect(Object.keys(r.json.field_errors).sort()).toEqual(['email', 'fullName', 'role', 'tempPassword']);
    const mismatch = await s.call({ ...GOOD, confirmPassword: 'Different-Pass-1' });
    expect(mismatch.json.field_errors.confirmPassword).toMatch(/do not match/);
    expect(s.created).toHaveLength(0);
    expect(s.calls).toHaveLength(0);
  });

  it('asks a doctor login to name an existing doctor or give new doctor details', async () => {
    const s = setup();
    const r = await s.call({ ...GOOD, role: 'doctor' });
    expect(r.status).toBe(400);
    expect(r.json.field_errors.doctorId).toMatch(/Choose a doctor/);
    expect(s.created).toHaveLength(0);
  });

  it('creates the account, sets the must-change flag, and emails a sign in link without the password', async () => {
    const s = setup();
    const r = await s.call(GOOD);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, kind: 'account', userId: NEWUSER, email: { status: 'sent' } });
    expect(s.created).toEqual([{ email: 'staff@example.com', password: 'Temp-Pass-123', fullName: 'Ravi Kumar' }]);
    const prov = s.calls.find((c) => c.fn === 'provision_staff')!.args;
    expect(prov).toMatchObject({ p_clinic: CLINIC, p_user_id: NEWUSER, p_inviter: OWNER, p_must_change: true });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].to).toEqual(['staff@example.com']);
    expect(s.sent[0].html).toContain('https://apna.example.com/login');
    expect(JSON.stringify(s.sent[0])).not.toContain('Temp-Pass-123');
    expect(s.calls.find((c) => c.fn === 'log_email_event')!.args).toMatchObject({ p_status: 'sent', p_template: 'staff_activation' });
  });

  it('creates the account but says plainly that email is not set up, never claiming it was sent', async () => {
    const s = setup({ env: {} });
    const r = await s.call(GOOD);
    expect(r.json.ok).toBe(true);
    expect(r.json.email.status).toBe('not_configured');
    expect(r.json.email.message).toMatch(/RESEND_API_KEY/);
    expect(s.sent).toHaveLength(0);
    expect(s.calls.find((c) => c.fn === 'log_email_event')!.args.p_status).toBe('skipped');
  });

  it('reports the provider refusal and does not say sent', async () => {
    const s = setup({ resend: { ok: false, status: 403, body: { message: 'The mail.example.com domain is not verified.' } } });
    const r = await s.call(GOOD);
    expect(r.json.email.status).toBe('failed');
    expect(r.json.email.message).toContain('domain is not verified');
    expect(s.calls.find((c) => c.fn === 'log_email_event')!.args).toMatchObject({ p_status: 'failed' });
    const down = setup({ resend: 'throw' });
    expect((await down.call(GOOD)).json.email.status).toBe('failed');
  });

  it('removes the new account again if it cannot be placed in the clinic', async () => {
    const s = setup({ rpcs: { provision_staff: { ok: false, code: 'invalid_transition', message: 'This doctor already has a login.' } } });
    const r = await s.call(GOOD);
    expect(r.status).toBe(409);
    expect(s.deleted).toEqual([NEWUSER]);
    expect(s.sent).toHaveLength(0);
  });

  it('says so when the address is already on the team', async () => {
    const s = setup({ rpcs: { staff_precheck: { ok: true, state: 'already_member' } } });
    const r = await s.call(GOOD);
    expect(r.status).toBe(409);
    expect(r.json.field_errors.email).toMatch(/already on your team/);
    expect(s.created).toHaveLength(0);
  });

  it('only invites an existing account, never attaching it or touching its password', async () => {
    const s = setup({ rpcs: { staff_precheck: { ok: true, state: 'existing_user', user_id: NEWUSER, full_name: 'Existing Person', clinic_name: 'Sunrise Clinic', inviter_name: 'Asha' } } });
    const r = await s.call(GOOD);
    expect(r.json).toMatchObject({ ok: true, kind: 'invitation', email: { status: 'sent' } });
    expect(s.created).toHaveLength(0);
    expect(s.setPw).toHaveLength(0);
    expect(s.calls.map((c) => c.fn)).not.toContain('provision_staff');
    expect(s.calls.find((c) => c.fn === 'create_invitation')!.args).toMatchObject({ p_user_id: NEWUSER, p_inviter: OWNER });
    expect(s.sent[0].subject).toContain('Sunrise Clinic');
    expect(JSON.stringify(s.sent[0])).not.toContain('Temp-Pass-123');
  });

  it('maps database refusals (not the owner, rate limit) to the right status', async () => {
    const forbidden = setup({ rpcs: { staff_precheck: { ok: false, code: 'forbidden', message: 'Only the clinic owner can add staff.' } } });
    expect((await forbidden.call(GOOD)).status).toBe(403);
    const limited = setup({ rpcs: { staff_precheck: { ok: false, code: 'rate_limited', message: 'Too many.' } } });
    expect((await limited.call(GOOD)).status).toBe(429);
  });

  it('handles an account that appears between the check and the creation', async () => {
    const s = setup({ existing: true });
    const r = await s.call(GOOD);
    expect(r.status).toBe(409);
    expect(s.calls.map((c) => c.fn)).not.toContain('provision_staff');
  });
});

describe('staff-account: resend and reset', () => {
  const body = { clinicId: CLINIC, userId: NEWUSER };
  it('resends only while the person has not chosen a password', async () => {
    const s = setup();
    const r = await s.call({ action: 'resend', ...body });
    expect(r.json.email.status).toBe('sent');
    expect(s.sent[0].to).toEqual(['staff@example.com']);
    const done = setup({ rpcs: { staff_first_login_status: { ok: true, pending: false, email: 'x@y.co' } } });
    const refused = await done.call({ action: 'resend', ...body });
    expect(refused.status).toBe(409);
    expect(done.sent).toHaveLength(0);
  });

  it('resets a temporary password only while the person has not chosen their own', async () => {
    const s = setup();
    const r = await s.call({ action: 'reset_temp_password', ...body, tempPassword: 'Another-Temp-77', confirmPassword: 'Another-Temp-77' });
    expect(r.json.ok).toBe(true);
    expect(s.setPw).toEqual([{ id: NEWUSER, pw: 'Another-Temp-77' }]);
    expect(JSON.stringify(s.sent)).not.toContain('Another-Temp-77');
    const done = setup({ rpcs: { staff_first_login_status: { ok: true, pending: false } } });
    expect((await done.call({ action: 'reset_temp_password', ...body, tempPassword: 'Another-Temp-77', confirmPassword: 'Another-Temp-77' })).status).toBe(409);
    expect(done.setPw).toHaveLength(0);
  });
});

describe('staff-account: change_password (the forced first sign in change)', () => {
  const ok = { action: 'change_password', currentPassword: 'Temp-Pass-123', newPassword: 'My-Own-Secret-9', confirmPassword: 'My-Own-Secret-9' };
  it('checks the current password, sets the new one, unlocks the account and sends a notice', async () => {
    const s = setup();
    const r = await s.call(ok);
    expect(r.json.ok).toBe(true);
    expect(s.setPw).toEqual([{ id: OWNER, pw: 'My-Own-Secret-9' }]);
    expect(s.calls.map((c) => c.fn)).toContain('finish_first_login');
    expect(s.sent[0].subject).toBe('Your Apna Clinic password was changed');
    expect(JSON.stringify(s.sent[0])).not.toContain('My-Own-Secret-9');
  });
  it('refuses a wrong current password, the same password, a weak one and a mismatch', async () => {
    const s = setup();
    expect((await s.call({ ...ok, currentPassword: 'Wrong-Pass-123' })).json.field_errors.currentPassword).toMatch(/not correct/);
    expect((await s.call({ ...ok, newPassword: 'Temp-Pass-123', confirmPassword: 'Temp-Pass-123' })).json.field_errors.newPassword).toMatch(/different/);
    expect((await s.call({ ...ok, newPassword: 'weak' })).json.field_errors.newPassword).toBeTruthy();
    expect((await s.call({ ...ok, confirmPassword: 'Nope-Nope-123' })).json.field_errors.confirmPassword).toMatch(/do not match/);
    expect(s.setPw).toHaveLength(0);
    expect(s.calls.map((c) => c.fn)).not.toContain('finish_first_login');
  });
  it('still succeeds when the notice email cannot be sent, and says so', async () => {
    const s = setup({ env: {} });
    const r = await s.call(ok);
    expect(r.json.ok).toBe(true);
    expect(r.json.email.status).toBe('not_configured');
  });
});
