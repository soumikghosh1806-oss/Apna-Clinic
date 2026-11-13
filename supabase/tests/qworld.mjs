// A clinic just for queue tests, with a helper that makes a fresh doctor (and a login for them) per test,
// so every test starts with empty queues and does not depend on the others.
import { ok, nextPhone, NOW, TODAY, TOMORROW, GENERAL_SESSIONS } from './world.mjs';

// Names may not contain digits, so counters are turned into letters.
const letters = (n) => String(n).split('').map((d) => 'abcdefghij'[Number(d)]).join('');

export async function buildQueueWorld(db) {
  const { as, rpc, service } = db;
  const owner = await db.createUser('q-owner@test.local', 'Queue Owner');
  const recep = await db.createUser('q-recep@test.local', 'Queue Reception');
  const reg = ok(await rpc(as(owner), 'register_clinic', { p_clinic_name: 'Queue Clinic', p_slug: 'queue-clinic', p_owner_name: 'Queue Owner' }));
  const clinic = reg.clinic.id;
  ok(await rpc(service, 'attach_staff', { p_clinic: clinic, p_user_id: recep, p_role: 'receptionist', p_doctor_id: null, p_invited_by: owner }));
  const ownerW = as(owner);
  const recepW = as(recep);
  let n = 0;

  const q = {
    clinic, slug: 'queue-clinic', owner, recep, ownerW, recepW, TODAY, TOMORROW,

    async newDoctor(over = {}) {
      n += 1;
      const d = ok(await rpc(ownerW, 'add_doctor', {
        p_clinic: clinic, p_name: over.name ?? `Dr Test ${letters(n)}`, p_opd: over.opd ?? `OPD ${n}`, p_sessions: over.sessions ?? GENERAL_SESSIONS,
        p_daily_limit: over.limit ?? null, p_minutes_per_patient: over.minutes ?? null,
      })).doctor;
      const user = await db.createUser(`q-doc-${n}@test.local`, d.name);
      ok(await rpc(service, 'attach_staff', { p_clinic: clinic, p_user_id: user, p_role: 'doctor', p_doctor_id: d.id, p_invited_by: owner }));
      return { id: d.id, user, who: as(user), name: d.name };
    },

    book: (doc, over = {}) => rpc(db.anon, 'book_token', {
      p_slug: 'queue-clinic', p_name: over.name ?? `Patient ${letters(++n)}`, p_phone: over.phone ?? nextPhone(), p_doctor_id: doc.id, p_date: over.date ?? TODAY,
    }),
    walkIn: (doc, over = {}) => rpc(recepW, 'add_walk_in', {
      p_clinic: clinic, p_name: over.name ?? `Walker ${letters(++n)}`, p_phone: over.phone ?? nextPhone(), p_doctor_id: doc.id, p_allow_over_limit: over.over ?? false,
    }),
    async snapshot() { return ok(await rpc(recepW, 'get_staff_snapshot', { p_clinic: clinic })); },
    /** Tokens of one doctor and day, in number order. */
    async tokens(doc, date = TODAY) { return (await q.snapshot()).tokens.filter((t) => t.doctor_id === doc.id && t.date === date).sort((a, b) => a.number - b.number); },
    async token(doc, number, date = TODAY) { return (await q.tokens(doc, date)).find((t) => t.number === number); },
    async id(doc, number, date = TODAY) { return (await q.token(doc, number, date)).id; },
    async accessKey(tokenId) { return (await db.admin.query('select access_key from public.queue_tokens where id = $1', [tokenId])).rows[0].access_key; },
    next: (doc, expected = null) => rpc(doc.who, 'call_next', { p_doctor_id: doc.id, p_expected_current: expected }),
    act: (who, fn, tokenId) => rpc(who, fn, { p_token_id: tokenId }),
    settings: (over = {}) => rpc(ownerW, 'update_clinic_settings', {
      p_clinic: clinic, p_clinic_name: 'Queue Clinic', p_online_booking_enabled: over.online ?? true, p_default_daily_limit: over.limit ?? 100,
      p_default_minutes_per_patient: over.minutes ?? 10, p_max_online_bookings_per_phone: over.phoneCap ?? 4,
    }),
    /** Moves the test clock. Offsets are seconds after the standard test time (11:00 in Kolkata). */
    async tick(seconds) { await db.setNow(new Date(Date.parse(NOW) + seconds * 1000).toISOString()); },
    async reset() { await db.setNow(NOW); await q.settings(); },
  };
  return q;
}
