// Real backend path, public booking: the home page clinic directory, search and filters, the owner's listing settings,
// booking with a one time code (text message and email), the confirmation and cancellation emails, the live queue, "check
// my place", and that nothing private reaches a visitor. Run with the stand-in API:
//
//   bash scripts/run-e2e.sh e2e/public_booking_flows.cjs
//
// What is real here: the built web app in a real browser, every SQL function, policy and trigger from the migrations, and
// the actual code of the booking-public Edge Function (its rules, its templates, its hashing of codes). What is replaced:
// the text message provider and the email provider are local fakes that record what they receive (the fake phone shows
// the code the patient would read). Real delivery to a real phone or inbox is NOT proven by this script.

const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4174';
const SHIM = process.env.SHIM_URL || 'http://127.0.0.1:54399';
const RUN = Math.random().toString(36).slice(2, 7);
const PASSWORD = 'Correct-horse-9';
const SLUG_A = `sunrise-${RUN}`;
const SLUG_B = `harbour-${RUN}`;
const SLUG_C = `hidden-${RUN}`;
const NAME_A = `Sunrise Skin ${RUN}`;
const NAME_B = `Harbour Heart ${RUN}`;
const NAME_C = `Hidden Family ${RUN}`;

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
const see = async (page, text, timeout = 8000) => {
  try { await page.getByText(text, { exact: false }).first().waitFor({ timeout }); return true; } catch { return false; }
};
const fillLabel = (page, label, value) => page.getByLabel(label, { exact: true }).fill(value);
const bodyText = (page) => page.locator('body').innerText();
const lastCode = async (to) => {
  const messages = (await shim('/__shim/sms')).filter((m) => !to || m.to === `+91${to}`);
  const m = messages[messages.length - 1];
  return m ? /^(\d{6}) is your Apna Clinic verification code/.exec(m.body)?.[1] : undefined;
};
const mails = async (to) => (await shim('/__shim/outbox')).filter((m) => m.type === 'email' && (!to || m.to === to));

async function mockRealtime(ctx) {
  await ctx.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    ws.onMessage((raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (Array.isArray(m)) {
        const [joinRef, ref, topic, event] = m;
        if (event === 'phx_join') ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: { postgres_changes: [] } }]));
        else if (event === 'heartbeat') ws.send(JSON.stringify([null, ref, 'phoenix', 'phx_reply', { status: 'ok', response: {} }]));
      } else {
        const { topic, event, ref, join_ref } = m;
        if (event === 'phx_join') ws.send(JSON.stringify({ topic, event: 'phx_reply', payload: { status: 'ok', response: { postgres_changes: [] } }, ref, join_ref }));
        else if (event === 'heartbeat') ws.send(JSON.stringify({ topic: 'phoenix', event: 'phx_reply', payload: { status: 'ok', response: {} }, ref }));
      }
    });
  });
}

