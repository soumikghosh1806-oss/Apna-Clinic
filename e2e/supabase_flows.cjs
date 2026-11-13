// End to end checks of the real backend path, run in a real browser against the production build.
//
// The browser talks to a TEST ONLY stand-in for the Supabase API (supabase/tests/e2e/api-shim.mjs) that runs the real SQL
// functions, policies and triggers from the migrations on a throwaway Postgres. It does not prove Supabase's own Auth
// service, email delivery, Realtime delivery or hosted Storage. See the README for what still needs a run on the real project.
//
//   shim:    cd supabase/tests/e2e && node api-shim.mjs                      (port 54399)
//   build:   VITE_BACKEND=supabase VITE_SUPABASE_URL=http://127.0.0.1:54399 VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_localshim_000000000000000000 \
//            npx vite build --outDir /tmp/cliniq-e2e-dist && npx vite preview --outDir /tmp/cliniq-e2e-dist --port 4174
//   run:     node e2e/supabase_flows.cjs

const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4174';
const SHIM = process.env.SHIM_URL || 'http://127.0.0.1:54399';
const KEY = 'sb_publishable_localshim_000000000000000000';
const RUN = Math.random().toString(36).slice(2, 7);
const SLUG = `sunrise-${RUN}`;
const SLUG_B = `harbour-${RUN}`;
const PASSWORD = 'Correct-horse-9';

const results = [];
const problems = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shim(path, body) {
  const res = await fetch(`${SHIM}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return res.json();
}
const sql = (text, params) => shim('/__shim/query', { sql: text, params });

/** The realtime service is not part of the stand-in. A mock accepts the channel join and lets a test push a "queue changed" signal. */
async function mockRealtime(ctx, sockets) {
  await ctx.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    const entry = { ws, joins: {} };
    sockets.push(entry);
    ws.onMessage((raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (Array.isArray(m)) {
        const [joinRef, ref, topic, event] = m;
        entry.array = true;
        if (event === 'phx_join') { entry.joins[topic] = joinRef; ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: { postgres_changes: [] } }])); }
        else if (event === 'heartbeat') ws.send(JSON.stringify([null, ref, 'phoenix', 'phx_reply', { status: 'ok', response: {} }]));
      } else {
        const { topic, event, ref, join_ref } = m;
        if (event === 'phx_join') { entry.joins[topic] = join_ref; ws.send(JSON.stringify({ topic, event: 'phx_reply', payload: { status: 'ok', response: { postgres_changes: [] } }, ref, join_ref })); }
        else if (event === 'heartbeat') ws.send(JSON.stringify({ topic: 'phoenix', event: 'phx_reply', payload: { status: 'ok', response: {} }, ref }));
      }
    });
  });
}
function pushSignal(sockets, clinicId) {
  const topic = `realtime:queue:${clinicId}`;
  let sent = 0;
  for (const s of sockets) {
    if (!(topic in s.joins)) continue;
    const payload = { type: 'broadcast', event: 'queue_changed', payload: { doctor_id: null } };
    s.ws.send(JSON.stringify(s.array ? [null, null, topic, 'broadcast', payload] : { topic, event: 'broadcast', payload, ref: null }));
    sent += 1;
  }
  return sent;
}

let browser;
async function newContext(label, extra = {}) {
  const sockets = [];
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, ...extra });
  await mockRealtime(ctx, sockets);
  ctx.on('page', (page) => {
    page.on('console', (msg) => {
      if (!['error', 'warning'].includes(msg.type())) return;
      const text = msg.text();
      // The browser itself logs every refused request. Those are checked by the tests that cause them.
      if (/Failed to load resource/.test(text)) return;
      problems.push(`[${label}] ${msg.type()}: ${text}`);
    });
    page.on('pageerror', (err) => problems.push(`[${label}] pageerror: ${err.message}`));
  });
  return { ctx, sockets, label };
}

const see = async (page, text, timeout = 8000) => {
  try { await page.getByText(text, { exact: false }).first().waitFor({ timeout }); return true; } catch { return false; }
};
const fillLabel = (page, label, value) => page.getByLabel(label, { exact: true }).fill(value);
const bodyText = (page) => page.locator('body').innerText();

async function login(page, email, password = PASSWORD) {
  await page.goto(`${BASE}/login`);
  await fillLabel(page, 'Email address', email);
  await fillLabel(page, 'Password', password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

/** Calls an RPC as the browser's signed in user, the way the app does, and returns the answer. */
async function rpcAsPage(page, fn, args) {
  return page.evaluate(async ({ SHIM, KEY, fn, args }) => {
    const entry = Object.entries(localStorage).find(([k]) => k.startsWith('sb-') && k.endsWith('-auth-token'));
    const token = entry ? JSON.parse(entry[1]).access_token : KEY;
    const res = await fetch(`${SHIM}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: KEY, authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, { SHIM, KEY, fn, args });
}

