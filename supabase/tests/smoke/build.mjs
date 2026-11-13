// Expands the shorthand in smoke.template.sql into plain SQL.
import fs from 'node:fs';
const here = new URL('.', import.meta.url).pathname;
const src = fs.readFileSync(here + 'smoke.template.sql', 'utf8');
const role = (uid, r) => `perform set_config('request.jwt.claims', jsonb_build_object('sub', ${uid}, 'role', '${r}')::text, true); perform set_config('request.jwt.claim.sub', ${uid}::text, true); set local role ${r};`;
const out = src.split('\n').map((line) => {
  const t = line.trim();
  const pad = line.slice(0, line.length - line.trimStart().length);
  let m;
  if ((m = t.match(/^@chk '(.+?)' \| (.+)$/))) return `${pad}res := res || jsonb_build_array(jsonb_build_object('t', '${m[1]}', 'ok', coalesce((${m[2]}), false)));`;
  if ((m = t.match(/^@as (\w+)$/))) return pad + role(m[1], 'authenticated');
  if (t === '@anon') return `${pad}perform set_config('request.jwt.claims', '{"role":"anon"}', true); perform set_config('request.jwt.claim.sub', '', true); set local role anon;`;
  if (t === '@svc') return `${pad}perform set_config('request.jwt.claims', '{"role":"service_role"}', true); perform set_config('request.jwt.claim.sub', '', true); set local role service_role;`;
  if (t === '@root') return `${pad}reset role;`;
  if ((m = t.match(/^@tick (\d+)$/))) return `${pad}perform set_config('app.fake_now', (v_base + interval '${m[1]} seconds')::text, true);`;
  if ((m = t.match(/^@try (.+)$/))) return `${pad}begin execute ${m[1]}; code := 'ok'; exception when others then code := sqlstate; end;`;
  return line;
}).join('\n');
fs.writeFileSync(here + 'smoke.sql', out);
console.log(out.split('\n').length, 'lines');
