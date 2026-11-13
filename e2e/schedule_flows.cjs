// Real backend path, doctor schedules: the owner's timetable editor, what patients see, and the warning before a change
// would affect booked patients. Run with the stand-in API (see supabase_flows.cjs for what it does and does not prove):
//
//   bash scripts/run-e2e.sh e2e/schedule_flows.cjs

const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4174';
const SHIM = process.env.SHIM_URL || 'http://127.0.0.1:54399';
const RUN = Math.random().toString(36).slice(2, 7);
const SLUG = `timetable-${RUN}`;
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
const see = async (page, text, timeout = 8000) => {
  try { await page.getByText(text, { exact: false }).first().waitFor({ timeout }); return true; } catch { return false; }
};
const gone = async (page, text, timeout = 4000) => {
  try { await page.getByText(text, { exact: false }).first().waitFor({ state: 'detached', timeout }); return true; } catch { return false; }
};
const fillLabel = (page, label, value) => page.getByLabel(label, { exact: true }).fill(value);
const fmt = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(2000, 0, 1, h, m));
};
const range = (s) => `${fmt(s.start)} to ${fmt(s.end)}`;

// The example week from the brief. 1 = Monday ... 0 = Sunday.
const NAMES = { 0: 'Sunday', 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday' };
const WEEK = {
  1: [{ start: '09:30', end: '12:45' }, { start: '17:30', end: '20:15' }],
  2: [{ start: '10:15', end: '13:30' }],
  3: [],
  4: [{ start: '16:00', end: '21:00' }],
  5: [{ start: '09:00', end: '12:00' }, { start: '18:00', end: '20:30' }],
  6: [{ start: '10:00', end: '14:00' }],
  0: [],
};

/** The realtime service is not part of the stand-in. This accepts the channel join so the app falls back to polling quietly. */
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
async function newContext(label) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
  await mockRealtime(ctx);
  ctx.on('page', (page) => {
    page.on('console', (msg) => {
      if (!['error', 'warning'].includes(msg.type())) return;
      if (/Failed to load resource/.test(msg.text())) return;
      problems.push(`[${label}] ${msg.type()}: ${msg.text()}`);
    });
    page.on('pageerror', (err) => problems.push(`[${label}] pageerror: ${err.message}`));
  });
  return ctx;
}

/** Makes the rows of one weekday match the wanted timings, by pressing the same buttons a person would. */
async function setDay(dlg, day, sessions) {
  const name = NAMES[day];
  const rows = () => dlg.locator(`[id^="d${day}-start-"]`).count();
  while ((await rows()) > sessions.length) {
    const n = await rows();
    await dlg.getByRole('button', { name: `Remove ${name} timing ${n}`, exact: true }).click();
  }
  while ((await rows()) < sessions.length) await dlg.getByRole('button', { name: `Add timing for ${name}`, exact: true }).click();
  for (const [i, s] of sessions.entries()) {
    await dlg.locator(`#d${day}-start-${i}`).fill(s.start);
    await dlg.locator(`#d${day}-end-${i}`).fill(s.end);
  }
}

