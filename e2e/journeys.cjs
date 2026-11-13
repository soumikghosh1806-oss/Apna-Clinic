// End to end checks for the clinic queue demo. Runs against the production build served on 127.0.0.1:4173.
// Each tab is a different role. Tabs in one browser context share localStorage, like tabs in a real browser.

const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
const results = [];
const consoleProblems = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function watch(page, label) {
  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) consoleProblems.push(`[${label}] ${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', (err) => consoleProblems.push(`[${label}] pageerror: ${err.message}`));
}

async function tokenNumberOn(page) {
  const label = await page.locator('.token-hero__number').first().getAttribute('aria-label');
  return Number((label || '').replace('Token ', ''));
}

async function loginAs(page, buttonName) {
  await page.goto(`${BASE}/login`);
  await page.getByRole('button', { name: buttonName }).click();
  await page.waitForLoadState('networkidle');
}

async function kpi(page, label) {
  const tile = page.locator('.kpi', { has: page.locator('.kpi__label', { hasText: label }) }).first();
  return (await tile.locator('.kpi__value').innerText()).trim();
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  // Start from a clean demo.
  const setup = await context.newPage();
  await setup.goto(`${BASE}/`);
  await setup.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await setup.reload();
  await setup.close();

  const patient = await context.newPage();
  const reception = await context.newPage();
  const doctor = await context.newPage();
  const tv = await context.newPage();
  const owner = await context.newPage();
  await Promise.all([watch(patient, 'patient'), watch(reception, 'reception'), watch(doctor, 'doctor'), watch(tv, 'tv'), watch(owner, 'owner')]);

  // ------------------------------------------------------------------ 1. Booking and confirmation
  await patient.goto(`${BASE}/book`);
  await patient.getByRole('button', { name: 'Book Token' }).click();
  const nameErr = await patient.locator('.field__error').allInnerTexts();
  check('J1 empty booking form shows both field errors', nameErr.length === 2, nameErr.join(' | '));
  check('J1 first invalid field receives focus', await patient.evaluate(() => document.activeElement?.getAttribute('name') === 'name'));

  await patient.getByLabel('Patient name').fill('Test Patient');
  await patient.getByLabel('Mobile number').fill('12345');
  await patient.getByRole('button', { name: 'Book Token' }).click();
  const phoneErr = await patient.locator('.field__error').allInnerTexts();
  check('J1 invalid phone number is rejected with a message', phoneErr.some((t) => /valid 10 digit/.test(t)), phoneErr.join(' | '));

  await patient.getByLabel('Mobile number').fill('98765 43210');
  const book = patient.getByRole('button', { name: 'Book Token' });
  await book.dblclick(); // two quick clicks must create one token only
  await patient.waitForURL(/\/token\//);
  const bookedNumber = await tokenNumberOn(patient);
  const bookedUrl = patient.url();
  check('J1 booking gives a confirmation with a token number', bookedNumber > 0, bookedNumber);
  check('J1 first online token for General OPD continues the seeded line (#18)', bookedNumber === 18, bookedNumber);
  const confirmText = await patient.locator('main').innerText();
  check('J1 confirmation shows OPD, date and an estimate label', /General OPD/.test(confirmText) && /Estimated time/.test(confirmText) && /estimate/.test(confirmText));
  check('J1 confirmation says no SMS was sent', /No SMS or WhatsApp message is sent/.test(confirmText));

  // A second booking attempt for the same person is refused, not duplicated.
  await patient.goto(`${BASE}/book`);
  await patient.getByLabel('Patient name').fill('Test Patient');
  await patient.getByLabel('Mobile number').fill('9876543210');
  await patient.getByRole('button', { name: 'Book Token' }).click();
  const dupText = await patient.locator('.notice--error').innerText();
  check('J1 duplicate booking is refused with the existing token number', /already exists.*#18/.test(dupText), dupText);

  // ------------------------------------------------------------------ 2. Reception list
  await loginAs(reception, 'Open as reception');
  check('J2 reception login lands on today\'s list', /\/reception$/.test(reception.url()), reception.url());
  const row = reception.locator('tbody tr', { hasText: 'Test Patient' });
  check('J2 booked token appears in the reception list', (await row.count()) === 1, await row.count());
  check('J2 the row shows token #18 as waiting and not arrived', /#18/.test(await row.innerText()) && /Waiting/.test(await row.innerText()) && /Not arrived/.test(await row.innerText()), await row.innerText());
  const totalBefore = Number(await kpi(reception, 'Tokens today'));
  check('J2 tokens today equals seeded 23 plus the booking', totalBefore === 24, totalBefore);

  // Search and filters.
  await reception.getByLabel('Search by name, phone or token').fill('#18');
  check('J2 search by token number finds one row', (await reception.locator('tbody tr').count()) === 1);
  await reception.getByLabel('Search by name, phone or token').fill('9876543210');
  check('J2 search by phone finds the booking', (await reception.locator('tbody tr', { hasText: 'Test Patient' }).count()) === 1);
  await reception.getByLabel('Search by name, phone or token').fill('kapoor');
  check('J2 search by name finds both Kapoors', (await reception.locator('tbody tr').count()) === 2);
  await reception.getByLabel('Search by name, phone or token').fill('');
  await reception.getByLabel('Doctor or OPD').selectOption({ label: 'Child OPD (Dr. Rohan Iyer)' });
  check('J2 doctor filter shows only Child OPD rows (6)', (await reception.locator('tbody tr').count()) === 6, await reception.locator('tbody tr').count());
  await reception.getByLabel('Doctor or OPD').selectOption('all');
  await reception.getByLabel('Status').selectOption('on_hold');
  check('J2 status filter shows the one held patient', (await reception.locator('tbody tr').count()) === 1);
  await reception.getByLabel('Status').selectOption('all');

  // Mark arrived and no-show.
  await row.getByRole('button', { name: /Mark arrived/ }).click();
  check('J2 mark arrived updates the row', /Arrived/.test(await row.innerText()) && !/Not arrived/.test(await row.innerText()), await row.innerText());
  check('J2 mark arrived announces the result', /marked as arrived/.test(await reception.locator('[role="status"]').first().innerText()));

  // ------------------------------------------------------------------ 3. Walk-in
  await reception.getByRole('link', { name: 'Walk-in entry' }).click();
  await reception.getByRole('button', { name: 'Create token' }).click();
  check('J3 empty walk-in form shows errors', (await reception.locator('.field__error').count()) === 2);
  await reception.getByLabel('Patient name').fill('Walk In Person');
  await reception.getByLabel('Mobile number').fill('9123456780');
  await reception.getByRole('button', { name: 'Create token' }).click();
  const walkNumber = await tokenNumberOn(reception);
  check('J3 walk-in gets the next number in the same line (#19)', walkNumber === 19, walkNumber);
  check('J3 walk-in panel shows patients ahead and an estimate', /Patients ahead/.test(await reception.locator('main').innerText()) && /\(estimate\)/.test(await reception.locator('main').innerText()));
  check('J3 form is cleared and ready for the next patient', (await reception.getByLabel('Patient name').inputValue()) === '');
  // Same person again is refused.
  await reception.getByLabel('Patient name').fill('Walk In Person');
  await reception.getByLabel('Mobile number').fill('9123456780');
  await reception.getByRole('button', { name: 'Create token' }).click();
  check('J3 duplicate walk-in is refused', /already exists/.test(await reception.locator('.notice--error').innerText()));
  await reception.getByRole('link', { name: 'Today\'s list', exact: true }).click();
  const walkRow = reception.locator('tbody tr', { hasText: 'Walk In Person' });
  await walkRow.getByRole('button', { name: /No-show/ }).click();
  check('J2 marking no-show changes the status and hides the arrival actions', /No-show/.test(await walkRow.innerText()) && (await walkRow.getByRole('button', { name: /Mark arrived/ }).count()) === 0, await walkRow.innerText());
  await walkRow.getByRole('button', { name: /Return to queue/ }).click();
  check('J2 return to queue makes the patient wait again', /Waiting/.test(await walkRow.innerText()), await walkRow.innerText());
  check('J3 walk-in appears in the reception list as Walk-in and arrived', await reception.locator('tbody tr', { hasText: 'Walk In Person' }).innerText().then((t) => /Walk-in/.test(t) && /Arrived/.test(t)));

  // ------------------------------------------------------------------ 6/8. Patient search (before the queue moves)
  await reception.getByRole('link', { name: 'Patient search' }).click();
  await reception.getByLabel('Name or phone number').fill('kapoor');
  const names = await reception.locator('.search-result__name').allInnerTexts();
  check('J8 search "kapoor" returns Aarav and Meera Kapoor, sorted', JSON.stringify(names) === JSON.stringify(['Aarav Kapoor', 'Meera Kapoor']), names.join(','));
  const meeraBtn = reception.locator('.search-result', { hasText: 'Meera Kapoor' });
  check('J8 result shows visit count and last visit', /3 visits/.test(await meeraBtn.innerText()) && /Last visit/.test(await meeraBtn.innerText()), await meeraBtn.innerText());
  await meeraBtn.click();
  const profile = await reception.locator('section[aria-label="Patient profile"]').innerText();
  check('J8 profile shows masked phone, total visits and previous visits', /••••• ••001/.test(profile) && /Total visits\s*3/.test(profile) && (await reception.locator('section[aria-label="Patient profile"] li').count()) === 3, profile);
  check('J8 reception profile does not show consultation notes', !/Sample note|Sample advice/.test(profile));
  await reception.getByLabel('Name or phone number').fill('9000000001');
  check('J8 phone search finds the parent and child sharing a number', (await reception.locator('.search-result').count()) === 2);
  await reception.getByLabel('Name or phone number').fill('zzzz');
  check('J8 no match shows an empty state', /No patient found/.test(await reception.locator('main').innerText()));

  // ------------------------------------------------------------------ 5/6. Live queue and TV before NEXT
  await patient.goto(bookedUrl.replace('/token/', '/queue/'));
  const liveBefore = await patient.locator('main').innerText();
  check('J5 live queue shows the current token #10 before NEXT', (await patient.locator('section[aria-label="Now serving"] .token-hero__number').getAttribute('aria-label')) === 'Token 10');
  check('J5 live queue shows 6 patients ahead for #18 (1 with doctor + 5 waiting)', /Patients ahead\s*6/.test(liveBefore.replace(/\n/g, ' ')), liveBefore.slice(0, 400));
  check('J5 estimated wait is 30 minutes and labelled as an estimate', /About 30 minutes\s*\(estimate\)/.test(liveBefore.replace(/\n/g, ' ')));
  check('J5 shows a last updated time and a live indicator', /Last updated/.test(liveBefore) && /Live/.test(liveBefore));
  const updatedBefore = (await patient.locator('.live-line span').nth(1).innerText());

  await tv.goto(`${BASE}/tv`);
  check('J6 TV shows #10 now serving', (await tv.locator('.tv__current').getAttribute('aria-label')) === 'Now serving token 10');
  check('J6 TV next three are 12, 14, 15', JSON.stringify(await tv.locator('.tv__next-list li').allInnerTexts()) === JSON.stringify(['#12', '#14', '#15']));
  check('J6 TV shows no patient names', !/Test Patient|Walk In|Meera|Sunita/.test(await tv.locator('body').innerText()));

  // ------------------------------------------------------------------ 4. Doctor NEXT
  await loginAs(doctor, 'Open as doctor, general opd');
  check('J4 doctor login lands on the next patient screen', /\/doctor$/.test(doctor.url()), doctor.url());
  const docText = await doctor.locator('main').innerText();
  check('J4 doctor sees current #10 and the next three #12 #14 #15', (await doctor.locator('section[aria-label="Current patient"] .token-hero__number').getAttribute('aria-label')) === 'Token 10' && JSON.stringify(await doctor.locator('section[aria-label="Next in line"] li .token-number').allInnerTexts()) === JSON.stringify(['#12', '#14', '#15']), docText.slice(0, 300));
  check('J4 doctor sees visit number for the current patient', /\d(st|nd|rd|th) visit/.test(docText));
  await sleep(1200); // the "Last updated" clock shows whole seconds, so let a second pass before the queue moves
  await doctor.getByRole('button', { name: 'NEXT' }).dblclick(); // double click must advance only one patient
  await doctor.waitForTimeout(300);
  check('J4 NEXT moves to #12 and a double click advances only once', (await doctor.locator('section[aria-label="Current patient"] .token-hero__number').getAttribute('aria-label')) === 'Token 12');
  const nextMsgs = await doctor.locator('[role="status"]').allInnerTexts();
  check('J4 NEXT reports finished and calling', nextMsgs.some((t) => /Finished #10\. Now calling #12\./.test(t)), JSON.stringify(nextMsgs));

  // Live updates arrive in the other tabs without a reload.
  await sleep(600);
  const liveAfter = (await patient.locator('main').innerText()).replace(/\n/g, ' ');
  check('J5 patient live queue now shows #12 without reloading', (await patient.locator('section[aria-label="Now serving"] .token-hero__number').getAttribute('aria-label')) === 'Token 12');
  check('J5 patients ahead dropped from 6 to 5', /Patients ahead\s*5/.test(liveAfter), liveAfter.slice(0, 500));
  const updatedAfter = (await patient.locator('.live-line span').nth(1).innerText());
  check('J5 last updated time changed', updatedAfter !== updatedBefore, `${updatedBefore} -> ${updatedAfter}`);
  check('J6 TV now shows #12 and next 14, 15, 16', (await tv.locator('.tv__current').getAttribute('aria-label')) === 'Now serving token 12' && JSON.stringify(await tv.locator('.tv__next-list li').allInnerTexts()) === JSON.stringify(['#14', '#15', '#16']));
  await reception.getByRole('link', { name: 'Today\'s list', exact: true }).click();
  const tokenRow = (page, n) => page.locator('tbody tr').filter({ has: page.locator('td[data-label="Token"]', { hasText: new RegExp(`^#${n}$`) }) });
  const r10 = tokenRow(reception, 10).filter({ hasText: 'General OPD' });
  check('J4 reception list shows #10 as completed', /Completed/.test(await r10.innerText()), await r10.innerText());
  const r12 = tokenRow(reception, 12);
  check('J4 reception list shows Meera #12 as in progress', /Meera/.test(await r12.innerText()) && /In progress/.test(await r12.innerText()), await r12.innerText());

  // ------------------------------------------------------------------ 9. Consultation note
  await doctor.getByRole('link', { name: 'Patient history' }).click();
  await doctor.waitForURL(/\/doctor\/history\//);
  await doctor.locator('main h1', { hasText: 'Meera Kapoor' }).waitFor({ timeout: 5000 }).catch(() => {}); // the URL changes before React renders the new screen
  const histH1 = await doctor.locator('main h1').innerText();
  const histMain = await doctor.locator('main').innerText();
  check('J9 history opens for Meera Kapoor with her visit count', /Meera Kapoor/.test(histH1) && /3 visits in total/.test(histMain), `h1=${histH1} | ${histMain.slice(0, 200)}`);
  await doctor.getByRole('button', { name: 'Add consultation note' }).click();
  const dlg = doctor.getByRole('dialog');
  check('J9 add note opens an accessible dialog with a title', await dlg.isVisible() && (await dlg.getAttribute('aria-labelledby')) !== null);
  await dlg.getByRole('button', { name: 'Save' }).click();
  check('J9 saving an empty note shows errors', (await dlg.locator('.field__error').count()) >= 1);
  await dlg.getByLabel('Reason for visit').fill('Cough review');
  await dlg.getByLabel('Consultation notes').fill('Sample note written in the e2e test.');
  await dlg.getByLabel('Medication and advice').fill('Sample advice written in the e2e test.');
  await dlg.getByLabel(/Attach a report/).setInputFiles({ name: 'chest-report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('demo') });
  check('J9 attachment shows the file name only', /chest-report\.pdf/.test(await dlg.innerText()));
  await dlg.getByRole('button', { name: 'Save' }).click();
  await doctor.waitForTimeout(200);
  check('J9 dialog closes after saving', (await doctor.getByRole('dialog').count()) === 0 || !(await doctor.getByRole('dialog').isVisible()));
  const firstCard = await doctor.locator('.timeline > li').first().innerText();
  check('J9 new note is first in the timeline with notes, advice and attachment', /Cough review/.test(firstCard) && /e2e test/.test(firstCard) && /chest-report\.pdf/.test(firstCard), firstCard);
  check('J9 total visits increased to 4', /4 visits in total/.test(await doctor.locator('main').innerText()));
  await reception.getByRole('link', { name: 'Patient search' }).click();
  await reception.getByLabel('Name or phone number').fill('meera');
  check('J9 reception search now shows 4 visits for Meera', /4 visits/.test(await reception.locator('.search-result').first().innerText()));

  // ------------------------------------------------------------------ 7. Skip, hold, resume, complete
  await doctor.getByRole('link', { name: 'Back to next patient' }).click();
  await doctor.waitForTimeout(3300); // let the 3 second NEXT cooldown pass
  await doctor.getByRole('button', { name: 'Hold' }).click();
  check('J7 hold puts #12 on hold and clears the current patient', /On hold[\s\S]*#12/.test(await doctor.locator('section[aria-label="On hold"]').innerText()) && /No patient is with the doctor/.test(await doctor.locator('section[aria-label="Current patient"]').innerText()));
  check('J7 hold does not change the next three', JSON.stringify(await doctor.locator('section[aria-label="Next in line"] li .token-number').allInnerTexts()) === JSON.stringify(['#14', '#15', '#16']));
  check('J7 TV shows no current token while on hold', /Please wait/.test(await tv.locator('.tv__current').innerText()));
  await doctor.getByRole('button', { name: /Resume token 12/ }).click();
  check('J7 resume sends #12 to the front of the line', JSON.stringify(await doctor.locator('section[aria-label="Next in line"] li .token-number').allInnerTexts()) === JSON.stringify(['#12', '#14', '#15']));
  await doctor.getByRole('button', { name: 'NEXT' }).click();
  check('J7 NEXT after resume calls #12 again', (await doctor.locator('section[aria-label="Current patient"] .token-hero__number').getAttribute('aria-label')) === 'Token 12');
  await doctor.waitForTimeout(3300);
  await doctor.getByRole('button', { name: 'Skip patient' }).click();
  check('J7 skip moves #12 to the skipped list', /#12/.test(await doctor.locator('section[aria-label="Skipped"]').innerText()));
  await doctor.getByRole('button', { name: /Return to queue token 12/ }).click();
  const nextAfterRequeue = await doctor.locator('section[aria-label="Next in line"] li .token-number').allInnerTexts();
  check('J7 returning a skipped patient puts them after the others', nextAfterRequeue.join(',') === '#14,#15,#16', nextAfterRequeue.join(','));
  await doctor.getByRole('button', { name: 'NEXT' }).click(); // calls #14
  await doctor.waitForTimeout(3300);
  await doctor.getByRole('button', { name: 'Mark completed' }).click();
  check('J7 mark completed clears the current patient', /No patient is with the doctor/.test(await doctor.locator('section[aria-label="Current patient"]').innerText()));
  await reception.getByRole('link', { name: 'Today\'s list', exact: true }).click();
  const r14 = tokenRow(reception, 14);
  check('J7 reception sees #14 as completed', /Completed/.test(await r14.innerText()), await r14.innerText());

  // Stale NEXT is ignored: drive a second doctor tab into an out of date state.
  const doctor2 = await context.newPage();
  await watch(doctor2, 'doctor2');
  await loginAs(doctor2, 'Open as doctor, child opd');
  const childCurrent = await doctor2.locator('section[aria-label="Current patient"] .token-hero__number').getAttribute('aria-label');
  check('J7 child OPD doctor has their own queue (#3 current)', childCurrent === 'Token 3', childCurrent);
  // Walk the child queue until it is empty: tokens 4, 5, 6 then the end.
  for (let i = 0; i < 4; i += 1) {
    await doctor2.waitForTimeout(3300);
    await doctor2.getByRole('button', { name: 'NEXT' }).click();
    await doctor2.waitForTimeout(200);
  }
  const lastMsgs = await doctor2.locator('[role="status"]').allInnerTexts();
  check('J7 last NEXT completes #6 and reports that nobody else is waiting', lastMsgs.some((t) => /Finished #6\. No other patient is waiting\./.test(t)), JSON.stringify(lastMsgs));
  check('J7 empty queue disables NEXT and says so', (await doctor2.getByRole('button', { name: 'NEXT' }).isDisabled()) && /No patient is waiting/.test(await doctor2.locator('main').innerText()));
  await doctor2.close();

  // ------------------------------------------------------------------ 10. Report reflects the data
  await loginAs(owner, 'Open as clinic owner');
  check('J10 owner lands on the daily report', /\/report$/.test(owner.url()));
  const reportTotal = Number(await kpi(owner, 'Total patients'));
  const reportCompleted = Number(await kpi(owner, 'Completed consultations'));
  const reportNoShow = Number(await kpi(owner, 'No-shows'));
  check('J10 total patients is 25 (23 seeded + booking + walk-in)', reportTotal === 25, reportTotal);
  check('J10 completed consultations is 16 (10 seeded + #10 and #14 + four child OPD patients)', reportCompleted === 16, reportCompleted);
  check('J10 no-shows are counted from records', reportNoShow === 1, reportNoShow);
  check('J10 average waiting time is a number of minutes', /^\d+ min$/.test(await kpi(owner, 'Average waiting time')), await kpi(owner, 'Average waiting time'));
  check('J10 chart has seven selectable days', (await owner.locator('.chart [role="button"]').count()) === 7);
  await owner.locator('.chart [role="button"]').first().click();
  const oldDayTotal = Number(await kpi(owner, 'Total patients'));
  check('J10 selecting an earlier day changes the figures', oldDayTotal !== reportTotal, oldDayTotal);
  await owner.locator('details summary').click();
  check('J10 table view lists the same seven days', (await owner.locator('details tbody tr').count()) === 7);
  await owner.locator('.chart [role="button"]').last().hover();
  check('J10 hovering a column shows a tooltip with the value', /patients/.test(await owner.locator('.chart-tip').innerText()));
  const [download] = await Promise.all([owner.waitForEvent('download'), owner.getByRole('button', { name: /Download CSV/ }).click()]);
  const csvPath = await download.path();
  const csv = require('fs').readFileSync(csvPath, 'utf8');
  check('J10 CSV export has a header and rows, and no patient names', csv.startsWith('date,opd,') && csv.split('\n').length >= 3 && !/Test Patient|Meera/.test(csv), csv.slice(0, 200));

  // ------------------------------------------------------------------ 11. Settings change behaviour
  await owner.getByRole('link', { name: 'Settings' }).click();
  await owner.getByLabel('Daily token limit for each OPD').fill('0');
  await owner.getByRole('button', { name: 'Save settings' }).click();
  check('J11 invalid limit is rejected with a message', /between 1 and 500/.test(await owner.locator('main').innerText()));
  await owner.getByLabel('Daily token limit for each OPD').fill('19');
  await owner.getByRole('switch').uncheck();
  await owner.getByRole('button', { name: 'Save settings' }).click();
  check('J11 saving shows a confirmation', /Settings saved\. Online booking is off/.test(await owner.locator('[role="status"]').first().innerText()));

  await patient.goto(`${BASE}/book`);
  check('J11 online booking off disables Book Token and explains why', (await patient.getByRole('button', { name: 'Book Token' }).isDisabled()) && /Online booking is switched off/.test(await patient.locator('main').innerText()));
  await reception.getByRole('link', { name: 'Walk-in entry' }).click();
  await reception.locator('main h1', { hasText: 'Walk-in entry' }).waitFor({ timeout: 5000 }).catch(() => {});
  const walkInMain = await reception.locator('main').innerText();
  check('J11 reception is told walk-in still works', /Walk-in entry still works/.test(walkInMain), walkInMain.slice(0, 300));
  await reception.getByLabel('Doctor or OPD').selectOption({ label: 'Child OPD (Dr. Rohan Iyer)' });
  await reception.getByLabel('Patient name').fill('Online Off Walkin');
  await reception.getByLabel('Mobile number').fill('9333333334');
  await reception.getByRole('button', { name: 'Create token' }).click();
  check('J11 walk-in still works while online booking is off (Child OPD gets #7)', (await tokenNumberOn(reception)) === 7, await tokenNumberOn(reception));
  await reception.getByLabel('Doctor or OPD').selectOption({ label: 'General OPD (Dr. Asha Verma)' });
  await reception.getByLabel('Patient name').fill('Limit Tester');
  await reception.getByLabel('Mobile number').fill('9333333333');
  check('J11 General OPD is at its limit of 19: reception sees a warning and Create token is disabled', /daily limit of 19/.test(await reception.locator('main').innerText()) && (await reception.getByRole('button', { name: 'Create token' }).isDisabled()));
  await reception.getByLabel('Issue this token anyway').check();
  await reception.getByRole('button', { name: 'Create token' }).click();
  check('J11 walk-in beyond the limit works only after reception confirms it (#20)', (await tokenNumberOn(reception)) === 20);

  await owner.getByRole('switch').check();
  await owner.getByLabel('Daily token limit for each OPD').fill('19');
  await owner.getByRole('button', { name: 'Save settings' }).click();
  await patient.goto(`${BASE}/book`);
  const fullNotice = await patient.locator('main').innerText();
  check('J11 daily limit reached disables booking for today with a clear message', (await patient.getByRole('button', { name: 'Book Token' }).isDisabled()) && /All 19 tokens are booked/.test(fullNotice), fullNotice.slice(0, 600));
  await patient.getByRole('radio', { name: /Tomorrow/ }).check();
  check('J11 tomorrow is still open for the same OPD', await patient.getByRole('button', { name: 'Book Token' }).isEnabled());
  await patient.getByRole('radio', { name: /Child OPD/ }).check();
  await patient.getByRole('radio', { name: /Today/ }).check();
  check('J11 the limit is per OPD: Child OPD still open today', await patient.getByRole('button', { name: 'Book Token' }).isEnabled());

  // Doctor management.
  await owner.getByRole('button', { name: 'Add doctor' }).click();
  const dd = owner.getByRole('dialog');
  await dd.getByRole('button', { name: 'Add doctor' }).click();
  check('J11 empty doctor form shows validation errors', (await dd.locator('.field__error').count()) >= 2);
  await dd.getByLabel('Doctor name').fill('Dr. Test Added');
  await dd.getByLabel('OPD name').fill('Skin OPD');
  await dd.getByRole('button', { name: 'Add doctor' }).click();
  check('J11 added doctor appears in the table', (await owner.locator('tbody tr', { hasText: 'Skin OPD' }).count()) === 1);
  await patient.goto(`${BASE}/book`);
  check('J11 added doctor is bookable by patients', (await patient.getByRole('radio', { name: /Skin OPD/ }).count()) === 1);
  await owner.locator('tbody tr', { hasText: 'Child OPD' }).getByRole('button', { name: /Remove/ }).click();
  await owner.getByRole('dialog').getByRole('button', { name: 'Remove doctor' }).click();
  const refusal = owner.getByRole('dialog').locator('.notice--error');
  check('J11 removing a doctor with open tokens is refused with an error notice', (await refusal.count()) === 1 && /still has \d+ open token/.test(await refusal.innerText()), (await refusal.count()) ? await refusal.innerText() : 'no error notice');
  await owner.keyboard.press('Escape');
  check('J11 the refused doctor is still in the table', (await owner.locator('tbody tr', { hasText: 'Child OPD' }).count()) === 1);
  check('J11 Escape closes the confirmation dialog', (await owner.getByRole('dialog').count()) === 0 || !(await owner.getByRole('dialog').isVisible()));
  await owner.locator('tbody tr', { hasText: 'Skin OPD' }).getByRole('button', { name: /Remove/ }).click();
  await owner.getByRole('dialog').getByRole('button', { name: 'Remove doctor' }).click();
  check('J11 a doctor with no open tokens can be removed', (await owner.locator('tbody tr', { hasText: 'Skin OPD' }).count()) === 0);

  // ------------------------------------------------------------------ 12. Role based access
  const guest = await context.newPage();
  await watch(guest, 'guest');
  for (const path of ['/reception', '/reception/walk-in', '/doctor', '/report', '/settings']) {
    await guest.goto(`${BASE}${path}`);
    await guest.waitForURL(/\/login$/, { timeout: 4000 }).catch(() => {});
    check(`J12 signed out visit to ${path} goes to the login screen`, /\/login$/.test(guest.url()), guest.url());
  }
  await loginAs(guest, 'Open as reception');
  const denied = {};
  for (const path of ['/settings', '/doctor', '/report']) {
    await guest.goto(`${BASE}${path}`);
    denied[path] = /You cannot open this screen/.test(await guest.locator('main').innerText());
  }
  check('J12 reception is blocked from settings, doctor panel and report', Object.values(denied).every(Boolean), JSON.stringify(denied));
  const recNav = await guest.locator('nav[aria-label$="screens"]').innerText();
  check('J12 reception navigation lists only reception screens', /Today's list/.test(recNav) && !/Settings|Daily report|Next patient/.test(recNav), recNav);
  await guest.getByRole('button', { name: 'Log out' }).click();
  check('J12 log out returns to login', /\/login$/.test(guest.url()));
  await guest.goto(`${BASE}/reception`);
  await guest.waitForURL(/\/login$/, { timeout: 4000 }).catch(() => {});
  check('J12 after logging out the reception screen is closed again', /\/login$/.test(guest.url()), guest.url());
  await loginAs(guest, 'Open as doctor, general opd');
  await guest.goto(`${BASE}/reception`);
  check('J12 doctor is blocked from the reception screens', /You cannot open this screen/.test(await guest.locator('main').innerText()));
  await guest.goto(`${BASE}/login`);
  await guest.getByRole('button', { name: 'Log out' }).click();
  // Manual demo login with the code.
  await guest.getByLabel('Mobile number').fill('9000000101');
  await guest.getByLabel('One time code').fill('0000');
  await guest.getByRole('button', { name: 'Log in' }).click();
  check('J12 wrong code is rejected', /not correct/.test(await guest.locator('main').innerText()));
  await guest.getByLabel('One time code').fill('1234');
  await guest.getByRole('button', { name: 'Log in' }).click();
  await guest.waitForURL(/\/reception$/);
  check('J12 manual login with the demo code works', true);
  await guest.getByRole('button', { name: 'Log out' }).click();
  await guest.getByLabel('Mobile number').fill('9111111111');
  await guest.getByLabel('One time code').fill('1234');
  await guest.getByRole('button', { name: 'Log in' }).click();
  check('J12 unknown number is rejected', /not one of the demo staff numbers/.test(await guest.locator('main').innerText()));
  await guest.close();

  // ------------------------------------------------------------------ 13. Persistence across refresh
  await patient.goto(bookedUrl);
  await patient.reload();
  check('J13 refresh keeps the booked token (#18)', (await tokenNumberOn(patient)) === 18);
  await reception.goto(`${BASE}/reception`);
  await reception.reload();
  check('J13 refresh keeps the reception session and all data (27 tokens today)', /Today's list/.test(await reception.locator('h1').innerText()) && Number(await kpi(reception, 'Tokens today')) === 27, await kpi(reception, 'Tokens today'));
  await patient.goto(`${BASE}/queue`);
  check('J13 live queue without a link follows this device\'s last token', /Your token\s*#?18|Your token/.test(await patient.locator('main').innerText()) && (await patient.locator('section[aria-label="Your token"] .token-number').first().getAttribute('aria-label')) === 'Token 18');

  // ------------------------------------------------------------------ 14. Reset restores everything
  await owner.getByRole('button', { name: 'Reset demo data' }).first().click();
  const confirm = owner.getByRole('dialog');
  check('J14 reset asks for confirmation first', /Reset all demo data/.test(await confirm.innerText()));
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await owner.goto(`${BASE}/report`);
  check('J14 cancelling reset changes nothing (27 patients today)', Number(await kpi(owner, 'Total patients')) === 27, await kpi(owner, 'Total patients'));
  await owner.getByRole('button', { name: 'Reset demo data' }).first().click();
  await owner.getByRole('dialog').getByRole('button', { name: 'Reset demo data' }).click();
  await owner.waitForTimeout(300);
  check('J14 after reset today\'s total is back to the seeded 23', Number(await kpi(owner, 'Total patients')) === 23, await kpi(owner, 'Total patients'));
  await patient.goto(bookedUrl);
  check('J14 the booked token no longer exists after reset', /Token not found/.test(await patient.locator('main').innerText()));
  await owner.goto(`${BASE}/settings`);
  check('J14 settings are back to defaults', (await owner.getByLabel('Daily token limit for each OPD').inputValue()) === '60' && (await owner.getByRole('switch').isChecked()));
  await tv.reload();
  check('J14 TV is back to #10 now serving', (await tv.locator('.tv__current').getAttribute('aria-label')) === 'Now serving token 10');

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  const unique = [...new Set(consoleProblems)];
  console.log(unique.length ? `Console problems (${unique.length}):\n${unique.join('\n')}` : 'No console errors or warnings in any tab.');
  require('fs').writeFileSync(`${__dirname}/journeys-result.json`, JSON.stringify({ results, consoleProblems: unique }, null, 2));
  process.exit(failed.length || unique.length ? 1 : 0);
})().catch((err) => {
  console.error('SCRIPT ERROR', err);
  process.exit(2);
});
