// Visits every screen, collects each internal link and checks that its target is a real screen (not the 404 page) for the right role.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const s = await ctx.newPage(); await s.goto(BASE); await s.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await s.close();
  const seen = new Map(); const bad = [];
  const roles = [null, 'Open as reception', 'Open as doctor, general opd', 'Open as clinic owner'];
  const start = ['/', '/book', '/queue', '/login', '/privacy', '/terms', '/tv'];
  const startStaff = { 'Open as reception': ['/reception', '/reception/walk-in', '/reception/patients'], 'Open as doctor, general opd': ['/doctor', '/report'], 'Open as clinic owner': ['/report', '/settings'] };
  for (const role of roles) {
    const page = await ctx.newPage();
    if (role) { await page.goto(`${BASE}/login`); await page.getByRole('button', { name: role }).click(); await page.waitForLoadState('networkidle'); }
    for (const path of [...(role ? startStaff[role] : start)]) {
      await page.goto(BASE + path, { waitUntil: 'networkidle' });
      const links = await page.$$eval('a[href]', (as) => as.map((a) => ({ href: a.getAttribute('href'), text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 40), ext: a.target === '_blank' })));
      for (const l of links) { const key = l.href; if (!seen.has(key)) seen.set(key, { from: path, text: l.text, role, ext: l.ext }); }
    }
    await page.close();
  }
  const checker = await ctx.newPage();
  const login = async (role) => { await checker.goto(`${BASE}/`); await checker.evaluate(() => sessionStorage.clear()); await checker.goto(`${BASE}/login`); await checker.getByRole('button', { name: role }).click(); await checker.waitForLoadState('networkidle'); };
  for (const [href, info] of seen) {
    if (/^(https?:|mailto:|tel:)/.test(href)) { bad.push(`external link needs review: ${href} (${info.text})`); continue; }
    if (href.startsWith('#')) { const ok = await checker.goto(BASE + '/', { waitUntil: 'networkidle' }).then(() => checker.evaluate((h) => !!document.querySelector(h), href)); if (!ok) bad.push(`dead anchor ${href} on ${info.from}`); continue; }
    const need = href.startsWith('/reception') ? 'Open as reception' : href.startsWith('/doctor') ? 'Open as doctor, general opd' : href.startsWith('/report') ? 'Open as clinic owner' : href.startsWith('/settings') ? 'Open as clinic owner' : null;
    if (need) await login(need);
    else { await checker.evaluate(() => sessionStorage.clear()).catch(() => {}); }
    await checker.goto(BASE + href, { waitUntil: 'networkidle' });
    const h1 = await checker.locator('main h1, h1').first().innerText().catch(() => '');
    const notFound = /not found/i.test(h1) && !/token/i.test(href);
    if (notFound) bad.push(`${href} (from ${info.from}, "${info.text}") shows: ${h1}`);
    console.log(`ok  ${href.padEnd(32)} -> ${h1.slice(0, 40)}`);
  }
  console.log(bad.length ? 'PROBLEMS:\n' + bad.join('\n') : `\nAll ${seen.size} distinct internal link targets open a real screen.`);
  await b.close();
})().catch((e) => { console.error('SCRIPT ERROR', e.message); process.exit(1); });