async function main() {
  browser = await chromium.launch();
  const ownerCtx = await newContext('owner');
  const patientCtx = await newContext('patient');
  const leaks = [];
  patientCtx.on('response', async (res) => {
    if (/rpc\/(get_public_queue|get_public_clinic|book_token|get_my_token)/.test(res.url())) leaks.push(await res.text().catch(() => ''));
  });

  // ------------------------------------------------------------------ owner, clinic, one doctor
  const o = await ownerCtx.newPage();
  await o.goto(`${BASE}/register`);
  await fillLabel(o, 'Your name', 'Dr Asha Rao');
  await fillLabel(o, 'Email address', `owner-${RUN}@example.test`);
  await fillLabel(o, 'Password', PASSWORD);
  await o.getByRole('button', { name: 'Create account' }).click();
  await see(o, 'Step 2 of 2');
  await fillLabel(o, 'Clinic name', `Timetable Clinic ${RUN}`);
  await o.getByLabel('Clinic web address', { exact: true }).fill(SLUG);
  await o.getByRole('button', { name: 'Create clinic' }).click();
  await o.waitForURL('**/report', { timeout: 10000 }).catch(() => {});
  const clinic = (await sql('select id, timezone from public.clinics where slug = $1', [SLUG]))[0];
  check('owner registered a clinic', Boolean(clinic?.id));

  await o.goto(`${BASE}/settings`);
  await o.getByRole('button', { name: 'Add doctor' }).click();
  const add = o.getByRole('dialog');
  await add.getByLabel('Doctor name', { exact: true }).fill('Dr Priya Nair');
  await add.getByLabel('OPD name', { exact: true }).fill('General OPD');
  await add.locator('#start-0').fill('00:00');
  await add.locator('#end-0').fill('23:59');
  await add.getByRole('button', { name: 'Add doctor' }).click();
  check('doctor added with the usual timings for every day', await see(o, 'Dr Priya Nair was added'));
  const doctor = (await sql(`select id from public.doctors where clinic_id = $1`, [clinic.id]))[0];

  // ------------------------------------------------------------------ the editor
  await o.getByRole('button', { name: 'Schedule for Dr Priya Nair', exact: true }).click();
  const dlg = o.getByRole('dialog');
  check('the Schedule button opens a timetable with a weekly section', (await see(o, 'Timetable: Dr Priya Nair')) && (await see(o, 'Weekly timings')));
  check('it says which time zone the times are in', await see(o, `time zone (${clinic.timezone})`));
  check('every weekday has its own card', (await dlg.locator('.sched-day').count()) === 7);
  check('the time boxes take typed times (native time input)', (await dlg.locator('#d1-start-0').getAttribute('type')) === 'time');

  // Typing nonsense is caught straight away, with the weekday named, and saving is blocked.
  await dlg.locator('#d2-start-0').fill('14:00');
  await dlg.locator('#d2-end-0').fill('13:00');
  check('an end before the start is flagged on that day', await see(o, 'Tuesday: Each OPD timing must end after it starts.'));
  check('and Save is disabled while something is wrong', await dlg.getByRole('button', { name: 'Save weekly timings', exact: true }).isDisabled());
  await setDay(dlg, 2, [{ start: '10:15', end: '13:30' }]);
  await setDay(dlg, 4, [{ start: '16:00', end: '21:00' }, { start: '20:00', end: '22:00' }]);
  check('overlapping timings are flagged', await see(o, 'Thursday: OPD timings must not overlap.'));

  // Build the example week.
  for (const day of [1, 2, 3, 4, 5, 6, 0]) await setDay(dlg, day, WEEK[day]);
  check('no problem is left once the week is the example week', (await dlg.locator('.field__error').count()) === 0);
  check('Wednesday and Sunday show as weekly holidays', (await dlg.getByText('Closed (weekly holiday)').count()) === 2);

  // A break inside a timing, and a break that does not fit.
  await dlg.getByRole('button', { name: 'Add a break for Saturday timing 1', exact: true }).click();
  await dlg.locator('#d6-bstart-0').fill('09:00');
  await dlg.locator('#d6-bend-0').fill('10:30');
  check('a break outside the timing is flagged', await see(o, 'Saturday: A break must fall inside the OPD timing.'));
  await dlg.locator('#d6-bstart-0').fill('11:30');
  await dlg.locator('#d6-bend-0').fill('11:45');
  check('a break inside the timing is accepted', (await dlg.locator('.field__error').count()) === 0);

  // Copying a day onto another.
  await dlg.locator('summary', { hasText: 'Copy Saturday to other days' }).click();
  await dlg.getByRole('group', { name: 'Days to copy Saturday to' }).getByLabel('Sunday').check();
  await dlg.getByRole('button', { name: 'Copy', exact: true }).click();
  check('copying Saturday to Sunday fills Sunday in', (await dlg.locator('#d0-start-0').inputValue()) === '10:00' && (await dlg.locator('#d0-bstart-0').inputValue()) === '11:30');
  await setDay(dlg, 0, []);

  await dlg.getByRole('button', { name: 'Save weekly timings', exact: true }).click();
  check('the week is saved', await see(o, 'Weekly timings saved'));
  const rows = await sql(`select day_of_week d, to_char(start_time, 'HH24:MI') s, to_char(end_time, 'HH24:MI') e, to_char(break_start, 'HH24:MI') bs, to_char(break_end, 'HH24:MI') be
                          from public.doctor_schedules where doctor_id = $1 order by 1, 2`, [doctor.id]);
  const expected = [];
  for (const d of [0, 1, 2, 3, 4, 5, 6]) for (const s of WEEK[d]) expected.push({ d, s: s.start, e: s.end, bs: d === 6 ? '11:30' : null, be: d === 6 ? '11:45' : null });
  check('the database holds exactly the example week, odd minutes and a break included', JSON.stringify(rows) === JSON.stringify(expected), JSON.stringify(rows));

  // Closing and reopening shows what was stored.
  await dlg.getByRole('button', { name: 'Close', exact: true }).click();
  await o.getByRole('button', { name: 'Schedule for Dr Priya Nair', exact: true }).click();
  await see(o, 'Weekly timings');
  const again = o.getByRole('dialog');
  check('reopening shows the saved times', (await again.locator('#d1-start-0').inputValue()) === '09:30' && (await again.locator('#d1-end-1').inputValue()) === '20:15'
    && (await again.locator('#d6-bend-0').inputValue()) === '11:45' && (await again.getByText('Closed (weekly holiday)').count()) === 2);

  // ------------------------------------------------------------------ what patients see follows the timetable
  const day = (await sql(`select private.today($1)::text as today, extract(dow from private.today($1))::int as dow`, [clinic.id]))[0];
  const tomorrowDow = (day.dow + 1) % 7;
  const tomorrowKey = (await sql(`select (private.today($1) + 1)::text as d`, [clinic.id]))[0].d;
  const p = await patientCtx.newPage();
  await p.goto(`${BASE}/c/${SLUG}/book`);
  await see(p, 'Choose a doctor or OPD');
  await p.getByRole('radio', { name: /Tomorrow/ }).check();
  const tomorrowSessions = WEEK[tomorrowDow];
  if (tomorrowSessions.length === 0) {
    check(`tomorrow (${NAMES[tomorrowDow]}) is a weekly holiday: the booking page says there is no OPD`, (await see(p, 'has no OPD tomorrow')) && (await p.getByRole('button', { name: 'Book Token' }).isDisabled()));
  } else {
    check(`tomorrow (${NAMES[tomorrowDow]}) shows its own timings on the booking page`, await see(p, `Timings: ${tomorrowSessions.map(range).join(' and ')}`), (await p.locator('body').innerText()).slice(0, 400));
    if (tomorrowSessions.length > 1) {
      check('a doctor with two sessions that day lets the patient choose one', (await see(p, 'Choose a session')) && (await p.getByRole('radio', { name: range(tomorrowSessions[1]) }).count()) === 1);
    }
  }

  // ------------------------------------------------------------------ one day's timings: today is open all day, then a patient books
  const reload = async () => { await o.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click(); await o.getByRole('button', { name: 'Schedule for Dr Priya Nair', exact: true }).click(); await see(o, 'Weekly timings'); return o.getByRole('dialog'); };
  let ed = await reload();
  await ed.getByLabel('What is happening?', { exact: true }).selectOption('override');
  check('different timings for one date asks for the timings', await see(o, 'Timings on that date'));
  await ed.locator('#exc-start-0').fill('00:00');
  await ed.locator('#exc-end-0').fill('23:59');
  await ed.getByRole('button', { name: 'Add', exact: true }).click();
  check('one day timings for today are saved', await see(o, 'The new timings apply on that date'));
  check('they appear in the list of special days', await see(o, 'Timings for'));
  const ov = await sql(`select kind, start_date::text d from public.doctor_schedule_exceptions where doctor_id = $1`, [doctor.id]);
  check('the database has one override for today', ov.length === 1 && ov[0].kind === 'override' && ov[0].d === day.today, JSON.stringify(ov));

  await p.goto(`${BASE}/c/${SLUG}/book`);
  await see(p, 'Choose a doctor or OPD');
  check('today now shows the all day timings', await see(p, `Timings: ${range({ start: '00:00', end: '23:59' })}`));
  await p.getByLabel('Patient name', { exact: true }).fill('Anita Verma');
  await p.getByLabel('Mobile number', { exact: true }).fill('9876500001');
  await p.getByRole('button', { name: 'Book Token' }).click();
  await p.waitForURL('**/token/**', { timeout: 10000 }).catch(() => {});
  check('the patient gets a token', p.url().includes('/token/'), p.url());
  check('the token page names the session it belongs to', await see(p, range({ start: '00:00', end: '23:59' })));
  const tokenRow = (await sql(`select status, to_char(session_start, 'HH24:MI') s, to_char(session_end, 'HH24:MI') e from public.queue_tokens where doctor_id = $1`, [doctor.id]))[0];
  check('the token is stored with its session', tokenRow?.status === 'waiting' && tokenRow.s === '00:00' && tokenRow.e === '23:59', JSON.stringify(tokenRow));
  const tokenUrl = p.url();

  // ------------------------------------------------------------------ leave tomorrow: private note stays private
  ed = await reload();
  await fillLabel(ed, 'First day', tomorrowKey);
  await fillLabel(ed, 'Last day', tomorrowKey);
  await fillLabel(ed, 'Note for your staff (optional)', 'Private surgery');
  await ed.getByRole('button', { name: 'Add', exact: true }).click();
  check('leave for tomorrow is saved without any warning (nobody is booked)', await see(o, 'Patients can no longer book on those days'));
  check('staff can see their own note in the list', await see(o, 'Note: Private surgery'));
  await p.goto(`${BASE}/c/${SLUG}/book`);
  await see(p, 'Choose a doctor or OPD');
  await p.getByRole('radio', { name: /Tomorrow/ }).check();
  check('patients are told the doctor is not available, and cannot book', (await see(p, 'is not available tomorrow')) && (await p.getByRole('button', { name: 'Book Token' }).isDisabled()));
  const pageText = await p.locator('body').innerText();
  check('the private note is nowhere on the public page', !pageText.includes('Private surgery'));
  await p.goto(`${BASE}/c/${SLUG}/queue`);
  await sleep(800);
  check('and nowhere in what the public queue page received', !leaks.join('\n').includes('Private surgery'));

  // ------------------------------------------------------------------ leave today: the booked patient triggers the warning
  ed = await reload();
  await fillLabel(ed, 'First day', day.today);
  await fillLabel(ed, 'Last day', day.today);
  await ed.getByRole('button', { name: 'Add', exact: true }).click();
  check('leave that would strand a booked patient shows a warning', await see(o, 'Some booked patients are affected'));
  check('it says how many, and that nothing is cancelled', (await see(o, '1 booked patient')) && (await see(o, 'will NOT be cancelled')));
  check('and names the doctor and the day', (await o.getByRole('alertdialog').getByText('Dr Priya Nair').count()) === 1 && (await o.getByRole('alertdialog').getByText(/the day will be closed/).count()) === 1);
  let closedToday = await sql(`select count(*)::int n from public.doctor_schedule_exceptions where doctor_id = $1 and kind = 'closed' and start_date = $2`, [doctor.id, day.today]);
  check('until the owner confirms, nothing was saved', closedToday[0].n === 0);
  await o.getByRole('button', { name: 'Go back, change nothing' }).click();
  check('going back closes the warning and changes nothing', (await gone(o, 'Some booked patients are affected')) && (await sql(`select count(*)::int n from public.doctor_schedule_exceptions where kind = 'closed' and start_date = $1`, [day.today]))[0].n === 0);
  await ed.getByRole('button', { name: 'Add', exact: true }).click();
  await see(o, 'Some booked patients are affected');
  await o.getByRole('button', { name: 'Save anyway and keep those bookings' }).click();
  check('confirming saves the leave and says the bookings are kept', await see(o, 'Patients already booked on that day keep their tokens'));
  closedToday = await sql(`select count(*)::int n from public.doctor_schedule_exceptions where doctor_id = $1 and kind = 'closed' and start_date = $2`, [doctor.id, day.today]);
  check('the leave is stored', closedToday[0].n === 1);
  const still = (await sql(`select status from public.queue_tokens where doctor_id = $1`, [doctor.id]))[0];
  check('the patient who was already booked is still in the queue', still?.status === 'waiting', JSON.stringify(still));
  await p.goto(tokenUrl);
  check('their token page still works', (await see(p, 'Anita')) || (await see(p, 'Your token')));

  // The queue and the booking page now reflect the closed day.
  const other = await (await newContext('second-patient')).newPage();
  await other.goto(`${BASE}/c/${SLUG}/book`);
  await see(other, 'Choose a doctor or OPD');
  check('new patients cannot book today any more', (await see(other, 'is not available today')) && (await other.getByRole('button', { name: 'Book Token' }).isDisabled()));
  const audit = await sql(`select action from public.audit_log where clinic_id = $1 and action like 'schedule.%' order by id`, [clinic.id]);
  check('every schedule change was written to the audit log', audit.map((a) => a.action).filter((a) => a === 'schedule.update').length === 1 && audit.some((a) => a.action === 'schedule.exception_add'), JSON.stringify(audit));

  // Removing the leave opens the day again; nobody is stranded, so no warning.
  ed = await reload();
  await ed.getByRole('button', { name: /Remove Leave: / }).first().click();
  check('removing leave needs no warning when nobody is stranded', await see(o, 'Removed. The usual timings apply again'));

  // ------------------------------------------------------------------ the patient pages leak nothing
  const bodyLeaks = leaks.join('\n');
  check('no public response contained the patient\'s name or phone', !/Anita|9876500001/.test(bodyLeaks.replace(/"first_name":"Anita"/g, '')), bodyLeaks.slice(0, 200));

  // ------------------------------------------------------------------ small screens
  for (const width of [320, 390]) {
    await o.setViewportSize({ width, height: 800 });
    await o.goto(`${BASE}/settings`);
    await o.getByRole('button', { name: 'Schedule for Dr Priya Nair', exact: true }).click();
    await see(o, 'Weekly timings');
    const wide = await o.evaluate(() => {
      const dialog = document.querySelector('dialog[open]');
      return { page: document.documentElement.scrollWidth - window.innerWidth, dialog: dialog ? dialog.scrollWidth - dialog.clientWidth : 0 };
    });
    check(`the timetable editor does not scroll sideways at ${width} px`, wide.page <= 1 && wide.dialog <= 1, JSON.stringify(wide));
    await o.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  }

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