async function main() {
  browser = await chromium.launch();
  const owner = await newContext('owner');
  const recep = await newContext('reception');
  const doctor = await newContext('doctor');
  const patient = await newContext('patient');
  const other = await newContext('clinic-b');
  const publicLeaks = [];

  // ------------------------------------------------------------------ public pages without a clinic
  const anon = await patient.ctx.newPage();
  patient.ctx.on('response', async (res) => {
    if (/rpc\/(get_public_queue|get_public_clinic)/.test(res.url())) publicLeaks.push(await res.text().catch(() => ''));
  });
  await anon.goto(`${BASE}/`);
  check('landing page offers clinic registration and staff login', (await see(anon, 'Register your clinic')) && (await see(anon, 'Staff login')));
  await anon.goto(`${BASE}/book`);
  check('booking page without a clinic address says to open the clinic link', await see(anon, 'Open the link your clinic gave you'));
  await anon.goto(`${BASE}/c/does-not-exist-${RUN}/book`);
  check('an unknown clinic address shows "could not find this clinic"', await see(anon, 'We could not find this clinic'));

  // ------------------------------------------------------------------ owner registers a clinic
  const o = await owner.ctx.newPage();
  await o.goto(`${BASE}/register`);
  await fillLabel(o, 'Your name', 'Dr Asha Rao');
  await fillLabel(o, 'Email address', `owner-${RUN}@example.test`);
  await fillLabel(o, 'Password', PASSWORD);
  await o.getByRole('button', { name: 'Create account' }).click();
  check('owner account created, clinic step shown', await see(o, 'Step 2 of 2'));
  await fillLabel(o, 'Clinic name', `Sunrise Clinic ${RUN}`);
  const slugGuess = await o.getByLabel('Clinic web address', { exact: true }).inputValue();
  check('clinic web address is suggested from the name', slugGuess === `sunrise-clinic-${RUN}`, slugGuess);
  await o.getByLabel('Clinic web address', { exact: true }).fill(SLUG);
  await o.getByRole('button', { name: 'Create clinic' }).click();
  await o.waitForURL('**/report', { timeout: 10000 }).catch(() => {});
  check('owner lands on the daily report after registering', o.url().endsWith('/report') && (await see(o, 'Daily report')), o.url());

  // a taken address is refused with a field error
  const dupPage = await other.ctx.newPage();
  await dupPage.goto(`${BASE}/register`);
  await fillLabel(dupPage, 'Your name', 'Capt Ravi Nair');
  await fillLabel(dupPage, 'Email address', `ownerb-${RUN}@example.test`);
  await fillLabel(dupPage, 'Password', PASSWORD);
  await dupPage.getByRole('button', { name: 'Create account' }).click();
  await see(dupPage, 'Step 2 of 2');
  await fillLabel(dupPage, 'Clinic name', `Harbour Clinic ${RUN}`);
  await dupPage.getByLabel('Clinic web address', { exact: true }).fill(SLUG);
  await dupPage.getByRole('button', { name: 'Create clinic' }).click();
  check('a taken clinic address is refused', await see(dupPage, 'already taken'));
  await dupPage.getByLabel('Clinic web address', { exact: true }).fill('admin');
  await dupPage.getByRole('button', { name: 'Create clinic' }).click();
  check('a reserved clinic address is refused', await see(dupPage, 'reserved'));
  await dupPage.getByLabel('Clinic web address', { exact: true }).fill(SLUG_B);
  await dupPage.getByRole('button', { name: 'Create clinic' }).click();
  await dupPage.waitForURL('**/report', { timeout: 10000 }).catch(() => {});
  check('second clinic registers with its own address', dupPage.url().endsWith('/report'), dupPage.url());

  const clinicRows = await sql('select id, slug, name from public.clinics order by created_at');
  const clinicA = clinicRows.find((c) => c.slug === SLUG);
  const clinicB = clinicRows.find((c) => c.slug === SLUG_B);
  check('both clinics exist with different ids', clinicA && clinicB && clinicA.id !== clinicB.id);

  // ------------------------------------------------------------------ owner sets up settings and a doctor
  await o.goto(`${BASE}/settings`);
  check('settings shows the clinic public links', (await see(o, `/c/${SLUG}/book`)) && (await see(o, `/c/${SLUG}/tv`)));
  await o.getByRole('button', { name: 'Add doctor' }).click();
  const dlg = o.getByRole('dialog');
  await dlg.getByLabel('Doctor name', { exact: true }).fill('Dr Meera Joshi');
  await dlg.getByLabel('OPD name', { exact: true }).fill('General OPD');
  await dlg.locator('#start-0').fill('00:00');
  await dlg.locator('#end-0').fill('23:59');
  await dlg.getByRole('button', { name: 'Add doctor' }).click();
  check('doctor added from settings', await see(o, 'Dr Meera Joshi was added'));
  // field validation comes from the database
  await o.getByRole('button', { name: 'Add doctor' }).first().click();
  const dlg2 = o.getByRole('dialog');
  await dlg2.getByRole('button', { name: 'Add doctor' }).click();
  check('empty doctor form shows field errors from the database', await see(o, 'Please fix the highlighted fields'));
  await dlg2.getByRole('button', { name: 'Cancel' }).click();

  await o.getByLabel('Online tokens one phone number can book each day', { exact: true }).fill('2');
  await o.getByRole('button', { name: 'Save settings' }).click();
  check('settings saved with the per-phone daily limit', await see(o, 'Settings saved'));
  await o.getByLabel('Online tokens one phone number can book each day', { exact: true }).fill('0');
  await o.getByRole('button', { name: 'Save settings' }).click();
  check('an invalid per-phone limit is refused', await see(o, 'whole number'));
  await o.getByLabel('Online tokens one phone number can book each day', { exact: true }).fill('2');
  await o.getByRole('button', { name: 'Save settings' }).click();

  // ------------------------------------------------------------------ staff accounts with a temporary password
  const TEMP = 'Welcome-Temp-42';
  const mailTo = async (address) => (await shim('/__shim/outbox')).filter((m) => m.type === 'email' && m.to === address);
  await o.getByRole('button', { name: 'Add staff' }).click();
  const add = o.getByRole('dialog');
  await add.getByRole('button', { name: 'Create account' }).click();
  check('an empty Add staff form shows field errors', await see(o, 'Please fix the highlighted fields'));
  await add.getByLabel('Full name', { exact: true }).fill('Priya Desai');
  await add.getByLabel('Email address', { exact: true }).fill(`reception-${RUN}@example.test`);
  await add.getByLabel('Temporary password', { exact: true }).fill('short');
  await add.getByLabel('Confirm temporary password', { exact: true }).fill('different');
  await add.getByRole('button', { name: 'Create account' }).click();
  check('a weak temporary password is refused with the rule', await see(o, 'Use at least 10 characters'));
  await add.getByLabel('Temporary password', { exact: true }).fill(TEMP);
  await add.getByLabel('Confirm temporary password', { exact: true }).fill('Other-Temp-4242');
  await add.getByRole('button', { name: 'Create account' }).click();
  check('a confirmation that does not match is refused', await see(o, 'do not match'));
  await add.getByLabel('Confirm temporary password', { exact: true }).fill(TEMP);
  await add.getByRole('button', { name: 'Create account' }).click();
  check('receptionist account created and the welcome email reported as sent', await see(o, 'Account created for Priya Desai. A welcome email with the sign in link was sent'));
  const welcome = (await mailTo(`reception-${RUN}@example.test`))[0];
  check('the welcome email has the right subject and a sign in link', welcome?.subject === 'Welcome to Apna Clinic: sign in to get started' && welcome.html.includes('http://localhost:4174/login'), JSON.stringify(welcome?.subject));
  check('the welcome email never contains the temporary password', !JSON.stringify(welcome ?? {}).includes(TEMP));

  await o.getByRole('button', { name: 'Add staff' }).click();
  const add2 = o.getByRole('dialog');
  await add2.getByLabel('Full name', { exact: true }).fill('Dr Meera Joshi');
  await add2.getByLabel('Email address', { exact: true }).fill(`doctor-${RUN}@example.test`);
  await add2.getByLabel('Role', { exact: true }).selectOption('doctor');
  await add2.getByLabel('Doctor record', { exact: true }).selectOption('existing');
  await add2.getByLabel('Temporary password', { exact: true }).fill(TEMP);
  await add2.getByLabel('Confirm temporary password', { exact: true }).fill(TEMP);
  await add2.getByRole('button', { name: 'Create account' }).click();
  check('a doctor login needs a doctor to be chosen', await see(o, 'Choose a doctor from the list'));
  await add2.getByLabel('Which doctor?', { exact: true }).selectOption({ label: 'Dr Meera Joshi (General OPD)' });
  await add2.getByRole('button', { name: 'Create account' }).click();
  check('doctor account created and linked to an existing doctor', await see(o, 'Account created for Dr Meera Joshi'));
  // The list reloads after the success message, so wait for the count to settle rather than reading it at once.
  const waitingRows = await o.waitForFunction(() => (document.body.innerText.match(/Waiting for first sign in/g) || []).length === 2, null, { timeout: 8000 }).then(() => true).catch(() => false);
  check('staff table shows both as waiting for their first sign in', waitingRows && (await o.getByText('Waiting for first sign in').count()) === 2);

  // the same email again is a duplicate
  await o.getByRole('button', { name: 'Add staff' }).click();
  const dup = o.getByRole('dialog');
  await dup.getByLabel('Full name', { exact: true }).fill('Priya Again');
  await dup.getByLabel('Email address', { exact: true }).fill(`RECEPTION-${RUN}@example.test`);
  await dup.getByLabel('Temporary password', { exact: true }).fill(TEMP);
  await dup.getByLabel('Confirm temporary password', { exact: true }).fill(TEMP);
  await dup.getByRole('button', { name: 'Create account' }).click();
  check('adding an email that is already on the team is refused', await see(o, 'already on your team'));

  // email trouble is reported honestly and never shown as sent
  await shim('/__shim/email-mode', { mode: 'fail' });
  await dup.getByLabel('Full name', { exact: true }).fill('Mohan Lal');
  await dup.getByLabel('Email address', { exact: true }).fill(`mohan-${RUN}@example.test`);
  await dup.getByRole('button', { name: 'Create account' }).click();
  check('when the email provider refuses, the account is made but the owner is told the email was NOT sent', (await see(o, 'welcome email was NOT sent')) && (await see(o, 'domain is not verified')));
  check('and nothing claims the email was sent', (await o.getByText('welcome email with the sign in link was sent').count()) === 0);
  check('no email was recorded as delivered for that address', (await mailTo(`mohan-${RUN}@example.test`)).length === 0);
  const failedLog = await sql(`select status, error from public.email_events where template = 'staff_activation' and recipient_hint like 'm***%' order by id desc limit 1`);
  check('the failed delivery is logged with the provider reason', failedLog[0]?.status === 'failed' && /not verified/.test(failedLog[0]?.error ?? ''), JSON.stringify(failedLog));
  await shim('/__shim/email-mode', { mode: 'off' });
  await o.getByRole('button', { name: 'Resend email' }).first().click();
  check('with email not configured the owner is told so', await see(o, 'not set up on this server'));
  await shim('/__shim/email-mode', { mode: 'ok' });
  await o.getByRole('row', { name: /Mohan Lal/ }).getByRole('button', { name: /Resend email/ }).click();
  check('after email works again, Resend email delivers it', await see(o, 'The welcome email was sent to'));
  check('the resent email arrived at the fake provider', (await mailTo(`mohan-${RUN}@example.test`)).length === 1);
  await o.getByRole('row', { name: /Mohan Lal/ }).getByRole('button', { name: /New temporary password/ }).click();
  const reset = o.getByRole('dialog');
  await reset.getByLabel('New temporary password', { exact: true }).fill('Fresh-Temp-5151');
  await reset.getByLabel('Confirm new temporary password', { exact: true }).fill('Fresh-Temp-5151');
  await reset.getByRole('button', { name: 'Save' }).click();
  check('the owner can set a new temporary password for someone who has not signed in yet', await see(o, 'new temporary password is set for Mohan Lal'));

  // someone who already has a Cliniq account is invited, never attached
  await fetch(`${SHIM}/auth/v1/signup`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: KEY }, body: JSON.stringify({ email: `existing-${RUN}@example.test`, password: PASSWORD, data: { full_name: 'Esha Existing' } }) });
  await o.getByRole('button', { name: 'Add staff' }).click();
  const invite = o.getByRole('dialog');
  await invite.getByLabel('Full name', { exact: true }).fill('Esha Existing');
  await invite.getByLabel('Email address', { exact: true }).fill(`existing-${RUN}@example.test`);
  await invite.getByLabel('Temporary password', { exact: true }).fill(TEMP);
  await invite.getByLabel('Confirm temporary password', { exact: true }).fill(TEMP);
  await invite.getByRole('button', { name: 'Create account' }).click();
  check('an existing account gets an invitation, not an attachment', await see(o, 'already has an Apna Clinic account'));
  const attachedNow = await sql(`select 1 from public.clinic_memberships m join auth.users u on u.id = m.user_id where u.email = $1 and m.clinic_id = $2`, [`existing-${RUN}@example.test`, clinicA.id]);
  check('they are NOT a member of the clinic until they accept', attachedNow.length === 0);
  const inviteMail = (await mailTo(`existing-${RUN}@example.test`))[0];
  check('the invitation email names the clinic and says nothing about a password', inviteMail && inviteMail.subject.includes(`Sunrise Clinic ${RUN}`) && !inviteMail.html.includes(TEMP), JSON.stringify(inviteMail?.subject));
  check('the owner sees the pending invitation', await see(o, 'Invitations waiting for a reply'));
  const ex = await (await newContext('existing-user')).ctx.newPage();
  await login(ex, `existing-${RUN}@example.test`);
  check('the invited person is told about the invitation after signing in', await see(ex, 'clinic invitation'));
  await ex.goto(`${BASE}/invitations`);
  check('the invitation page names the clinic and the role', (await see(ex, `Sunrise Clinic ${RUN}`)) && (await see(ex, 'Receptionist')));
  await ex.getByRole('button', { name: /Accept/ }).click();
  await ex.waitForURL('**/login', { timeout: 10000 }).catch(() => {});
  check('after accepting they work at the clinic as a receptionist', await see(ex, 'receptionist at') && await see(ex, `Sunrise Clinic ${RUN}`));

  // new doctor with professional details, in the second clinic
  const oB = dupPage;
  await oB.goto(`${BASE}/settings`);
  await oB.getByRole('button', { name: 'Add staff' }).click();
  const nd = oB.getByRole('dialog');
  await nd.getByLabel('Full name', { exact: true }).fill('Dr Kiran Skin');
  await nd.getByLabel('Email address', { exact: true }).fill(`kiran-${RUN}@example.test`);
  await nd.getByLabel('Role', { exact: true }).selectOption('doctor');
  await nd.getByLabel('Temporary password', { exact: true }).fill(TEMP);
  await nd.getByLabel('Confirm temporary password', { exact: true }).fill(TEMP);
  await nd.getByRole('button', { name: 'Create account' }).click();
  check('a new doctor needs a specialisation', await see(oB, 'Enter the specialisation'));
  await nd.getByLabel('Specialisation', { exact: true }).fill('Dermatologist');
  await nd.getByLabel('Qualification (optional)', { exact: true }).fill('MBBS, MD');
  await nd.getByLabel('Consultation fee in rupees (optional)', { exact: true }).fill('400');
  await nd.getByRole('button', { name: 'Create account' }).click();
  check('a doctor with professional details is created', await see(oB, 'Account created for Dr Kiran Skin'));
  const kiran = await sql(`select specialization, qualification, consultation_fee::text as fee from public.doctors where name = 'Dr Kiran Skin' and clinic_id = $1`, [clinicB.id]);
  check('the professional details are saved', kiran[0]?.specialization === 'Dermatologist' && kiran[0]?.qualification === 'MBBS, MD' && kiran[0]?.fee === '400.00', JSON.stringify(kiran));

  // each new person signs in with the temporary password and is forced to choose their own
  for (const [who, ctx, expectHome] of [['reception', recep, '/reception'], ['doctor', doctor, '/doctor']]) {
    const email = `${who}-${RUN}@example.test`;
    const page = await ctx.ctx.newPage();
    await login(page, email, 'Wrong-Temp-9999');
    check(`${who}: a wrong temporary password is refused`, await see(page, 'The email or password is not correct.'));
    await login(page, email, TEMP);
    check(`${who}: the first sign in shows the choose-your-own-password screen`, await see(page, 'Choose your own password'));
    const locked = await rpcAsPage(page, 'get_staff_snapshot', { p_clinic: clinicA.id });
    check(`${who}: until the password is changed the server gives no access`, locked.body?.ok === false && locked.body?.code === 'forbidden', JSON.stringify(locked));
    await page.goto(`${BASE}${expectHome}`);
    check(`${who}: opening a staff page directly still shows the forced change`, await see(page, 'Choose your own password'));
    await fillLabel(page, 'Temporary password', 'Wrong-Temp-9999');
    await fillLabel(page, 'New password', PASSWORD);
    await fillLabel(page, 'Confirm new password', PASSWORD);
    await page.getByRole('button', { name: 'Save new password' }).click();
    check(`${who}: a wrong current password is refused`, await see(page, 'current password is not correct'));
    await fillLabel(page, 'Temporary password', TEMP);
    await fillLabel(page, 'New password', TEMP);
    await fillLabel(page, 'Confirm new password', TEMP);
    await page.getByRole('button', { name: 'Save new password' }).click();
    check(`${who}: reusing the temporary password is refused`, await see(page, 'different from the one you have now'));
    await fillLabel(page, 'New password', 'short');
    await fillLabel(page, 'Confirm new password', 'short');
    await page.getByRole('button', { name: 'Save new password' }).click();
    check(`${who}: a weak new password is refused`, await see(page, 'Use at least 10 characters'));
    await fillLabel(page, 'New password', PASSWORD);
    await fillLabel(page, 'Confirm new password', PASSWORD);
    await page.getByRole('button', { name: 'Save new password' }).click();
    await page.getByRole('heading', { name: 'Choose your own password' }).waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
    check(`${who}: after choosing a password they reach their own dashboard`, page.url().endsWith(expectHome) && !(await see(page, 'Choose your own password', 800)), page.url());
    const open = await rpcAsPage(page, 'get_staff_snapshot', { p_clinic: clinicA.id });
    check(`${who}: the server now gives them their role`, open.body?.ok === true, JSON.stringify(open));
    check(`${who}: a password changed notice was emailed`, (await mailTo(email)).some((m) => m.subject === 'Your Apna Clinic password was changed'));
  }
  const everything = JSON.stringify(await shim('/__shim/outbox'));
  check('no email contains any temporary or chosen password', !everything.includes(TEMP) && !everything.includes(PASSWORD) && !everything.includes('Fresh-Temp-5151'));
  const rows = await sql(`select action from public.audit_log where clinic_id = $1 and action like 'staff.%' order by id`, [clinicA.id]);
  const staffActions = rows.map((r) => r.action);
  check('staff creation, invitation and first password change are all in the audit log',
    ['staff.create', 'staff.invitation_sent', 'staff.invitation_accepted', 'staff.password_changed', 'staff.activation_resent', 'staff.password_reset'].every((x) => staffActions.includes(x)), staffActions.join(','));

  // ------------------------------------------------------------------ patients book
  const p = anon;
  await p.goto(`${BASE}/c/${SLUG}/book`);
  check('patient booking page shows the clinic name and doctor', (await see(p, `Sunrise Clinic ${RUN}`)) && (await see(p, 'General OPD')));
  await fillLabel(p, 'Patient name', 'Test Patient');
  await fillLabel(p, 'Mobile number', '9876543210');
  await p.getByRole('button', { name: 'Book Token' }).click();
  await p.waitForURL('**/token/**', { timeout: 10000 }).catch(() => {});
  check('booking opens the token page under the clinic address', p.url().includes(`/c/${SLUG}/token/`), p.url());
  check('the first token is number 1', await see(p, 'Token 1', 3000) || (await p.locator('[aria-label="Token 1"]').count()) > 0);
  const tokenUrl = p.url();

  await p.goto(`${BASE}/c/${SLUG}/book`);
  await fillLabel(p, 'Patient name', 'Test Patient');
  await fillLabel(p, 'Mobile number', '9876543210');
  await p.getByRole('button', { name: 'Book Token' }).click();
  check('the same person booking twice is refused with a link to the existing token', (await see(p, 'View the existing token')) );
  await p.getByRole('link', { name: 'View the existing token' }).click();
  check('that link reopens the same token', (await p.waitForURL('**/token/**').then(() => true).catch(() => false)) && p.url() === tokenUrl, p.url());

  await p.goto(`${BASE}/c/${SLUG}/book`);
  await fillLabel(p, 'Patient name', 'Family Member');
  await fillLabel(p, 'Mobile number', '9876543210');
  await p.getByRole('button', { name: 'Book Token' }).click();
  await p.waitForURL('**/token/**', { timeout: 10000 }).catch(() => {});
  check('a second person on the same phone can book (limit is 2)', p.url().includes('/token/'));
  await p.goto(`${BASE}/c/${SLUG}/book`);
  await fillLabel(p, 'Patient name', 'Third Person');
  await fillLabel(p, 'Mobile number', '9876543210');
  await p.getByRole('button', { name: 'Book Token' }).click();
  check('a third online booking from one phone is refused', await see(p, 'too many') || await see(p, 'limit') || await see(p, 'tokens from this number'));
  const issued = await sql(`select token_number as number from public.queue_tokens where clinic_id = $1 order by token_number`, [clinicA.id]);
  check('refused bookings did not use up token numbers', JSON.stringify(issued.map((r) => r.number)) === '[1,2]', JSON.stringify(issued));

  // public pages show numbers only
  await p.goto(`${BASE}/c/${SLUG}/queue`);
  await see(p, 'Live queue');
  const queueText = await bodyText(p);
  await p.goto(`${BASE}/c/${SLUG}/tv`);
  await sleep(1500);
  const tvText = await bodyText(p);
  check('the live queue and waiting room display never show patient names or phones',
    !/Test Patient|Family Member|9876543210|98765/.test(queueText + tvText), queueText.slice(0, 200));
  check('public clinic and queue answers never carry names or phones', publicLeaks.length > 0 && publicLeaks.every((t) => !/Test Patient|Family Member|9876543210/.test(t)), publicLeaks.length);

  // ------------------------------------------------------------------ reception
  const r = await recep.ctx.newPage();
  await r.goto(`${BASE}/reception`);
  check('reception sees the booked patients by name', (await see(r, 'Test Patient')) && (await see(r, 'Family Member')));
  const row1 = r.locator('tr', { hasText: 'Test Patient' });
  await row1.getByRole('button', { name: /Mark arrived/ }).click();
  check('reception marks the patient as arrived', await see(r, 'marked as arrived'));
  await r.locator('tr', { hasText: 'Family Member' }).getByRole('button', { name: /Mark arrived/ }).click();
  await sleep(500);
  await r.goto(`${BASE}/reception/walk-in`);
  await fillLabel(r, 'Patient name', 'Walk In Person');
  await fillLabel(r, 'Mobile number', '9123456780');
  await r.getByRole('button', { name: /Create token|Add walk-in|Add to queue|Add patient|Walk-in/i }).first().click();
  check('walk-in gets the next number in line', await see(r, 'Token #3 was added'));
  await r.goto(`${BASE}/reception/patients`);
  await r.getByLabel('Name or phone number', { exact: true }).fill('Test');
  check('patient search finds the patient', await see(r, 'Test Patient'));
  const none = await r.getByLabel('Name or phone number', { exact: true }).fill('Zzzzqq') ;
  check('patient search for someone else shows no match', await see(r, 'No patient') || await see(r, 'No matching') || await see(r, 'no match'));

  // reception cannot reach clinical screens or data
  await r.goto(`${BASE}/doctor`);
  check('reception is blocked from the doctor screen', await see(r, 'Your role does not include this screen'));
  await r.goto(`${BASE}/settings`);
  check('reception is blocked from settings', await see(r, 'Your role does not include this screen'));
  const patRow = (await sql(`select id from public.patients where clinic_id = $1 and name = 'Test Patient'`, [clinicA.id]))[0];
  const hist = await rpcAsPage(r, 'get_patient_history', { p_clinic: clinicA.id, p_patient_id: patRow.id });
  check('reception cannot read a patient history through the API', hist.body?.ok === false && hist.body?.code === 'forbidden', JSON.stringify(hist));
  const inviteTry = await rpcAsPage(r, 'list_staff', { p_clinic: clinicA.id });
  check('reception cannot list staff through the API', inviteTry.body?.ok === false, JSON.stringify(inviteTry));

  // ------------------------------------------------------------------ doctor
  const d = await doctor.ctx.newPage();
  await d.goto(`${BASE}/doctor`);
  await see(d, 'Next patient');
  await d.getByRole('button', { name: 'NEXT' }).click();
  const nowServing = (n) => d.locator(`section[aria-label="Current patient"] [aria-label="Token ${n}"]`).waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
  check('NEXT calls token 1 first (lowest number)', await nowServing(1));
  const serving = await sql(`select token_number as number, status from public.queue_tokens where clinic_id = $1 order by token_number`, [clinicA.id]);
  check('only token 1 is being served', serving.filter((t) => t.status === 'serving').map((t) => t.number).join() === '1', JSON.stringify(serving));
  await d.getByRole('link', { name: 'Patient history' }).click();
  check('doctor opens the patient history', await see(d, 'Visit timeline'));
  await d.getByRole('button', { name: 'Add consultation note' }).click();
  const vf = d.getByRole('dialog');
  await vf.getByLabel('Reason for visit', { exact: true }).fill('Fever and cough');
  await vf.getByLabel('Symptoms (optional)', { exact: true }).fill('Fever for two days');
  await vf.getByLabel('Diagnosis (optional)', { exact: true }).fill('Viral fever');
  await vf.getByLabel('Consultation notes', { exact: true }).fill('Rest and fluids');
  await vf.getByLabel('Advice', { exact: true }).fill('Review in 3 days');
  await vf.locator('#attach').setInputFiles({ name: 'blood-test.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake report') });
  await vf.getByRole('button', { name: 'Save' }).click();
  check('consultation note saved with a report file', await see(d, 'Consultation note added'));
  check('the visit shows on the timeline with its clinical text', (await see(d, 'Fever and cough')) && (await see(d, 'Viral fever')));
  check('the uploaded report is listed', await see(d, 'blood-test.pdf'));
  // Headless Chromium saves a PDF instead of showing it, so the new tab stays blank. What matters is where the tab was sent.
  const navigations = [];
  d.context().on('request', (req) => { if (req.isNavigationRequest() && /\/object\/sign\/patient-reports\/.+token=/.test(req.url())) navigations.push(req.url()); });
  const storageLog = [];
  d.on('response', async (res) => { if (/storage\/v1|authorize_report_download/.test(res.url())) storageLog.push(`${res.status()} ${res.url().slice(0, 110)} ${(await res.text().catch(() => '')).slice(0, 120)}`); });
  const [popup] = await Promise.all([
    d.context().waitForEvent('page', { timeout: 10000 }).catch(() => null),
    d.getByRole('button', { name: /Open blood-test\.pdf/ }).first().click(),
  ]);
  await sleep(1500);
  check('opening a report sends a new tab to a short lived signed link', Boolean(popup) && navigations.length === 1, `${navigations.length} | ${storageLog.join(' || ')}`);
  check('the signed link is for a file in this clinic\'s own folder', navigations.length === 1 && navigations[0].includes(`/patient-reports/${clinicA.id}/`), navigations[0]);
  if (popup && !popup.isClosed()) await popup.close();
  await d.getByRole('button', { name: /Write prescription/ }).first().click();
  const rx = d.getByRole('dialog');
  await rx.getByLabel('Name', { exact: true }).fill('Paracetamol 500 mg');
  await rx.getByLabel('Dose', { exact: true }).fill('1 tablet');
  await rx.getByLabel('How often', { exact: true }).fill('Three times a day');
  await rx.getByLabel('For how long', { exact: true }).fill('3 days');
  await rx.getByRole('button', { name: 'Save prescription' }).click();
  check('prescription saved and shown on the visit', (await see(d, 'Prescription saved')) && (await see(d, 'Paracetamol 500 mg')));
  await d.reload();
  check('the note and prescription are still there after a reload', (await see(d, 'Viral fever')) && (await see(d, 'Paracetamol 500 mg')));
  const audit = await sql(`select action from public.audit_log where clinic_id = $1`, [clinicA.id]);
  const actions = new Set(audit.map((a) => a.action));
  check('opening history, saving visit, prescription and report access are in the audit log',
    ['patient.history_read', 'visit.save', 'prescription.save', 'report.upload', 'report.open'].every((a) => actions.has(a)), [...actions].join());

  // queue actions
  await d.goto(`${BASE}/doctor`);
  const nextCalls = [];
  d.on('response', async (res) => { if (/rpc\/call_next/.test(res.url())) nextCalls.push({ status: res.status(), body: (await res.text().catch(() => '')).slice(0, 160), request: (res.request().postData() || '').slice(0, 120) }); });
  await d.getByRole('button', { name: 'Hold' }).click();
  check('doctor puts the patient on hold', await see(d, '#1 is on hold.')); // exact message: "No patient is on hold." is on the page already
  await d.getByRole('button', { name: 'NEXT' }).click();
  const calledTwo = await nowServing(2);
  let why = '';
  if (!calledTwo) {
    const tokens = await sql(`select token_number n, status from public.queue_tokens where clinic_id = $1 order by 1`, [clinicA.id]);
    const next = await d.getByRole('button', { name: 'NEXT' });
    why = `screen says: ${(await d.locator('[role="alert"], [role="status"], .notice').allInnerTexts().catch(() => [])).join(' | ').slice(0, 200)}; NEXT disabled=${await next.isDisabled().catch(() => 'n/a')}; calls to call_next: ${JSON.stringify(nextCalls)}; tokens: ${JSON.stringify(tokens)}`;
  }
  check('NEXT then calls token 2', calledTwo, why);
  await d.getByRole('button', { name: 'Skip patient' }).click();
  check('doctor skips a patient', await see(d, 'Skipped #2'));
  await d.getByRole('button', { name: 'NEXT' }).click();
  check('NEXT then calls the walk-in, token 3', await nowServing(3));
  await d.getByRole('button', { name: 'Mark completed' }).click();
  check('doctor completes the consultation', await see(d, 'Finished #3'));
  const states = await sql(`select token_number as number, status from public.queue_tokens where clinic_id = $1 order by token_number`, [clinicA.id]);
  check('final states are 1 on hold, 2 skipped, 3 completed', JSON.stringify(states.map((t) => `${t.number}:${t.status}`)) === JSON.stringify(['1:on_hold', '2:skipped', '3:completed']), JSON.stringify(states));

  // the patient's own page follows the queue
  await p.goto(tokenUrl);
  check('the patient token page shows the on-hold state', await see(p, 'on hold'));

  // ------------------------------------------------------------------ concurrency and per-day uniqueness
  const doctorA = (await sql('select id from public.doctors where clinic_id = $1 limit 1', [clinicA.id]))[0];
  const today = (await sql(`select (now() at time zone 'Asia/Kolkata')::date::text as d`))[0].d;
  const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => p.evaluate(async ({ SHIM, KEY, slug, i, doctorId, date }) => {
    const res = await fetch(`${SHIM}/rest/v1/rpc/book_token`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: KEY, authorization: `Bearer ${KEY}` }, body: JSON.stringify({ p_slug: slug, p_name: `Burst ${String.fromCharCode(65 + i)}`, p_phone: `90000000${10 + i}`, p_doctor_id: doctorId, p_date: date }) });
    return res.json();
  }, { SHIM, KEY, slug: SLUG, i, doctorId: doctorA.id, date: today })));
  const numbers = burst.filter((b) => b.ok).map((b) => b.token?.number).sort((a, b) => a - b);
  const distinct = new Set(numbers).size === numbers.length;
  check('eight bookings at the same moment get eight different numbers', distinct && numbers.length === 8, JSON.stringify(burst.slice(0, 2)));
  const dupCount = await sql(`select count(*) - count(distinct (queue_date, doctor_id, token_number)) as dup from public.queue_tokens where clinic_id = $1`, [clinicA.id]);
  check('the database holds no duplicate token numbers', Number(dupCount[0].dup) === 0);

  // ------------------------------------------------------------------ owner: report, online booking switch
  await o.goto(`${BASE}/report`);
  await see(o, 'Total patients');
  await o.locator('p[role="status"]', { hasText: 'Loading...' }).waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
  const reportText = await bodyText(o);
  check('the daily report counts today\'s tokens', /Total patients\s*\n?\s*(1[0-9]|[3-9])/.test(reportText), reportText.slice(0, 300));
  const [download] = await Promise.all([o.waitForEvent('download', { timeout: 10000 }).catch(() => null), o.getByRole('button', { name: /Download CSV/ }).click().catch(() => null)]);
  const csv = download ? require('fs').readFileSync(await download.path(), 'utf8') : '';
  check('the monthly CSV has counts and no names', csv.startsWith('date,opd,tokens_issued') && !/Test Patient|9876543210/.test(csv), csv.slice(0, 120));

  await o.goto(`${BASE}/settings`);
  await o.getByRole('switch').first().uncheck();
  await o.getByRole('button', { name: 'Save settings' }).click();
  await see(o, 'Settings saved');
  const off = await p.evaluate(async ({ SHIM, KEY, slug, doctorId, date }) => (await (await fetch(`${SHIM}/rest/v1/rpc/book_token`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: KEY, authorization: `Bearer ${KEY}` }, body: JSON.stringify({ p_slug: slug, p_name: 'Late Person', p_phone: '9111111111', p_doctor_id: doctorId, p_date: date }) })).json()), { SHIM, KEY, slug: SLUG, doctorId: doctorA.id, date: today });
  check('with online booking off the database refuses new online tokens', off.ok === false && off.code === 'online_disabled', JSON.stringify(off));
  await p.goto(`${BASE}/c/${SLUG}/book`);
  check('the booking page tells patients that online booking is off', await see(p, 'Online booking is off') || await see(p, 'switched off') || await see(p, 'not taking online'));
  await o.getByRole('switch').first().check();
  await o.getByRole('button', { name: 'Save settings' }).click();
  await see(o, 'Settings saved');

  // ------------------------------------------------------------------ realtime signal reaches an open staff screen
  await r.goto(`${BASE}/reception`);
  await see(r, 'Family Member');
  await sql(`update public.doctors set opd_name = 'Signal OPD' where id = $1`, [doctorA.id]);
  const sent = pushSignal(recep.sockets, clinicA.id);
  check('the reception screen joined its clinic channel', sent >= 1, `sockets: ${recep.sockets.length}`);
  const t0 = Date.now();
  const refreshed = await see(r, 'Signal OPD', 4000);
  check('a "queue changed" signal refreshes an open staff screen within a few seconds', refreshed && Date.now() - t0 < 4000, `${Date.now() - t0} ms`);
  await sql(`update public.doctors set opd_name = 'General OPD' where id = $1`, [doctorA.id]);

  // ------------------------------------------------------------------ isolation
  const b = await other.ctx.newPage();
  await b.goto(`${BASE}/reception`);
  const bsearch = await rpcAsPage(b, 'search_patients', { p_clinic: clinicA.id, p_query: 'Test' });
  check('another clinic owner cannot search this clinic\'s patients', bsearch.body?.ok === false && bsearch.body?.code === 'forbidden', JSON.stringify(bsearch));
  for (const [fn, args] of [
    ['get_staff_snapshot', { p_clinic: clinicA.id }],
    ['get_patient_history', { p_clinic: clinicA.id, p_patient_id: patRow.id }],
    ['list_staff', { p_clinic: clinicA.id }],
    ['get_report_series', { p_clinic: clinicA.id, p_end: new Date().toISOString().slice(0, 10), p_doctor_id: null }],
    ['update_clinic_settings', { p_clinic: clinicA.id, p_clinic_name: 'Hijacked', p_online_booking_enabled: false, p_default_daily_limit: 5, p_default_minutes_per_patient: 5, p_max_online_bookings_per_phone: 1 }],
  ]) {
    const res = await rpcAsPage(b, fn, args);
    check(`another clinic cannot call ${fn} on this clinic`, res.body?.ok === false || res.status >= 400, JSON.stringify(res));
  }
  const hijacked = await sql(`select name from public.clinics where id = $1`, [clinicA.id]);
  check('this clinic\'s name was not changed by the attempt', hijacked[0].name === `Sunrise Clinic ${RUN}`, hijacked[0].name);
  await b.goto(`${BASE}/report`);
  await see(b, 'Total patients');
  await b.locator('p[role="status"]', { hasText: 'Loading...' }).waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
  const bReport = await bodyText(b);
  check('clinic B\'s report counts none of clinic A\'s patients', /Total patients\s*\n?\s*0\b/.test(bReport), bReport.slice(0, 300));
  const bSnap = await rpcAsPage(b, 'get_staff_snapshot', { p_clinic: clinicB.id });
  check('clinic B\'s own snapshot holds no token or patient of clinic A', bSnap.body?.ok === true && !JSON.stringify(bSnap.body).includes('Test Patient') && !JSON.stringify(bSnap.body).includes(clinicA.id));

  // signed out / forged
  const out = await patient.ctx.newPage();
  const noAuth = await out.evaluate(async ({ SHIM, KEY, clinic }) => {
    const res = await fetch(`${SHIM}/rest/v1/rpc/get_staff_snapshot`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: KEY, authorization: `Bearer ${KEY}` }, body: JSON.stringify({ p_clinic: clinic }) });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, { SHIM, KEY, clinic: clinicA.id });
  check('the public cannot call a staff function', noAuth.status === 401 || noAuth.status === 403 || noAuth.body?.ok === false, JSON.stringify(noAuth));
  const forged = await out.evaluate(async ({ SHIM, KEY, clinic }) => {
    const fake = `${btoa('{"alg":"HS256"}')}.${btoa(JSON.stringify({ sub: '00000000-0000-0000-0000-000000000000', role: 'authenticated', exp: 9999999999 }))}.x`;
    const res = await fetch(`${SHIM}/rest/v1/rpc/get_staff_snapshot`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: KEY, authorization: `Bearer ${fake}` }, body: JSON.stringify({ p_clinic: clinic }) });
    return res.status;
  }, { SHIM, KEY, clinic: clinicA.id });
  check('a forged sign-in token is rejected', forged === 401, forged);
  await out.goto(`${BASE}/reception`);
  await out.waitForURL('**/login', { timeout: 8000 }).catch(() => {});
  check('a signed out visitor to a staff screen is sent to the login page', out.url().endsWith('/login'), out.url());

  // login errors do not reveal which part was wrong
  await login(out, `owner-${RUN}@example.test`, 'wrong-password-1');
  const wrongPw = await see(out, 'The email or password is not correct');
  await login(out, `nobody-${RUN}@example.test`, 'wrong-password-1');
  const wrongUser = await see(out, 'The email or password is not correct');
  check('a wrong password and an unknown email give the same message', wrongPw && wrongUser);
  await fillLabel(out, 'Email address', `owner-${RUN}@example.test`);
  await out.getByRole('button', { name: 'Forgot your password?' }).click();
  check('forgot password gives a neutral confirmation', await see(out, 'If that email address has an account'));
  check('a reset email was queued for the known address only', (await shim('/__shim/outbox')).filter((m) => m.type === 'recover' && m.email.endsWith(`-${RUN}@example.test`)).length === 1);

  // log out
  await r.goto(`${BASE}/reception`);
  await r.getByRole('button', { name: 'Log out' }).click();
  await r.waitForURL('**/login', { timeout: 8000 }).catch(() => {});
  check('log out returns to the login page', r.url().endsWith('/login'), r.url());
  await r.goto(`${BASE}/reception`);
  await r.waitForURL('**/login', { timeout: 8000 }).catch(() => {});
  check('after logging out a staff screen is no longer reachable', r.url().endsWith('/login'), r.url());

  // ------------------------------------------------------------------ email confirmation required (the usual hosted setting)
  await shim('/__shim/confirm-mode', { on: true });
  const cf = await (await newContext('confirm')).ctx.newPage();
  await cf.goto(`${BASE}/register`);
  await fillLabel(cf, 'Your name', 'Late Confirmer');
  await fillLabel(cf, 'Email address', `confirm-${RUN}@example.test`);
  await fillLabel(cf, 'Password', PASSWORD);
  await cf.getByRole('button', { name: 'Create account' }).click();
  check('when email confirmation is required, registering says to check the email', await see(cf, 'We sent you a link to confirm your email address'));
  await login(cf, `confirm-${RUN}@example.test`);
  check('signing in before confirming is refused with a clear reason', await see(cf, 'Confirm your email address first'));
  await shim('/__shim/confirm', { email: `confirm-${RUN}@example.test` });
  await login(cf, `confirm-${RUN}@example.test`);
  check('after confirming, a signed in account with no clinic is offered clinic registration', (await see(cf, 'not linked to a clinic yet')) && (await see(cf, 'Register a clinic')));
  await cf.goto(`${BASE}/register`);
  check('the registration page continues at step 2 for that account', await see(cf, 'Step 2 of 2'));
  await shim('/__shim/confirm-mode', { on: false });

  // ------------------------------------------------------------------ phone width and accessibility on the real screens
  let axeSource = null;
  try { axeSource = require.resolve('axe-core/axe.min.js'); } catch { /* optional */ }
  const rr = await (await newContext('reception-2')).ctx.newPage();
  await login(rr, `reception-${RUN}@example.test`);
  await rr.waitForURL('**/reception', { timeout: 10000 }).catch(() => {});
  const auditPages = [
    [anon, `/c/${SLUG}/book`, 'booking'], [anon, `/c/${SLUG}/queue`, 'live queue'], [anon, `/c/${SLUG}/tv`, 'waiting room display'],
    [anon, tokenUrl.replace(BASE, ''), 'token page'], [anon, '/register', 'register'], [anon, '/login', 'login'], [anon, '/', 'landing'],
    [anon, `/c/${SLUG}`, 'clinic home'], [anon, '/privacy', 'privacy'], [anon, '/terms', 'terms'],
    [o, '/settings', 'settings'], [o, '/report', 'report'],
    [d, '/doctor', 'doctor panel'], [d, `/doctor/history/${patRow.id}`, 'patient history'],
    [rr, '/reception', 'reception list'], [rr, '/reception/walk-in', 'walk-in'], [rr, '/reception/patients', 'patient search'],
  ];
  const overflow = [];
  const violations = [];
  for (const [page, path, label] of auditPages) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}${path}`);
    await page.locator('main h1').first().waitFor({ timeout: 8000 }).catch(() => {});
    await sleep(700);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (wide > 1) overflow.push(`${label} (+${wide}px)`);
    if (axeSource) {
      await page.addScriptTag({ path: axeSource });
      const found = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })).violations.map((v) => `${v.id}: ${v.nodes.length}`));
      if (found.length) violations.push(`${label}: ${found.join(', ')}`);
    }
  }
  check('no screen scrolls sideways on a 390 px phone', overflow.length === 0, overflow.join('; '));
  if (axeSource) check('no accessibility rule violations (axe, WCAG 2.1 A and AA) on the real-backend screens', violations.length === 0, violations.join(' | '));
  else console.log('SKIP  accessibility scan (axe-core is not installed)');

  await browser.close();

  console.log('');
  const failed = results.filter((x) => !x.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (problems.length) { console.log('Console problems:'); [...new Set(problems)].forEach((x) => console.log('  ' + x)); }
  else console.log('No console errors or warnings in any tab.');
  process.exit(failed.length || problems.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error('SCRIPT ERROR', error);
  try { await browser?.close(); } catch { /* ignore */ }
  process.exit(2);
});
