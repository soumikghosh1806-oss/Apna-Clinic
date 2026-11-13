const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';
const WIDTHS = [[375, 800], [768, 1024], [1440, 900], [1920, 1080]];

async function loginAs(ctx, name) {
  const p = await ctx.newPage();
  await p.goto(`${BASE}/login`);
  await p.getByRole('button', { name }).click();
  await p.waitForLoadState('networkidle');
  return p;
}

(async () => {
  const browser = await chromium.launch();
  const summary = [];
  const axeAll = [];
  const overflow = [];
  for (const [w, h] of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const boot = await ctx.newPage(); await boot.goto(BASE); await boot.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    // Book a token so the confirmation and live queue screens have something to show.
    await boot.goto(`${BASE}/book`);
    await boot.getByLabel('Patient name').fill('Axe Tester');
    await boot.getByLabel('Mobile number').fill('9444444444');
    await boot.getByRole('button', { name: 'Book Token' }).click();
    await boot.waitForURL(/\/token\//);
    const tokenPath = new URL(boot.url()).pathname;
    const queuePath = tokenPath.replace('/token/', '/queue/');
    await boot.close();

    const pages = [
      ['home', '/', null], ['book', '/book', null], ['confirm', tokenPath, null], ['live', queuePath, null],
      ['tv', '/tv', null], ['login', '/login', null], ['privacy', '/privacy', null], ['terms', '/terms', null], ['notfound', '/nope', null],
      ['reception-list', '/reception', 'Open as reception'], ['reception-walkin', '/reception/walk-in', 'Open as reception'], ['reception-search', '/reception/patients', 'Open as reception'],
      ['doctor', '/doctor', 'Open as doctor, general opd'], ['history', '/doctor/history/pat-s01', 'Open as doctor, general opd'],
      ['report', '/report', 'Open as clinic owner'], ['settings', '/settings', 'Open as clinic owner'],
    ];
    const sessions = {};
    for (const [key, route, who] of pages) {
      let page;
      if (!who) page = await ctx.newPage();
      else { sessions[who] ||= await loginAs(ctx, who); page = sessions[who]; }
      await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
      if (key === 'reception-search') { await page.getByRole('searchbox').or(page.getByLabel(/Search/)).first().fill('Meera').catch(() => {}); }
      await page.waitForTimeout(150);
      const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      if (o.sw > o.iw + 1) overflow.push(`${key}@${w}: scrollWidth ${o.sw} > ${o.iw}`);
      await page.addScriptTag({ content: axeSource });
      const res = await page.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } }));
      for (const v of res.violations) axeAll.push({ key, w, id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\n').slice(1, 3).join(' ')) });
      summary.push(`${key}@${w}: ${res.violations.length} violations, ${res.passes.length} rules passed`);
      await page.screenshot({ path: path.join(SHOTS, `${key}-${w}.png`), fullPage: true });
      if (!who) await page.close();
    }
    await ctx.close();
  }
  await browser.close();
  console.log(summary.join('\n'));
  console.log('\nOVERFLOW:', overflow.length ? '\n' + overflow.join('\n') : 'none');
  console.log('\nAXE VIOLATIONS:', axeAll.length ? '' : 'none');
  const seen = new Set();
  for (const v of axeAll) { const k = `${v.key}|${v.id}`; if (seen.has(k)) continue; seen.add(k); console.log(`- [${v.impact}] ${v.id} on ${v.key}@${v.w}: ${v.help}\n    ${v.nodes.join('\n    ')}`); }
})().catch((e) => { console.error('SCRIPT ERROR', e.message); process.exit(1); });
