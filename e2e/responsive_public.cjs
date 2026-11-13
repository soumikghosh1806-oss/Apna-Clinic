// Real backend path, the new screens at eight screen widths: the home page directory, booking with a code, the token page,
// the live queue, "check my place", the owner's listing card, the Add staff form and the doctor timetable.
// For every screen at every width it checks (1) the page does not scroll sideways, (2) nothing sticks out of its
// container, (3) text a thumb must tap is large enough, (4) axe-core finds no accessibility problem (WCAG 2.2 AA and best
// practice), and (5) the browser console stays quiet. Screenshots go to e2e/shots/public-*.png.
//
//   bash scripts/run-e2e.sh e2e/responsive_public.cjs
//
// The text message and email providers are local fakes (see public_booking_flows.cjs); this script is about layout and
// accessibility, not delivery.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4174';
const SHIM = process.env.SHIM_URL || 'http://127.0.0.1:54399';
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const RUN = Math.random().toString(36).slice(2, 7);
const PASSWORD = 'Correct-horse-9';
const SLUG = `wide-${RUN}`;
const NAME = `Widescreen Clinic ${RUN}`;
const WIDTHS = [320, 360, 390, 430, 768, 1024, 1366, 1920];
const HEIGHT = (w) => (w < 700 ? 800 : w < 1100 ? 1024 : 900);
const SHOT_WIDTHS = new Set([320, 390, 1024, 1920]);

const results = [];
const problems = [];
const axeFound = [];
const overflowFound = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
}
async function shim(p, body) {
  const res = await fetch(`${SHIM}${p}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return res.json();
}
const sql = (text, params) => shim('/__shim/query', { sql: text, params });
const see = async (page, text, timeout = 8000) => {
  try { await page.getByText(text, { exact: false }).first().waitFor({ timeout }); return true; } catch { return false; }
};
const fillLabel = (page, label, value) => page.getByLabel(label, { exact: true }).fill(value);

async function mockRealtime(ctx) {
  await ctx.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    ws.onMessage((raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (Array.isArray(m)) {
        const [joinRef, ref, topic, event] = m;
        if (event === 'phx_join') ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: { postgres_changes: [] } }]));
        else if (event === 'heartbeat') ws.send(JSON.stringify([null, ref, 'phoenix', 'phx_reply', { status: 'ok', response: {} }]));
      }
    });
  });
}

let browser;
async function newContext(label) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
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

/** Looks at the screen the page is showing right now at every width. `scope` is a selector to also test for sideways overflow. */
async function auditAtWidths(page, key, { scope } = {}) {
  let sideways = 0;
  let sticking = 0;
  let small = 0;
  let violations = 0;
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: HEIGHT(w) });
    await page.waitForTimeout(120);
    const geometry = await page.evaluate((scopeSelector) => {
      const root = scopeSelector ? document.querySelector(scopeSelector) : document.body;
      const iw = window.innerWidth;
      const out = { page: document.documentElement.scrollWidth - iw, sticking: [], small: [], scopeOver: 0 };
      if (scopeSelector && root) out.scopeOver = root.scrollWidth - root.clientWidth;
      const all = (root || document.body).querySelectorAll('*');
      for (const el of all) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (el.closest('.sr-only') || el.classList.contains('sr-only')) continue;
        // A scrolling box is allowed to be wider than the screen inside itself.
        let clipped = false;
        for (let p = el.parentElement; p; p = p.parentElement) {
          const ps = getComputedStyle(p);
          if (/(auto|scroll|hidden)/.test(ps.overflowX) && p !== document.body && p !== document.documentElement) { clipped = true; break; }
        }
        if (!clipped && (r.right > iw + 1 || r.left < -1)) out.sticking.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} ${Math.round(r.left)}..${Math.round(r.right)} "${(el.textContent || '').trim().slice(0, 30)}"`);
        const tag = el.tagName;
        const isTap = tag === 'BUTTON' || tag === 'SELECT' || (tag === 'A' && el.classList.contains('btn')) || (tag === 'INPUT' && !['radio', 'checkbox', 'hidden'].includes(el.type));
        if (isTap && (r.height < 32 || r.width < 32)) out.small.push(`${tag.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)} "${(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`);
      }
      return out;
    }, scope || null);
    if (geometry.page > 1 || geometry.scopeOver > 1) { sideways++; overflowFound.push(`${key}@${w}: sideways scroll by ${Math.max(geometry.page, geometry.scopeOver)}px`); }
    if (geometry.sticking.length) { sticking++; overflowFound.push(`${key}@${w}: sticks out: ${geometry.sticking.slice(0, 3).join(' | ')}`); }
    if (geometry.small.length) { small++; overflowFound.push(`${key}@${w}: small tap target: ${geometry.small.slice(0, 3).join(' | ')}`); }

    await page.evaluate(axeSource);
    const res = await page.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } }));
    if (res.violations.length) {
      violations += res.violations.length;
      for (const v of res.violations) axeFound.push({ key, w, id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) });
    }
    if (SHOT_WIDTHS.has(w)) await page.screenshot({ path: path.join(SHOTS, `public-${key}-${w}.png`), fullPage: true });
  }
  check(`${key}: no sideways scroll at ${WIDTHS.join(', ')}`, sideways === 0);
  check(`${key}: nothing sticks out of the screen at any width`, sticking === 0);
  check(`${key}: every button and field is at least 32px tall and wide at any width`, small === 0);
  check(`${key}: axe finds no violations at any width`, violations === 0, `${violations} violations`);
}