let browser;
const publicBodies = []; // every answer a visitor's browser received from the database or the Edge Function
async function newContext(label, { watch = false, viewport = { width: 1200, height: 1000 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  await mockRealtime(ctx);
  ctx.on('page', (page) => {
    page.on('console', (msg) => {
      if (!['error', 'warning'].includes(msg.type())) return;
      if (/Failed to load resource/.test(msg.text())) return; // refusals such as 429 are expected and checked elsewhere
      problems.push(`[${label}] ${msg.type()}: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`[${label}] pageerror: ${err.message}`));
  });
  if (watch) {
    ctx.on('response', async (res) => {
      if (/\/rest\/v1\/rpc\/|\/functions\/v1\//.test(res.url())) publicBodies.push({ url: res.url(), text: await res.text().catch(() => '') });
    });
  }
  return ctx;
}

async function registerClinic(ctx, who, clinicName, slug, city) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/register`);
  await fillLabel(page, 'Your name', who.name);
  await fillLabel(page, 'Email address', who.email);
  await fillLabel(page, 'Password', PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await see(page, 'Step 2 of 2');
  await fillLabel(page, 'Clinic name', clinicName);
  await page.getByLabel('Clinic web address', { exact: true }).fill(slug);
  const cityBox = page.getByLabel(/^City/);
  if (await cityBox.count()) await cityBox.first().fill(city).catch(() => {});
  await page.getByRole('button', { name: 'Create clinic' }).click();
  await page.waitForURL('**/report', { timeout: 10000 }).catch(() => {});
  return page;
}

async function addDoctor(page, name, opd) {
  await page.goto(`${BASE}/settings`);
  await page.getByRole('button', { name: 'Add doctor' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Doctor name', { exact: true }).fill(name);
  await dlg.getByLabel('OPD name', { exact: true }).fill(opd);
  await dlg.locator('#start-0').fill('00:00');
  await dlg.locator('#end-0').fill('23:59');
  await dlg.getByRole('button', { name: 'Add doctor' }).click();
  return see(page, `${name} was added`);
}

/** Fills the booking form like a patient. */
async function fillBooking(p, { name, phone, email }) {
  await fillLabel(p, 'Patient name', name);
  await fillLabel(p, 'Mobile number', phone);
  if (email !== undefined) await fillLabel(p, 'Email address (optional)', email);
}

async function main() {
  browser = await chromium.launch();
  const ownerCtx = await newContext('owner');
  const ownerB = await newContext('owner-b');
  const ownerC = await newContext('owner-c');
  const visitor = await newContext('visitor', { watch: true });

  // ------------------------------------------------------------------ three clinics, two doctors in the first
  const emailA = `owner-a-${RUN}@example.test`;
  const o = await registerClinic(ownerCtx, { name: 'Asha Owner', email: emailA }, NAME_A, SLUG_A, 'Pune');
  const ob = await registerClinic(ownerB, { name: 'Bela Owner', email: `owner-b-${RUN}@example.test` }, NAME_B, SLUG_B, 'Mumbai');
  const oc = await registerClinic(ownerC, { name: 'Chitra Owner', email: `owner-c-${RUN}@example.test` }, NAME_C, SLUG_C, 'Pune');
  const clinics = await sql('select id, slug from public.clinics where slug = any($1)', [[SLUG_A, SLUG_B, SLUG_C]]);
  check('three clinics registered by three different owners', clinics.length === 3, JSON.stringify(clinics));
  const idOf = (slug) => clinics.find((c) => c.slug === slug)?.id;

  check('Dr Meera Skin added', await addDoctor(o, 'Dr Meera Skin', 'Skin OPD'));
  check('Dr Ravi Hair added', await addDoctor(o, 'Dr Ravi Hair', 'Hair OPD'));
  check('Dr Neel Heart added', await addDoctor(ob, 'Dr Neel Heart', 'Heart OPD'));
  check('Dr Uma Quiet added', await addDoctor(oc, 'Dr Uma Quiet', 'Child OPD'));
  await sql(`update public.doctors set specialization = 'Dermatologist' where name in ('Dr Meera Skin', 'Dr Ravi Hair') and clinic_id = $1`, [idOf(SLUG_A)]);
  await sql(`update public.doctors set specialization = 'Cardiologist' where name = 'Dr Neel Heart'`);
  await sql(`update public.doctors set specialization = 'Paediatrician' where name = 'Dr Uma Quiet'`);
  const doctors = await sql('select id, name, clinic_id from public.doctors');
  const doc = (name) => doctors.find((d) => d.name === name);

  // ------------------------------------------------------------------ the home page before anyone is listed
  const v = await visitor.newPage();
  await v.goto(`${BASE}/`);
  check('the home page says "Book Your Doctor Appointment"', await see(v, 'Book Your Doctor Appointment'));
  check('the brand in the header is Apna Clinic', (await v.locator('.brand__name').first().innerText()).trim() === 'Apna Clinic');
  check('the page title carries the brand', (await v.title()).includes('Apna Clinic'), await v.title());
  check('the search box is labelled "Search clinic by name or location"', (await v.getByLabel('Search clinic by name or location', { exact: true }).count()) === 1);
  check('nothing is listed until an owner opts in', await see(v, 'No clinics are listed yet'));
  check('no clinic name shows even though three clinics exist', !(await bodyText(v)).includes(NAME_A));

  // ------------------------------------------------------------------ the owner lists the clinic
  await o.goto(`${BASE}/settings`);
  check('the listing card is on the owner settings page', await see(o, 'Home page listing and booking security'));
  const card = o.locator('section', { hasText: 'Home page listing and booking security' });
  await card.getByRole('switch', { name: /List my clinic on the home page/ }).check();
  // Registration may have saved a city already; the rule is about a clinic with neither a city nor an address.
  await card.getByLabel('City or town', { exact: true }).fill('');
  await card.getByLabel('Address (optional)', { exact: true }).fill('');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  check('listing without a city or address is refused with a clear message', await see(o, 'Add a city or an address so patients can find you'));
  check('nothing was listed by the refused save', (await sql('select public_listing from public.clinics where id = $1', [idOf(SLUG_A)]))[0].public_listing === false);
  await card.getByLabel('City or town', { exact: true }).fill('Pune');
  await card.getByLabel('Address (optional)', { exact: true }).fill('12 MG Road, Camp');
  await card.getByLabel('Public phone number (optional)', { exact: true }).fill('call me maybe');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  check('a bad public phone number is refused', await see(o, 'Enter a phone number with digits only'));
  await card.getByLabel('Public phone number (optional)', { exact: true }).fill('+91 20 5550 1234');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  check('the owner lists the clinic', await see(o, 'Your clinic is listed on the home page'));
  const listed = (await sql('select public_listing, city, address, public_phone from public.clinics where id = $1', [idOf(SLUG_A)]))[0];
  check('the database holds what the owner typed', listed.public_listing === true && listed.city === 'Pune' && listed.address === '12 MG Road, Camp' && listed.public_phone === '+91 20 5550 1234', JSON.stringify(listed));
  const audit = await sql(`select count(*)::int n from public.audit_log where clinic_id = $1 and action = 'clinic.public_settings'`, [idOf(SLUG_A)]);
  check('the change is in the audit log', audit[0].n >= 1);
  // The second clinic is listed by the same screen, quickly; the third stays private.
  await ob.goto(`${BASE}/settings`);
  const cardB = ob.locator('section', { hasText: 'Home page listing and booking security' });
  await cardB.getByRole('switch', { name: /List my clinic on the home page/ }).check();
  await cardB.getByLabel('City or town', { exact: true }).fill('Mumbai');
  await cardB.getByLabel('Address (optional)', { exact: true }).fill('5 Marine Drive');
  await cardB.getByRole('button', { name: 'Save', exact: true }).click();
  check('the second owner lists their clinic with no public phone', await see(ob, 'Your clinic is listed on the home page'));

  // ------------------------------------------------------------------ the directory
  await v.goto(`${BASE}/`);
  await see(v, NAME_A);
  const text = await bodyText(v);
  check('both listed clinics show, with their place', text.includes(NAME_A) && text.includes(NAME_B) && text.includes('12 MG Road, Camp, Pune') && text.includes('5 Marine Drive, Mumbai'), text.slice(0, 600));
  check('the clinic that did not opt in is not shown', !text.includes(NAME_C) && !text.includes('Dr Uma Quiet'));
  check('doctors show with their speciality and OPD', text.includes('Dr Meera Skin') && text.includes('Dermatologist') && text.includes('Skin OPD') && text.includes('Cardiologist'));
  check('today\'s availability and queue status show for a doctor', text.includes('tokens left') && /No tokens issued yet|Not started yet/.test(text));
  check('open clinics say they take bookings today', (await v.locator('.pill--open').count()) === 2);
  check('the public phone number shows as a call link', (await v.locator('a[href="tel:+912055501234"]').count()) === 1);
  check('a clinic with no public phone shows none', (await v.locator(`article:has-text("${NAME_B}") a[href^="tel:"]`).count()) === 0);
  check('no owner, staff or patient detail is on the page', !/example\.test|Asha Owner|Bela Owner|Chitra Owner|9000000077/.test(text));

  const search = v.getByLabel('Search clinic by name or location', { exact: true });
  await search.fill('mumbai');
  check('searching by place finds that clinic only', (await see(v, 'Showing 1 to 1 of 1 clinic')) && (await bodyText(v)).includes(NAME_B) && !(await bodyText(v)).includes(NAME_A));
  await search.fill('SUNRISE');
  check('searching by name ignores capital letters', (await see(v, NAME_A)) && !(await bodyText(v)).includes(NAME_B));
  await search.fill('x');
  check('one letter asks for at least two', await see(v, 'Type at least 2 letters to search.'));
  await search.fill('%%');
  check('symbols are plain text, not patterns', await see(v, 'No clinic matches your search.'));
  await search.fill("x'; drop table clinics; --");
  check('an injection attempt finds nothing and breaks nothing', (await see(v, 'No clinic matches your search.')) && (await sql('select count(*)::int n from public.clinics'))[0].n === 3);
  await v.getByRole('button', { name: 'Clear search and filters' }).click();
  check('clearing brings every listed clinic back', (await see(v, NAME_B)) && (await bodyText(v)).includes(NAME_A));

  const spec = v.getByLabel('Specialisation', { exact: true });
  const options = await spec.locator('option').allInnerTexts();
  check('the specialisation list has only specialities of listed clinics, each once', JSON.stringify(options) === JSON.stringify(['All specialisations', 'Cardiologist', 'Dermatologist']), JSON.stringify(options));
  await spec.selectOption('Cardiologist');
  check('filtering by specialisation shows that clinic only', (await see(v, 'Showing 1 to 1 of 1 clinic')) && (await bodyText(v)).includes(NAME_B));
  await spec.selectOption('');
  await v.getByLabel('Doctor name', { exact: true }).fill('meera');
  await see(v, 'Showing 1 to 1 of 1 clinic');
  const t2 = await bodyText(v);
  check('filtering by doctor name shows that doctor, not the clinic\'s other doctor', t2.includes('Dr Meera Skin') && !t2.includes('Dr Ravi Hair'));
  await v.getByRole('button', { name: 'Clear search and filters' }).click();

  const bookLink = v.locator(`article:has-text("${NAME_A}") a:has-text("Book appointment")`).first();
  check('each doctor has a Book appointment link into the clinic\'s own page', (await bookLink.getAttribute('href')).startsWith(`/c/${SLUG_A}/book?doctor=`), await bookLink.getAttribute('href'));
  await see(v, 'Dr Ravi Hair');
  check('and a Live queue link', (await v.locator(`article:has-text("${NAME_A}") a[href^="/c/${SLUG_A}/queue?doctor="]`).count()) === 2);

  // ------------------------------------------------------------------ booking, the clinic does not ask for a code
  const P1 = { name: 'Alpha Patient', phone: '9811100011', email: `alpha-${RUN}@example.test` };
  const P2 = { name: 'Beta Patient', phone: '9811100012', email: `beta-${RUN}@example.test` };
  const P3 = { name: 'Gamma Patient', phone: '9811100013' };
  const P4 = { name: 'Delta Patient', phone: '9811100014', email: `delta-${RUN}@example.test` };
  const P5 = { name: 'Epsilon Patient', phone: '9811100015' };

  await bookLink.click();
  await v.waitForURL(`**/c/${SLUG_A}/book?doctor=*`);
  check('the link lands on the clinic\'s own booking page with that doctor chosen', await see(v, 'Choose a doctor or OPD'));
  const chosen = await v.locator('input[name="doctor"]:checked').evaluate((el) => el.value);
  check('the right doctor is preselected', chosen === doc('Dr Meera Skin').id || chosen === doc('Dr Ravi Hair').id, chosen);
  await v.goto(`${BASE}/c/${SLUG_A}/book?doctor=${doc('Dr Meera Skin').id}`);
  await see(v, 'Choose a doctor or OPD');
  check('the form now has an optional email box', (await v.getByLabel('Email address (optional)', { exact: true }).count()) === 1);
  await fillBooking(v, P3);
  await v.getByRole('button', { name: 'Book Token' }).click();
  check('a clinic that does not ask for a code books straight away', await see(v, 'Token booked'));
  check('no email notice appears when no email was given', !(await bodyText(v)).includes('We emailed'));
  check('and nothing was emailed', (await mails()).length === 0);

  // ------------------------------------------------------------------ the owner turns the code on
  await o.goto(`${BASE}/settings`);
  await see(o, 'Home page listing and booking security');
  await card.getByRole('switch', { name: /Ask patients to verify with a code/ }).check();
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  check('the owner switches code verification on', await see(o, 'Your clinic is listed on the home page'));
  check('the database holds it', (await sql('select require_phone_otp from public.clinic_settings where clinic_id = $1', [idOf(SLUG_A)]))[0].require_phone_otp === true);

  // The directory is a public question, the text message provider can fail: nothing may be claimed as sent.
  await shim('/__shim/sms-mode', { mode: 'fail' });
  const meeraUrl = `${BASE}/c/${SLUG_A}/book?doctor=${doc('Dr Meera Skin').id}`;
  await v.goto(meeraUrl);
  await see(v, 'Choose a doctor or OPD');
  await fillBooking(v, P1);
  await v.getByRole('button', { name: 'Book Token' }).click();
  check('this clinic now asks the patient to verify first', await see(v, 'Verify before booking'));
  check('no booking was made yet', (await sql(`select count(*)::int n from public.queue_tokens t join public.patients p on p.id = t.patient_id where p.phone = $1`, [P1.phone]))[0].n === 0);
  await v.getByRole('radio', { name: /Text message to my mobile/ }).waitFor({ timeout: 8000 }).catch(() => undefined); // the page first asks which ways a code can be sent
  check('both a text message and an email are offered', (await v.getByRole('radio', { name: /Text message to my mobile/ }).count()) === 1 && (await v.getByRole('radio', { name: /^Email/ }).count()) === 1);
  check('the page says an email code does not prove the mobile number', await see(v, 'It does not prove the mobile number'));
  await v.getByRole('button', { name: 'Send code by text message' }).click();
  check('when the text message provider refuses, the page says no code was sent', await see(v, 'We could not send the text message. No code was sent.'));
  check('and no message reached the fake phone', (await shim('/__shim/sms')).length === 0);
  check('and the unsent code does not stay in the database', (await sql(`select count(*)::int n from public.booking_verifications where phone = $1`, [P1.phone]))[0].n === 0);

  // ------------------------------------------------------------------ booking with a text message code
  await shim('/__shim/sms-mode', { mode: 'ok' });
  await v.getByRole('button', { name: 'Send code by text message' }).click();
  check('with the provider working, the page says the code was sent and where', await see(v, 'We sent a 6 digit code by text message to XXXXXX0011'));
  const code1 = await lastCode(P1.phone);
  check('the fake phone received one message with a 6 digit code', Boolean(code1));
  await v.getByLabel('6 digit code', { exact: true }).fill(code1 === '000000' ? '111111' : '000000');
  await v.getByRole('button', { name: 'Verify' }).click();
  check('a wrong code is refused and says how many tries are left', await see(v, 'That code is not correct. You have 4 tries left.'));
  check('and nothing was booked', (await sql(`select count(*)::int n from public.queue_tokens t join public.patients p on p.id = t.patient_id where p.phone = $1`, [P1.phone]))[0].n === 0);
  const rowsBefore = await sql(`select code_hash, phone, channel from public.booking_verifications where phone = $1`, [P1.phone]);
  check('only a hash of the code is stored, never the code', rowsBefore.length === 1 && rowsBefore[0].code_hash && !rowsBefore[0].code_hash.includes(code1) && /^[0-9a-f]{64}$/.test(rowsBefore[0].code_hash), JSON.stringify(rowsBefore));
  await v.getByLabel('6 digit code', { exact: true }).fill(code1);
  await v.getByRole('button', { name: 'Verify' }).click();
  check('the right code books the token at once', await see(v, 'Token booked'));
  const key1 = v.url().split('/token/')[1];
  check('the patient lands on their token page', /^[0-9a-f-]{36}$/.test(key1 ?? ''), v.url());
  check('the page says the confirmation email was sent', await see(v, 'We emailed your booking confirmation'));
  const m1 = await mails(P1.email);
  check('exactly one email reached the fake inbox, addressed to the patient', m1.length === 1, JSON.stringify(m1.map((m) => m.subject)));
  const mail1 = m1[0] ?? { subject: '', text: '', html: '' };
  const tok1 = (await sql(`select token_number n from public.queue_tokens t join public.patients p on p.id = t.patient_id where p.phone = $1`, [P1.phone]))[0].n;
  check('it is the queue token mail with the token number', mail1.subject === `You are in the queue: token ${tok1}`, mail1.subject);
  check('it names the clinic and the doctor, and links to the live queue on the site', mail1.text.includes(NAME_A) && mail1.text.includes('Dr Meera Skin') && mail1.text.includes(`http://localhost:4174/c/${SLUG_A}/queue/${key1}`), mail1.text.slice(0, 500));
  check('it never contains the phone number, a code or a password', !/9811100011|\b\d{6}\b.*verification|password/i.test(mail1.text + mail1.html));
  check('the mail is branded Apna Clinic', /Apna Clinic/.test(mail1.html));

  // The same patient can ask for the confirmation to be sent again only once: the provider-side key makes it idempotent.
  const again = await (await fetch(`${SHIM}/functions/v1/booking-public`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'notify_booking', access_key: key1 }) })).json();
  check('asking for the confirmation again does not send a second email', again.ok === true && (await mails(P1.email)).length === 1, JSON.stringify(again));

  // ------------------------------------------------------------------ cancellation
  await v.getByRole('button', { name: 'Cancel this token' }).click();
  await v.getByRole('dialog').getByRole('button', { name: 'Cancel token' }).click();
  check('the patient cancels their token', await see(v, `was cancelled`));
  check('the page says the cancellation notice was emailed', await see(v, 'We emailed you a cancellation notice'));
  const cancelMails = (await mails(P1.email)).filter((m) => m.subject === 'Your appointment was cancelled');
  check('exactly one cancellation email reached the inbox, with a Book again link', cancelMails.length === 1 && cancelMails[0].text.includes(`http://localhost:4174/c/${SLUG_A}/book`), JSON.stringify(cancelMails.map((m) => m.subject)));

  // ------------------------------------------------------------------ email code, when text messages are not set up
  await shim('/__shim/sms-mode', { mode: 'off' });
  await v.goto(meeraUrl);
  await see(v, 'Choose a doctor or OPD');
  await fillBooking(v, P2);
  await v.getByRole('button', { name: 'Book Token' }).click();
  await see(v, 'Verify before booking');
  const emailOnly = await v.getByRole('button', { name: 'Send code by email' }).waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
  check('with no text message provider, only the email way is offered', emailOnly && (await v.getByRole('radio', { name: /Text message/ }).count()) === 0 && (await v.getByRole('radio', { name: /^Email/ }).count()) === 0 && (await v.getByRole('button', { name: 'Send code by text message' }).count()) === 0);
  await v.getByLabel('Email address', { exact: true }).last().fill(P2.email);
  await v.getByRole('button', { name: 'Send code by email' }).click();
  check('the page says the code was emailed, with the address partly hidden', await see(v, 'by email to b***@example.test'));
  const codeMail = (await mails(P2.email)).find((m) => m.subject === 'Your Apna Clinic verification code');
  const code2 = codeMail && /\b(\d{6})\b/.exec(codeMail.text)?.[1];
  check('the verification email arrived and carries a 6 digit code', Boolean(code2));
  await v.getByLabel('6 digit code', { exact: true }).fill(code2);
  await v.getByRole('button', { name: 'Verify' }).click();
  check('an emailed code books the token', await see(v, 'Token booked'));
  check('the confirmation email follows', (await mails(P2.email)).some((m) => m.subject.startsWith('You are in the queue')));
  const chan = (await sql(`select channel from public.booking_verifications where phone = $1 and verified_at is not null`, [P2.phone]))[0];
  check('the database knows this check was by email', chan?.channel === 'email');

  // ------------------------------------------------------------------ an email that cannot be sent is reported as such
  await shim('/__shim/sms-mode', { mode: 'ok' });
  await shim('/__shim/email-mode', { mode: 'fail' });
  await v.goto(meeraUrl);
  await see(v, 'Choose a doctor or OPD');
  await fillBooking(v, P4);
  await v.getByRole('button', { name: 'Book Token' }).click();
  await see(v, 'Verify before booking');
  await v.getByRole('button', { name: 'Send code by text message' }).click();
  await see(v, 'We sent a 6 digit code by text message');
  await v.getByLabel('6 digit code', { exact: true }).fill(await lastCode(P4.phone));
  await v.getByRole('button', { name: 'Verify' }).click();
  check('the booking still succeeds when the email provider refuses', await see(v, 'Token booked'));
  const failedText = await bodyText(v);
  check('and the page says plainly that no email was sent', failedText.includes('We could not send the email. No email was sent.') && !failedText.includes('We emailed your booking confirmation'), failedText.slice(0, 500));
  check('the provider\'s own wording is not shown to the patient', !failedText.includes('mail.shim.test') && !failedText.includes('not verified'));
  const evt = await sql(`select status, error from public.email_events where template in ('queue_token_confirmation', 'appointment_confirmation') order by created_at desc limit 1`);
  check('the failure is recorded for the clinic', evt[0]?.status === 'failed', JSON.stringify(evt));
  await shim('/__shim/email-mode', { mode: 'ok' });

  // ------------------------------------------------------------------ limits on codes
  const hit = async (body, ip) => fetch(`${SHIM}/functions/v1/booking-public`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });
  const spamPhone = '9811100077';
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await hit({ action: 'otp_request', phone: spamPhone, channel: 'sms' }, '198.51.100.7');
    statuses.push(r.status);
    if (i === 3) {
      const body = await r.json();
      check('a fourth code request for one number in 10 minutes is refused with a clear message', r.status === 429 && /wait about 10 minutes/.test(body.message), JSON.stringify(body));
      check('the refused answer carries no code', !/\b\d{6}\b/.test(JSON.stringify(body)));
    }
  }
  check('the first three were accepted', statuses.slice(0, 3).every((s) => s === 200), statuses.join(','));
  check('exactly three messages went to that number', (await shim('/__shim/sms')).filter((m) => m.to === `+91${spamPhone}`).length === 3);
  const junk = await hit({ action: 'otp_verify', challenge_id: 'nope', code: '123456' }, '198.51.100.8');
  check('a made up verification id is refused', junk.status === 400);
  const wrongKind = await hit({ action: 'drop_everything' }, '198.51.100.8');
  check('an unknown request is refused', wrongKind.status === 400);

  // ------------------------------------------------------------------ live queue
  const meera = doc('Dr Meera Skin');
  const ravi = doc('Dr Ravi Hair');
  // Put the queue in motion the way the doctor's screen would. (Doctor screens are covered by the earlier suites; this
  // script sets the state directly so it can look at what a visitor sees.)
  await sql(`update public.queue_tokens set status = 'serving', arrived_at = now() where id = (select id from public.queue_tokens where doctor_id = $1 and status = 'waiting' order by token_number limit 1)`, [meera.id]);
  const board = (await sql(`select count(*) filter (where status = 'waiting')::int w, max(token_number) filter (where status = 'serving') cur from public.queue_tokens where doctor_id = $1 and queue_date = private.today($2)`, [meera.id, idOf(SLUG_A)]))[0];
  // A patient with no token on this device (a token on the device would show their own token instead of the board).
  const stranger = await newContext('stranger', { watch: true });
  const s = await stranger.newPage();
  await s.goto(`${BASE}/c/${SLUG_A}/queue?doctor=${meera.id}`);
  check('the live queue names the doctor and the speciality', await see(s, 'Skin OPD, Dr Meera Skin · Dermatologist'));
  check('it shows the token being served', (await see(s, 'Now serving')) && (await s.locator('.token-hero__number').first().innerText()).includes(String(board.cur)), String(board.cur));
  const q = await bodyText(s);
  check('it shows the number waiting, matching the database', (await s.locator('.queue-stats div', { hasText: 'Waiting' }).locator('dd').innerText()).trim() === String(board.w), String(board.w));
  check('it says the doctor is with a patient', q.includes('With a patient'));
  check('the wait for a new booking is marked as an estimate', /Wait if you book now[\s\S]*\(estimate\)/.test(q) && q.includes('are guesses'));
  check('it shows when the page was last updated and that it re-checks', q.includes('Last updated') && q.includes('checked every 10 seconds'));
  check('it shows no patient names or phone numbers', !/Alpha|Beta|Gamma|Delta|Epsilon|98111000\d\d/.test(q));

  // Leave: the doctor is away today. The owner's private reason must not reach the public.
  await sql(`insert into public.doctor_schedule_exceptions (clinic_id, doctor_id, kind, start_date, end_date, sessions, reason) values ($1, $2, 'closed', private.today($1), private.today($1), '[]'::jsonb, 'Private note ZEBRA')`, [idOf(SLUG_A), ravi.id]);
  await s.goto(`${BASE}/c/${SLUG_A}/queue?doctor=${ravi.id}`);
  check('a doctor on leave shows the queue as closed', await see(s, 'is not available') || await see(s, 'closed'), (await bodyText(s)).slice(0, 400));
  check('the closed queue offers another day', await see(s, 'You can still book a token for another day'));
  check('the owner\'s private note is not shown', !(await bodyText(s)).includes('ZEBRA'));
  await v.goto(`${BASE}/`);
  await see(v, NAME_A);
  const dirText = await bodyText(v);
  check('the directory card says that doctor is not available today', /Dr Ravi Hair[\s\S]*Doctor not available/.test(dirText));
  check('and the private note is not in the directory either', !dirText.includes('ZEBRA'));

  // ------------------------------------------------------------------ check my place (text message code only)
  await s.goto(`${BASE}/c/${SLUG_A}/queue?doctor=${meera.id}`);
  await see(s, 'Already booked?');
  await shim('/__shim/sms-mode', { mode: 'off' });
  await s.getByRole('button', { name: 'Check my place in the queue' }).click();
  check('with no text message provider, "check my place" says so honestly and sends nothing', await see(s, 'Codes cannot be sent right now') && (await see(s, 'No code was sent', 2000) || (await bodyText(s)).includes('text messages are not available')));
  await shim('/__shim/sms-mode', { mode: 'ok' });
  await s.goto(`${BASE}/c/${SLUG_A}/queue?doctor=${meera.id}`);
  await see(s, 'Already booked?');
  await s.getByRole('button', { name: 'Check my place in the queue' }).click();
  await see(s, 'Check your place in the queue');
  check('only the text message way is offered', (await s.getByRole('radio').count()) === 0);
  await fillLabel(s, 'Mobile number', P4.phone);
  await s.getByRole('button', { name: 'Send code by text message' }).click();
  await see(s, 'We sent a 6 digit code by text message');
  await s.getByLabel('6 digit code', { exact: true }).fill(await lastCode(P4.phone));
  await s.getByRole('button', { name: 'Verify' }).click();
  check('after the code, the patient sees their own place', await see(s, 'Your place today'));
  await see(s, 'Patients ahead');
  const place = await bodyText(s);
  const tok4 = (await sql(`select token_number n, status from public.queue_tokens t join public.patients p on p.id = t.patient_id where p.phone = $1`, [P4.phone]))[0];
  check('it shows their token number and where they stand', place.includes('Patients ahead') && place.includes(`#${tok4.n}`) || place.includes(String(tok4.n)), place.slice(0, 600));
  check('the estimate is marked as an estimate', place.includes('(estimate)'));
  check('it shows no name, phone number, or anyone else', !/Delta Patient|Alpha Patient|Beta Patient|Gamma Patient|98111000\d\d/.test(place));
  // A number with no token here sees nothing, not an error that hints at who is booked.
  await s.getByRole('button', { name: 'Done' }).click();
  await s.getByRole('button', { name: 'Check my place in the queue' }).click();
  await fillLabel(s, 'Mobile number', P5.phone);
  await s.getByRole('button', { name: 'Send code by text message' }).click();
  await see(s, 'We sent a 6 digit code by text message');
  await s.getByLabel('6 digit code', { exact: true }).fill(await lastCode(P5.phone));
  await s.getByRole('button', { name: 'Verify' }).click();
  check('a verified number with no token here sees a plain "no token" message', await see(s, 'No token found for this number with this doctor today'));
  check('a code for another number does not show someone else\'s token', !(await bodyText(s)).includes(`#${tok4.n}`) || tok4.n === undefined);

  // ------------------------------------------------------------------ nothing private reached any visitor
  const allBodies = publicBodies.map((b) => b.text).join('\n');
  const visited = (re) => publicBodies.filter((b) => re.test(b.url)).map((b) => b.text).join('\n');
  const listText = visited(/directory_search|directory_filters|get_public_queue|get_my_position|get_public_clinic/);
  check('the visitors made public directory and queue requests', listText.length > 500, String(listText.length));
  check('no public answer contains an owner or patient email, a patient phone number or a patient name',
    !/example\.test|9811100\d\d|Alpha Patient|Beta Patient|Gamma Patient|Delta Patient|Epsilon Patient|Asha Owner/.test(listText), listText.match(/example\.test|9811100\d\d|Alpha Patient|Delta Patient/)?.[0] ?? '');
  check('no public list or queue answer carries an access key', !/access_key/.test(listText));
  check('the private leave note never reached a visitor', !allBodies.includes('ZEBRA'));
  check('no verification code is in any answer a visitor received (only the phone had it)', !/"code"\s*:\s*"?\d{6}/.test(allBodies) && !publicBodies.some((b) => /otp_request/.test(b.text) && /\b\d{6}\b/.test(b.text.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ''))));
  check('no console errors or warnings in any browser window', problems.length === 0, problems.slice(0, 5).join(' | '));

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log('Failed:', failed.map((f) => f.name).join('; ')); process.exit(1); }
}

main().catch(async (error) => {
  console.error(error);
  await browser?.close().catch(() => {});
  process.exit(1);
});
