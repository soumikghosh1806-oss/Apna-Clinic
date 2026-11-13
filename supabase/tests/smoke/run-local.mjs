import fs from 'node:fs';
import { startDb } from '../harness.mjs';
const db = await startDb({ port: 54352 });
try {
  await db.admin.query(fs.readFileSync(new URL('./smoke.sql', import.meta.url), 'utf8'));
  console.log('The script did not roll back as expected.');
} catch (e) { console.log(e.message); }
const left = await db.admin.query(`select (select count(*) from public.clinics) as clinics, (select count(*) from auth.users) as users`);
console.log('left behind:', JSON.stringify(left.rows[0]));
await db.stop();
