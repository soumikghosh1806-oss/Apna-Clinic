const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  -> ' + d}`); };
async function login(ctx, name) { const p = await ctx.newPage(); await p.goto(`${BASE}/login`); await p.getByRole('button', { name }).click(); await p.waitForLoadState('networkidle'); return p; }

async function dialogChecks(page, label, openFn, openerLocator, w, h) {
  await openFn();
  const dlg = page.getByRole('dialog');
  await dlg.waitFor({ timeout: 3000 });
  const box = await dlg.boundingBox();
  check(`${label}@${w}: dialog fits inside the viewport`, box && box.x >= -1 && box.y >= -1 && box.x + box.width <= w + 1 && box.y + box.height <= h + 1, JSON.stringify(box));
  const named = await dlg.evaluate((el) => !!(el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent.trim()));
  check(`${label}@${w}: dialog has a visible title wired by aria-labelledby`, named);
  const focusInside = await page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('dialog'));
  check(`${label}@${w}: focus moves into the dialog`, focusInside);
  // Tab many times and confirm focus never leaves the dialog.
  let escaped = false;
  for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); if (await page.evaluate(() => { const a = document.activeElement; return !!a && a !== document.body && a !== document.documentElement && !a.closest('dialog'); })) { escaped = true; break; } }
  check(`${label}@${w}: Tab key never reaches the page behind the dialog`, !escaped);
  const ov = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check(`${label}@${w}: no sideways scrolling with the dialog open`, ov);
  const btns = await dlg.getByRole('button').all();
  let small = [];
  for (const b of btns) { const bb = await b.boundingBox(); if (bb && (bb.height < 36)) small.push(`${(await b.innerText()).trim()}:${Math.round(bb.height)}`); }
  check(`${label}@${w}: dialog buttons are at least 36px tall`, small.length === 0, small.join(', '));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check(`${label}@${w}: Escape closes the dialog`, (await page.getByRole('dialog').count()) === 0);
  const back = await openerLocator.evaluate((el) => el === document.activeElement);
  check(`${label}@${w}: focus returns to the button that opened it`, back);
}

(async () => {
  const browser = await chromium.launch();
  for (const [w, h] of [[375, 700], [1440, 900]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const boot = await ctx.newPage(); await boot.goto(BASE); await boot.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await boot.close();

    // Doctor: add note dialog
    const doctor = await login(ctx, 'Open as doctor, general opd');
    await doctor.goto(`${BASE}/doctor/history/pat-s01`);
    await doctor.locator('main h1', { hasText: 'Meera Kapoor' }).waitFor();
    const addNote = doctor.getByRole('button', { name: 'Add consultation note' });
    await dialogChecks(doctor, 'add-note', () => addNote.click(), addNote, w, h);

    // Owner: add doctor dialog and reset confirmation
    const owner = await login(ctx, 'Open as clinic owner');
    await owner.goto(`${BASE}/settings`);
    await owner.locator('main h1', { hasText: 'Settings' }).waitFor();
    const addDoc = owner.getByRole('button', { name: /Add doctor|Add a doctor/ });
    await dialogChecks(owner, 'add-doctor', () => addDoc.click(), addDoc, w, h);
    const reset = owner.getByRole('button', { name: /Reset demo data/ }).first();
    await dialogChecks(owner, 'reset-confirm', () => reset.click(), reset, w, h);

    // Booking form on this width: labels, error summary focus, keyboard-only submit.
    const patient = await ctx.newPage();
    await patient.goto(`${BASE}/book`);
    await patient.getByRole('button', { name: 'Book Token' }).click();
    const errs = await patient.locator('.field__error').count();
    check(`book@${w}: empty submit shows field errors`, errs >= 2, String(errs));
    const focusOnError = await patient.evaluate(() => document.activeElement?.matches('input, select, textarea') && document.activeElement.getAttribute('aria-invalid') === 'true');
    check(`book@${w}: focus moves to the first invalid field`, focusOnError);
    await patient.getByLabel('Patient name').fill('Keyboard User');
    await patient.getByLabel('Mobile number').fill('9555555555');
    await patient.getByLabel('Mobile number').press('Enter');
    await patient.waitForURL(/\/token\//, { timeout: 4000 }).then(() => check(`book@${w}: Enter submits the form from the keyboard`, true)).catch(() => check(`book@${w}: Enter submits the form from the keyboard`, false, patient.url()));
    const inputH = await (async () => { await patient.goto(`${BASE}/book`); return patient.getByLabel('Patient name').evaluate((el) => parseFloat(getComputedStyle(el).fontSize)); })();
    check(`book@${w}: input text is at least 16px so phones do not zoom on focus`, inputH >= 16, String(inputH));
    await ctx.close();
  }

  // Reduced motion: no transition or animation longer than a negligible time.
  const rctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const rp = await rctx.newPage(); await rp.goto(BASE + '/book'); await rp.waitForLoadState('networkidle');
  const motion = await rp.evaluate(() => { let long = []; document.querySelectorAll('*').forEach((el) => { const s = getComputedStyle(el); const parse = (v) => Math.max(...v.split(',').map((x) => parseFloat(x) * (x.includes('ms') ? 1 : 1000))); const t = parse(s.transitionDuration), a = parse(s.animationDuration); if (t > 10 || a > 10) long.push(`${el.tagName}.${el.className}: t=${t} a=${a}`); }); return long.slice(0, 5); });
  check('reduced motion: no transitions or animations are left running', motion.length === 0, motion.join(' | '));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
})().catch((e) => { console.error('SCRIPT ERROR', e.message); process.exit(1); });