async function registerClinic(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/register`);
  await fillLabel(page, 'Your name', 'Wide Owner');
  await fillLabel(page, 'Email address', `wide-${RUN}@example.test`);
  await fillLabel(page, 'Password', PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await see(page, 'Step 2 of 2');
  await fillLabel(page, 'Clinic name', NAME);
  await page.getByLabel('Clinic web address', { exact: true }).fill(SLUG);
  await page.getByRole('button', { name: 'Create clinic' }).click();
  await page.waitForURL('**/report', { timeout: 10000 }).catch(() => {});
  return page;
}

async function main() {
  browser = await chromium.launch();
  const ownerCtx = await newContext('owner');
  const owner = await registerClinic(ownerCtx);
  const clinic = (await sql('select id from public.clinics where slug = $1', [SLUG]))[0];
  check('an owner registered a clinic', Boolean(clinic?.id));

  await owner.goto(`${BASE}/settings`);
  await owner.getByRole('button', { name: 'Add doctor' }).click();
  const add = owner.getByRole('dialog');
  await add.getByLabel('Doctor name', { exact: true }).fill('Dr Wide Skin');
  await add.getByLabel('OPD name', { exact: true }).fill('Skin and Hair OPD');
  await add.locator('#start-0').fill('00:00');
  await add.locator('#end-0').fill('23:59');
  await add.getByRole('button', { name: 'Add doctor' }).click();
  check('a doctor was added', await see(owner, 'Dr Wide Skin was added'));
  await owner.getByRole('button', { name: 'Add doctor' }).waitFor();
  const doctor = (await sql('select id from public.doctors where clinic_id = $1', [clinic.id]))[0];
  await sql(`update public.doctors set specialization = 'Dermatologist' where id = $1`, [doctor.id]);

  // List the clinic through the owner's own screen, then audit that screen.
  await owner.goto(`${BASE}/settings`);
  const card = owner.locator('section', { hasText: 'Home page listing and booking security' });
  await card.getByRole('switch', { name: /List my clinic on the home page/ }).check();
  await card.getByLabel('City or town', { exact: true }).fill('Pune');
  await card.getByLabel('Address (optional)', { exact: true }).fill('12 MG Road, Camp, near the very long landmark name that wraps');
  await card.getByLabel('Public phone number (optional)', { exact: true }).fill('+91 20 5550 1234');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  check('the owner listed the clinic', await see(owner, 'Your clinic is listed on the home page'));
  await auditAtWidths(owner, 'owner-listing-card', {});

  // Add staff dialog and the schedule dialog.
  await owner.getByRole('button', { name: 'Add staff' }).click();
  await owner.getByRole('dialog').waitFor();
  await owner.getByRole('dialog').getByRole('button', { name: 'Create account' }).click(); // shows every error message, the longest layout
  await see(owner, 'Please fix the highlighted fields');
  await auditAtWidths(owner, 'add-staff-dialog', { scope: '[role="dialog"]' });
  await owner.keyboard.press('Escape');
  await owner.getByRole('dialog').waitFor({ state: 'detached', timeout: 4000 }).catch(() => {});

  await owner.getByRole('button', { name: 'Schedule for Dr Wide Skin', exact: true }).click();
  await see(owner, 'Timetable: Dr Wide Skin');
  await auditAtWidths(owner, 'schedule-dialog', { scope: '[role="dialog"]' });
  await owner.keyboard.press('Escape');
  await owner.getByRole('dialog').waitFor({ state: 'detached', timeout: 4000 }).catch(() => {});

  // ---------------------------------------------------------------- visitors
  const visitorCtx = await newContext('visitor');
  const v = await visitorCtx.newPage();
  await v.goto(`${BASE}/`);
  check('the home page lists the clinic', await see(v, NAME));
  await auditAtWidths(v, 'home-directory');
  await v.getByLabel('Search clinic by name or location', { exact: true }).fill('zzzzz');
  check('a search with no match says so', await see(v, 'No clinic matches your search.'));
  await auditAtWidths(v, 'home-no-match');
  await v.getByRole('button', { name: 'Clear search and filters' }).click();
  await see(v, NAME);

  // Booking: first one booking with no code so the token page exists, then a code is required.
  const bookUrl = `${BASE}/c/${SLUG}/book?doctor=${doctor.id}`;
  await v.goto(bookUrl);
  await see(v, 'Choose a doctor or OPD');
  await auditAtWidths(v, 'book-form');
  await fillLabel(v, 'Patient name', 'Wide Patient');
  await fillLabel(v, 'Mobile number', '9822200011');
  await v.getByRole('button', { name: 'Book Token' }).click();
  check('a token was booked', await see(v, 'Token booked'));
  const tokenUrl = v.url();
  await auditAtWidths(v, 'token-page');

  await sql(`update public.clinic_settings set require_phone_otp = true where clinic_id = $1`, [clinic.id]);
  await v.goto(bookUrl);
  await see(v, 'Choose a doctor or OPD');
  await fillLabel(v, 'Patient name', 'Second Wide Patient');
  await fillLabel(v, 'Mobile number', '9822200012');
  await v.getByRole('button', { name: 'Book Token' }).click();
  check('the clinic asks the patient to verify', await see(v, 'Verify before booking'));
  await auditAtWidths(v, 'verify-choose-method');
  await v.getByRole('button', { name: 'Send code by text message' }).click();
  check('a code was sent', await see(v, 'We sent a 6 digit code by text message'));
  await v.getByLabel('6 digit code', { exact: true }).fill('12');
  await auditAtWidths(v, 'verify-enter-code');
  await v.getByLabel('6 digit code', { exact: true }).fill('000000');
  await v.getByRole('button', { name: 'Verify' }).click();
  check('a wrong code shows its message', await see(v, 'That code is not correct'));
  await auditAtWidths(v, 'verify-wrong-code');

  // Live queue as a stranger (a fresh browser, so no remembered token hides the board).
  await sql(`update public.queue_tokens set status = 'serving', arrived_at = now() where id = (select id from public.queue_tokens where doctor_id = $1 and status = 'waiting' order by token_number limit 1)`, [doctor.id]);
  const strangerCtx = await newContext('stranger');
  const s = await strangerCtx.newPage();
  await s.goto(`${BASE}/c/${SLUG}/queue?doctor=${doctor.id}`);
  check('the live queue shows the doctor', await see(s, 'Dr Wide Skin'));
  await see(s, 'Now serving');
  await auditAtWidths(s, 'live-queue');
  await s.getByRole('button', { name: 'Check my place in the queue' }).click();
  await see(s, 'Check your place in the queue');
  await auditAtWidths(s, 'check-my-place-form');
  await fillLabel(s, 'Mobile number', '9822200011');
  await s.getByRole('button', { name: 'Send code by text message' }).click();
  await see(s, 'We sent a 6 digit code by text message');
  const sms = (await shim('/__shim/sms')).filter((m) => m.to === '+919822200011');
  const code = /^(\d{6}) is your Apna Clinic verification code/.exec(sms[sms.length - 1]?.body ?? '')?.[1];
  check('the fake phone got the code', Boolean(code));
  await s.getByLabel('6 digit code', { exact: true }).fill(code ?? '000000');
  await s.getByRole('button', { name: 'Verify' }).click();
  check('after the code, the patient sees their own place', await see(s, 'Your place today'));
  await auditAtWidths(s, 'check-my-place-result');

  // The token page again, now that the queue is moving, plus the live queue with the remembered token.
  await v.goto(tokenUrl);
  await see(v, 'Token');
  await auditAtWidths(v, 'token-page-queue-moving');

  await browser.close();

  console.log('\nOVERFLOW / TAP SIZE:', overflowFound.length ? '\n' + [...new Set(overflowFound)].join('\n') : 'none');
  console.log('\nAXE VIOLATIONS:', axeFound.length ? '' : 'none');
  const seen = new Set();
  for (const a of axeFound) {
    const k = `${a.key}|${a.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`- [${a.impact}] ${a.id} on ${a.key}@${a.w}: ${a.help}\n    ${a.nodes.join('\n    ')}`);
  }
  console.log('\nCONSOLE:', problems.length ? '\n' + problems.join('\n') : 'no errors or warnings');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length || problems.length ? 1 : 0);
}

main().catch(async (e) => { console.error('SCRIPT ERROR', e.stack || e.message); try { await browser.close(); } catch {} process.exit(1); });
