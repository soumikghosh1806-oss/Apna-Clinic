// Migration 9: the public clinic directory, one time codes (OTP), phone verified booking and own position,
// the public queue estimate, and the privacy rules around all of them.
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { failure } from './harness.mjs';
import { ok, refused, nextPhone, NOW, TODAY, TOMORROW } from './world.mjs';

const letters = (n) => String(n).split('').map((d) => 'abcdefghij'[Number(d)]).join('');
const PRIVATE_PHONE = '9000000077'; // the number the owner registered with. It must never reach the public.
// Stands in for the Edge Function's keyed hash. It never contains the code itself.
const HASH = (code) => `h:${createHmac('sha256', 'test-secret').update(String(code)).digest('hex')}`;

export function directoryTests(ctx) {
  describe('public directory, one time codes and phone verified booking', () => {
    let db, as, rpc, service;
    let s, h, u; // clinics: Sunrise (listed), Harbour (listed, closed today), Unlisted
    let n = 0;

    const owner = (c) => as(c.owner);
    const search = (args = {}) => rpc(db.anon, 'directory_search', {
      p_query: args.q ?? null, p_specialization: args.sp ?? null, p_doctor: args.dn ?? null, p_limit: args.limit ?? 12, p_offset: args.offset ?? 0 });
    const names = (r) => r.clinics.map((c) => c.name);
    const bookAt = (c, doctor, over = {}) => rpc(db.anon, 'book_token', {
      p_slug: c.slug, p_name: over.name ?? `Guest ${letters(++n)}`, p_phone: over.phone ?? nextPhone(), p_doctor_id: doctor.id,
      p_date: over.date ?? TODAY, p_session_start: null, p_verification: over.verification ?? null, p_email: over.email ?? null });
    /** Runs the whole code exchange the way the Edge Function does and returns the verification id. */
    async function verify(phone, channel = 'sms', code = '482913') {
      const begun = ok(await rpc(service, 'otp_begin', { p_phone: phone, p_channel: channel, p_ip_hash: null }));
      ok(await rpc(service, 'otp_set_hash', { p_challenge: begun.challenge_id, p_hash: HASH(code) }));
      ok(await rpc(service, 'otp_check', { p_challenge: begun.challenge_id, p_hash: HASH(code) }));
      return begun.challenge_id;
    }
    const setPublic = (c, over = {}) => rpc(owner(c), 'update_public_settings', {
      p_clinic: c.id, p_listed: over.listed ?? true, p_city: over.city ?? c.city, p_address: over.address ?? c.address, p_phone: over.phone ?? c.publicPhone,
      p_require_otp: over.otp ?? false });

    async function makeClinic(key, name, slug, city, address, publicPhone, doctors) {
      const user = await db.createUser(`dir-${key}@test.local`, `Owner ${key}`.replace(/\d/g, ''));
      const reg = ok(await rpc(as(user), 'register_clinic', { p_clinic_name: name, p_slug: slug, p_owner_name: 'Dir Owner', p_phone: PRIVATE_PHONE, p_city: city }));
      const c = { id: reg.clinic.id, slug, name, owner: user, city, address, publicPhone, doctors: [] };
      for (const [dn, spec, opd] of doctors) {
        const d = ok(await rpc(as(user), 'add_doctor', { p_clinic: c.id, p_name: dn, p_opd: opd, p_sessions: [{ start: '10:00', end: '14:00' }], p_daily_limit: null, p_minutes_per_patient: 10 })).doctor;
        await db.admin.query('update public.doctors set specialization = $1 where id = $2', [spec, d.id]);
        const login = await db.createUser(`dir-doc-${++n}@test.local`, dn);
        ok(await rpc(service, 'attach_staff', { p_clinic: c.id, p_user_id: login, p_role: 'doctor', p_doctor_id: d.id, p_invited_by: user }));
        c.doctors.push({ id: d.id, name: dn, who: as(login) });
      }
      return c;
    }

    before(async () => {
      db = ctx.db; ({ as, rpc, service } = db);
      s = await makeClinic('s', 'Sunrise Skin Centre', 'sunrise-skin', 'Pune', '12 MG Road, Camp', '+91 20 5550 1234',
        [['Dr Meera Skin', 'Dermatologist', 'Skin OPD'], ['Dr Ravi Hair', 'dermatologist', 'Hair OPD']]);
      h = await makeClinic('h', 'Harbour Heart Clinic', 'harbour-heart', 'Mumbai', '5 Marine Drive', null, [['Dr Neel Heart', 'Cardiologist', 'Heart OPD']]);
      u = await makeClinic('u', 'Hidden Family Clinic', 'hidden-family', 'Pune', '1 Quiet Lane', null, [['Dr Uma Quiet', 'Paediatrician', 'Child OPD']]);
    });
    afterEach(async () => { await db.setNow(NOW); });

    // ---------------------------------------------------------------------------------------------------------
    it('lists nothing until an owner opts in: clinics are private by default', async () => {
      const r = ok(await search());
      assert.equal(r.total, 0);
      assert.deepEqual(r.clinics, []);
      assert.equal(ok(await rpc(db.anon, 'directory_filters', {})).specializations.length, 0);
    });

    it('lets only the owner change the public profile, and checks it', async () => {
      const args = (c, over = {}) => ({ p_clinic: c.id, p_listed: true, p_city: c.city, p_address: c.address, p_phone: c.publicPhone, p_require_otp: false, ...over });
      refused(await rpc(s.doctors[0].who, 'update_public_settings', args(s)), 'forbidden'); // a doctor is not the owner
      refused(await rpc(as(h.owner), 'update_public_settings', args(s)), 'forbidden');        // another clinic's owner
      await failure(rpc(db.anon, 'update_public_settings', args(s)));
      await failure(rpc(db.anon, 'get_public_settings', { p_clinic: s.id }));
      refused(await rpc(as(h.owner), 'get_public_settings', { p_clinic: s.id }), 'forbidden');

      const bad = refused(await rpc(owner(s), 'update_public_settings', args(s, { p_city: null, p_address: null })), 'invalid_input');
      assert.ok(bad.field_errors.city);
      assert.ok(refused(await rpc(owner(s), 'update_public_settings', args(s, { p_phone: 'call me maybe' })), 'invalid_input').field_errors.phone);
      assert.ok(refused(await rpc(owner(s), 'update_public_settings', args(s, { p_address: 'x'.repeat(161) })), 'invalid_input').field_errors.address);
      assert.equal(ok(await rpc(owner(s), 'get_public_settings', { p_clinic: s.id })).listed, false, 'refused changes leave it unlisted');

      ok(await setPublic(s));
      ok(await setPublic(h, { phone: null }));
      const got = ok(await rpc(owner(s), 'get_public_settings', { p_clinic: s.id }));
      assert.deepEqual([got.listed, got.city, got.address, got.phone, got.require_phone_otp], [true, 'Pune', '12 MG Road, Camp', '+91 20 5550 1234', false]);
      // Someone signed in who works nowhere near this clinic cannot read its settings either.
      const stranger = await db.createUser(`peek-${++n}@test.local`, 'Peek Stranger');
      refused(await rpc(as(stranger), 'get_public_settings', { p_clinic: s.id }), 'forbidden');
      const audit = await db.admin.query(`select 1 from public.audit_log where clinic_id = $1 and action = 'clinic.public_settings'`, [s.id]);
      assert.ok(audit.rows.length >= 1);
    });

    it('refuses to list a clinic that has no active doctor', async () => {
      const lonely = await db.createUser('dir-lonely@test.local', 'Lonely Owner');
      const reg = ok(await rpc(as(lonely), 'register_clinic', { p_clinic_name: 'Empty Clinic', p_slug: 'empty-clinic', p_owner_name: 'Lonely Owner' }));
      const r = refused(await rpc(as(lonely), 'update_public_settings', { p_clinic: reg.clinic.id, p_listed: true, p_city: 'Pune', p_address: null, p_phone: null, p_require_otp: false }), 'invalid_input');
      assert.match(r.message, /at least one doctor/);
    });

    // ---------------------------------------------------------------------------------------------------------
    it('lists only opted in clinics, and shows nothing private about them', async () => {
      const r = ok(await search());
      assert.deepEqual(names(r).sort(), ['Harbour Heart Clinic', 'Sunrise Skin Centre']);
      assert.equal(r.total, 2);
      const text = JSON.stringify(r);
      for (const secret of [PRIVATE_PHONE, 'test.local', 'created_by', 'access_key', 'Dir Owner', 'Hidden Family', 'Dr Uma Quiet', s.owner, h.owner]) {
        assert.ok(!text.includes(secret), `${secret} leaked into the directory`);
      }
      const sunrise = r.clinics.find((c) => c.slug === 'sunrise-skin');
      assert.deepEqual([sunrise.city, sunrise.address, sunrise.phone], ['Pune', '12 MG Road, Camp', '+91 20 5550 1234']);
      assert.equal(r.clinics.find((c) => c.slug === 'harbour-heart').phone, undefined, 'no public phone unless the owner gave one');
      // Only these keys may ever appear, so a new column can never leak by accident.
      const within = (obj, allowed, label) => assert.deepEqual(Object.keys(obj).filter((k) => !allowed.includes(k)), [], `${label} has an unexpected key`);
      within(sunrise, ['slug', 'name', 'city', 'address', 'state', 'phone', 'any_open', 'doctors'], 'a clinic');
      for (const c of r.clinics) for (const d of c.doctors) within(d, ['id', 'name', 'opd', 'specialization', 'today', 'queue'], 'a doctor');
      within(sunrise.doctors[0].queue, ['status', 'waiting_count', 'current_number', 'consulting'], 'a queue');
      for (const key of ['slug', 'name', 'any_open', 'doctors']) assert.ok(key in sunrise, `${key} is missing`);
    });

    it('searches by name or location, ignores case, and treats symbols as plain text', async () => {
      assert.deepEqual(names(ok(await search({ q: 'SUNRISE' }))), ['Sunrise Skin Centre']);
      assert.deepEqual(names(ok(await search({ q: 'mumbai' }))), ['Harbour Heart Clinic']);
      assert.deepEqual(names(ok(await search({ q: 'marine drive' }))), ['Harbour Heart Clinic']);
      assert.deepEqual(names(ok(await search({ q: 'pune' }))), ['Sunrise Skin Centre'], 'an unlisted clinic in Pune stays hidden');
      assert.deepEqual(ok(await search({ q: 'nowhere at all' })).clinics, []);
      // % and _ are not wildcards.
      assert.deepEqual(ok(await search({ q: '%%' })).clinics, []);
      assert.deepEqual(ok(await search({ q: '__' })).clinics, []);
      assert.deepEqual(ok(await search({ q: "x'; drop table clinics; --" })).clinics, []);
      refused(await search({ q: 'a' }), 'invalid_input');
      refused(await search({ q: 'a'.repeat(61) }), 'invalid_input');
      refused(await search({ dn: 'a' }), 'invalid_input');
    });

    it('filters by specialisation and doctor, showing only the matching doctors', async () => {
      const filters = ok(await rpc(db.anon, 'directory_filters', {}));
      assert.deepEqual(filters.specializations, ['Cardiologist', 'Dermatologist'], 'tidy, sorted, once each, listed clinics only');
      const derm = ok(await search({ sp: 'DERMATOLOGIST' }));
      assert.deepEqual(names(derm), ['Sunrise Skin Centre']);
      assert.equal(derm.clinics[0].doctors.length, 2);
      const one = ok(await search({ dn: 'meera' }));
      assert.deepEqual(one.clinics[0].doctors.map((d) => d.name), ['Dr Meera Skin']);
      assert.deepEqual(names(ok(await search({ sp: 'cardiologist', dn: 'neel' }))), ['Harbour Heart Clinic']);
      assert.deepEqual(ok(await search({ sp: 'Dermatologist', dn: 'neel' })).clinics, []);
      assert.deepEqual(ok(await search({ sp: 'Paediatrician' })).clinics, [], 'an unlisted clinic never matches a filter');
    });

    it('shows availability and the live queue for each doctor, with open clinics first, and pages', async () => {
      // Harbour's doctor is on leave today: the clinic is listed but not open.
      ok(await rpc(owner(h), 'add_schedule_exception', { p_clinic: h.id, p_doctor_id: h.doctors[0].id, p_kind: 'closed', p_start: TODAY, p_end: TODAY, p_sessions: [], p_reason: 'Private reason', p_confirm: false }));
      const r = ok(await search());
      assert.deepEqual(names(r), ['Sunrise Skin Centre', 'Harbour Heart Clinic'], 'clinics with an open doctor come first');
      const harbour = r.clinics[1];
      assert.equal(harbour.any_open, false);
      assert.equal(harbour.doctors[0].today.open, false);
      assert.equal(harbour.doctors[0].today.reason, 'closed');
      assert.equal(harbour.doctors[0].queue.status.code, 'closed');
      assert.ok(!JSON.stringify(r).includes('Private reason'));

      // A patient books, arrives, and is called: the directory shows the queue move, with numbers only.
      const meera = s.doctors[0];
      const a = ok(await bookAt(s, meera, { name: 'Queue Walker Alpha', phone: '9811100001' }));
      ok(await bookAt(s, meera, { name: 'Queue Walker Beta', phone: '9811100002' }));
      ok(await rpc(meera.who, 'call_next', { p_doctor_id: meera.id, p_expected_current: null }));
      const live = ok(await search({ dn: 'meera' })).clinics[0].doctors[0];
      assert.equal(live.queue.consulting, true);
      assert.equal(live.queue.current_number, 1);
      assert.equal(live.queue.waiting_count, 1);
      assert.equal(live.queue.status.code, 'running');
      assert.ok(live.today.open);
      const text = JSON.stringify(ok(await search()));
      for (const secret of ['Queue Walker', '98111000', a.access_key]) assert.ok(!text.includes(secret), `${secret} leaked`);

      const page1 = ok(await search({ limit: 1, offset: 0 }));
      const page2 = ok(await search({ limit: 1, offset: 1 }));
      assert.deepEqual([page1.total, page1.clinics.length, page2.clinics.length], [2, 1, 1]);
      assert.notEqual(names(page1)[0], names(page2)[0]);
      assert.equal(ok(await search({ limit: 1000 })).limit, 20, 'a page never exceeds 20 clinics');
    });

    it('hides a clinic again as soon as it is unlisted, and never lists one whose doctors are all removed', async () => {
      ok(await setPublic(h, { listed: false, phone: null }));
      assert.deepEqual(names(ok(await search())), ['Sunrise Skin Centre']);
      ok(await setPublic(h, { phone: null }));
      assert.equal(ok(await search()).total, 2);
    });

    // ---------------------------------------------------------------------------------------------------------
    it('issues, checks and expires one time codes, never storing a code, and keeps browsers away from them', async () => {
      const phone = nextPhone();
      refused(await rpc(service, 'otp_begin', { p_phone: '12345', p_channel: 'sms', p_ip_hash: null }), 'invalid_input');
      refused(await rpc(service, 'otp_begin', { p_phone: phone, p_channel: 'carrier pigeon', p_ip_hash: null }), 'invalid_input');
      const begun = ok(await rpc(service, 'otp_begin', { p_phone: `+91 ${phone}`, p_channel: 'sms', p_ip_hash: 'ip-1' }));
      assert.equal(begun.phone, phone, 'the number is stored in its plain 10 digit form');
      // A code that was never given a hash cannot be satisfied.
      refused(await rpc(service, 'otp_check', { p_challenge: begun.challenge_id, p_hash: HASH('000000') }), 'otp_expired');
      ok(await rpc(service, 'otp_set_hash', { p_challenge: begun.challenge_id, p_hash: HASH('111222') }));
      refused(await rpc(service, 'otp_set_hash', { p_challenge: begun.challenge_id, p_hash: HASH('999999') }), 'not_found'); // set once

      const wrong = refused(await rpc(service, 'otp_check', { p_challenge: begun.challenge_id, p_hash: HASH('000000') }), 'otp_invalid');
      assert.equal(wrong.attempts_left, 4);
      assert.ok(wrong.field_errors.code);
      const right = ok(await rpc(service, 'otp_check', { p_challenge: begun.challenge_id, p_hash: HASH('111222') }));
      assert.deepEqual([right.phone, right.channel], [phone, 'sms']);
      // Checking again, once verified, is harmless.
      ok(await rpc(service, 'otp_check', { p_challenge: begun.challenge_id, p_hash: HASH('whatever') }));

      const stored = (await db.admin.query('select code_hash, phone from public.booking_verifications where id = $1', [begun.challenge_id])).rows[0];
      assert.equal(stored.code_hash, HASH('111222'));
      assert.ok(!Object.values(stored).some((v) => String(v).includes('111222')), 'the code itself is never held');

      for (const who of [db.anon, as(s.owner)]) {
        for (const [fn, args] of [['otp_begin', { p_phone: phone, p_channel: 'sms', p_ip_hash: null }], ['otp_check', { p_challenge: begun.challenge_id, p_hash: 'x' }],
          ['otp_set_hash', { p_challenge: begun.challenge_id, p_hash: 'x' }], ['otp_cancel', { p_challenge: begun.challenge_id }], ['booking_email_context', { p_access_key: begun.challenge_id }]]) {
          await failure(rpc(who, fn, args));
        }
        await failure(db.query(who, 'select * from public.booking_verifications limit 1'));
      }
    });

    it('stops guessing after five tries and expires codes after ten minutes', async () => {
      const phone = nextPhone();
      const begun = ok(await rpc(service, 'otp_begin', { p_phone: phone, p_channel: 'sms', p_ip_hash: null }));
      ok(await rpc(service, 'otp_set_hash', { p_challenge: begun.challenge_id, p_hash: HASH('246810') }));
      for (let i = 0; i < 5; i += 1) refused(await rpc(service, 'otp_check', { p_challenge: begun.challenge_id, p_hash: HASH(`00000${i}`) }), 'otp_invalid');
      // Five wrong tries burn the code, even for the right answer.
      refused(await rpc(service, 'otp_check', { p_challenge: begun.challenge_id, p_hash: HASH('246810') }), 'otp_expired');

      const second = ok(await rpc(service, 'otp_begin', { p_phone: phone, p_channel: 'sms', p_ip_hash: null }));
      ok(await rpc(service, 'otp_set_hash', { p_challenge: second.challenge_id, p_hash: HASH('135790') }));
      await db.setNow(new Date(Date.parse(NOW) + 11 * 60_000).toISOString());
      refused(await rpc(service, 'otp_check', { p_challenge: second.challenge_id, p_hash: HASH('135790') }), 'otp_expired');
    });

    it('limits how many codes one phone number or one connection can ask for', async () => {
      const phone = nextPhone();
      for (let i = 0; i < 3; i += 1) ok(await rpc(service, 'otp_begin', { p_phone: phone, p_channel: 'sms', p_ip_hash: null }));
      const limited = refused(await rpc(service, 'otp_begin', { p_phone: phone, p_channel: 'sms', p_ip_hash: null }), 'rate_limited');
      assert.match(limited.message, /10 minutes/);
      await db.setNow(new Date(Date.parse(NOW) + 11 * 60_000).toISOString());
      ok(await rpc(service, 'otp_begin', { p_phone: phone, p_channel: 'sms', p_ip_hash: null }));

      await db.setNow(NOW);
      for (let i = 0; i < 20; i += 1) ok(await rpc(service, 'otp_begin', { p_phone: nextPhone(), p_channel: 'sms', p_ip_hash: 'ip-busy' }));
      refused(await rpc(service, 'otp_begin', { p_phone: nextPhone(), p_channel: 'sms', p_ip_hash: 'ip-busy' }), 'rate_limited');
      ok(await rpc(service, 'otp_begin', { p_phone: nextPhone(), p_channel: 'sms', p_ip_hash: 'ip-other' }));

      // The address a code goes to is limited too: different phone numbers cannot flood one inbox.
      for (let i = 0; i < 5; i += 1) ok(await rpc(service, 'otp_begin', { p_phone: nextPhone(), p_channel: 'email', p_ip_hash: null, p_target_hash: 'inbox-1' }));
      const flood = refused(await rpc(service, 'otp_begin', { p_phone: nextPhone(), p_channel: 'email', p_ip_hash: null, p_target_hash: 'inbox-1' }), 'rate_limited');
      assert.match(flood.message, /this address/);
      ok(await rpc(service, 'otp_begin', { p_phone: nextPhone(), p_channel: 'email', p_ip_hash: null, p_target_hash: 'inbox-2' }));
      await db.setNow(new Date(Date.parse(NOW) + 61 * 60_000).toISOString());
      ok(await rpc(service, 'otp_begin', { p_phone: nextPhone(), p_channel: 'email', p_ip_hash: null, p_target_hash: 'inbox-1' }));
    });

    it('drops a code that could not be sent, so it neither counts against the person nor stays valid', async () => {
      const phone = nextPhone();
      const begun = ok(await rpc(service, 'otp_begin', { p_phone: phone, p_channel: 'sms', p_ip_hash: null }));
      ok(await rpc(service, 'otp_set_hash', { p_challenge: begun.challenge_id, p_hash: HASH('777777') }));
      ok(await rpc(service, 'otp_cancel', { p_challenge: begun.challenge_id }));
      refused(await rpc(service, 'otp_check', { p_challenge: begun.challenge_id, p_hash: HASH('777777') }), 'otp_expired');
      assert.equal((await db.admin.query('select count(*)::int n from public.booking_verifications where phone = $1', [phone])).rows[0].n, 0);
    });

    // ---------------------------------------------------------------------------------------------------------
    it('books without a code by default, exactly as before', async () => {
      const d = s.doctors[1];
      const r = ok(await bookAt(s, d));
      assert.ok(r.access_key);
      assert.equal(r.token.patient_id, undefined);
      // A made up verification does not get through, even when the clinic does not ask for one.
      refused(await bookAt(s, d, { verification: '11111111-1111-4111-8111-111111111111' }), 'otp_expired');
    });

    it('requires a verified code for the same phone when the clinic asks for it, and limits how often one code is used', async () => {
      const d = s.doctors[1];
      ok(await setPublic(s, { otp: true }));
      assert.equal(ok(await rpc(owner(s), 'get_public_settings', { p_clinic: s.id })).require_phone_otp, true);
      try {
        const phone = nextPhone();
        assert.equal(refused(await bookAt(s, d, { phone }), 'otp_required').code, 'otp_required');
        // An unfinished challenge (code not entered yet) is not a verification.
        const open = ok(await rpc(service, 'otp_begin', { p_phone: phone, p_channel: 'sms', p_ip_hash: null }));
        ok(await rpc(service, 'otp_set_hash', { p_challenge: open.challenge_id, p_hash: HASH('333444') }));
        refused(await bookAt(s, d, { phone, verification: open.challenge_id }), 'otp_expired');

        const v = await verify(phone);
        // A verification is for one number only.
        const other = refused(await bookAt(s, d, { phone: nextPhone(), verification: v }), 'otp_invalid');
        assert.ok(other.field_errors.phone);
        ok(await bookAt(s, d, { phone, name: 'Family One', verification: v }));
        ok(await bookAt(s, d, { phone, name: 'Family Two', verification: v }));
        ok(await bookAt(s, d, { phone, name: 'Family Three', verification: v }));
        ok(await bookAt(s, d, { phone, name: 'Family Four', verification: v }));
        refused(await bookAt(s, d, { phone, name: 'Family Five', verification: v }), 'otp_expired');

        // It also runs out with time: 30 minutes after the code was entered.
        const v2 = await verify(nextPhone(), 'sms', '555666');
        const phone2 = (await db.admin.query('select phone from public.booking_verifications where id = $1', [v2])).rows[0].phone;
        await db.setNow(new Date(Date.parse(NOW) + 31 * 60_000).toISOString());
        refused(await bookAt(s, d, { phone: phone2, verification: v2 }), 'otp_expired');
        await db.setNow(NOW);

        // A code sent by email also proves a live contact for booking.
        const phone3 = nextPhone();
        const v3 = await verify(phone3, 'email', '909090');
        ok(await bookAt(s, d, { phone: phone3, verification: v3 }));
      } finally {
        ok(await setPublic(s, { otp: false }));
      }
    });

    it('keeps an optional email with the patient, checks it, and never returns it', async () => {
      const d = s.doctors[1];
      const bad = refused(await bookAt(s, d, { email: 'not-an-email' }), 'invalid_input');
      assert.ok(bad.field_errors.email);
      const r = ok(await bookAt(s, d, { name: 'Email Person', email: 'person@example.test' }));
      const row = (await db.admin.query(`select p.email from public.patients p join public.queue_tokens t on t.patient_id = p.id where t.access_key = $1`, [r.access_key])).rows[0];
      assert.equal(row.email, 'person@example.test');
      assert.ok(!JSON.stringify(r).includes('example.test'));
      assert.ok(!JSON.stringify(ok(await rpc(db.anon, 'get_my_token', { p_access_key: r.access_key }))).includes('example.test'));
      // Only the function the email sender uses can read it, by the patient's own key.
      const ctxRow = ok(await rpc(service, 'booking_email_context', { p_access_key: r.access_key }));
      assert.deepEqual([ctxRow.email, ctxRow.first_name, ctxRow.clinic_name, ctxRow.doctor, ctxRow.number], ['person@example.test', 'Email', 'Sunrise Skin Centre', 'Dr Ravi Hair', r.token.number]);
      refused(await rpc(service, 'booking_email_context', { p_access_key: '22222222-2222-4222-8222-222222222222' }), 'not_found');
      const snapshot = JSON.stringify(ok(await rpc(owner(s), 'get_staff_snapshot', { p_clinic: s.id })));
      assert.ok(!snapshot.includes('example.test'), 'staff screens do not carry the email either');
    });

    // ---------------------------------------------------------------------------------------------------------
    it('shows a patient their own place after a text message code, and nobody else\'s', async () => {
      const d = s.doctors[1];
      const phone = nextPhone();
      const mine = ok(await bookAt(s, d, { name: 'My Own Token', phone }));
      const theirs = ok(await bookAt(s, d, { name: 'Someone Else', phone: nextPhone() }));
      const v = await verify(phone);
      const r = ok(await rpc(db.anon, 'get_my_position', { p_slug: s.slug, p_doctor_id: d.id, p_verification: v }));
      assert.equal(r.tokens.length, 1);
      assert.equal(r.tokens[0].number, mine.token.number);
      assert.equal(r.tokens[0].status, 'waiting');
      assert.ok(Number.isInteger(r.tokens[0].view.patients_ahead));
      assert.ok(r.tokens[0].view.estimated_time.at, 'an estimated time, which the screen labels as an estimate');
      const text = JSON.stringify(r);
      for (const secret of ['My Own Token', 'Someone Else', phone, mine.access_key, theirs.access_key]) assert.ok(!text.includes(secret), `${secret} leaked`);

      // A verified number with nothing booked sees an empty list, not an error that hints at who is booked.
      const empty = ok(await rpc(db.anon, 'get_my_position', { p_slug: s.slug, p_doctor_id: d.id, p_verification: await verify(nextPhone(), 'sms', '121212') }));
      assert.deepEqual(empty.tokens, []);
    });

    it('does not show a place without a verified text message code', async () => {
      const d = s.doctors[1];
      const phone = nextPhone();
      ok(await bookAt(s, d, { phone }));
      const asked = (verification) => rpc(db.anon, 'get_my_position', { p_slug: s.slug, p_doctor_id: d.id, p_verification: verification });
      assert.equal(refused(await asked(null)).code, 'otp_required');
      refused(await asked('33333333-3333-4333-8333-333333333333'), 'otp_expired');
      refused(await asked(await verify(phone, 'email', '808080')), 'otp_expired'); // an emailed code does not prove a phone
      const unfinished = ok(await rpc(service, 'otp_begin', { p_phone: phone, p_channel: 'sms', p_ip_hash: null }));
      refused(await asked(unfinished.challenge_id), 'otp_expired');
      const v = await verify(phone, 'sms', '131313');
      ok(await asked(v));
      await db.setNow(new Date(Date.parse(NOW) + 31 * 60_000).toISOString());
      refused(await asked(v), 'otp_expired');
      refused(await rpc(db.anon, 'get_my_position', { p_slug: 'no-such-clinic', p_doctor_id: d.id, p_verification: v }), 'not_found');
    });

    // ---------------------------------------------------------------------------------------------------------
    it('gives the public queue an estimate for a new booking, marks whether the queue is open, and still names no one', async () => {
      const d = s.doctors[1];
      const q = async () => ok(await rpc(db.anon, 'get_public_queue', { p_slug: s.slug, p_doctor_id: d.id, p_date: TODAY }));
      const before = await q();
      assert.equal(before.estimate.minutes_per_patient, 10);
      assert.equal(before.estimate.queue_open, true);
      const waiting = before.board.waiting_count;
      assert.equal(before.estimate.wait_for_new_booking_minutes, waiting * 10 + (before.board.consulting ? 10 : 0));
      assert.equal(before.doctor.specialization, 'dermatologist', 'shown as the clinic typed it');

      // Tomorrow can be booked but its queue has not started; a day of leave closes it.
      const tomorrow = ok(await rpc(db.anon, 'get_public_queue', { p_slug: s.slug, p_doctor_id: d.id, p_date: TOMORROW }));
      assert.equal(tomorrow.board.status.code, 'scheduled');
      assert.equal(tomorrow.estimate.queue_open, true);
      ok(await rpc(owner(s), 'add_schedule_exception', { p_clinic: s.id, p_doctor_id: d.id, p_kind: 'closed', p_start: TOMORROW, p_end: TOMORROW, p_sessions: [], p_reason: 'Private note', p_confirm: false }));
      const closed = ok(await rpc(db.anon, 'get_public_queue', { p_slug: s.slug, p_doctor_id: d.id, p_date: TOMORROW }));
      assert.equal(closed.estimate.queue_open, false);
      assert.equal(closed.board.status.code, 'closed');
      assert.ok(!JSON.stringify(closed).includes('Private note'), 'the owner\'s private reason stays private');
      const text = JSON.stringify(await q());
      assert.ok(!/Guest|Email Person|My Own Token|access_key|phone|9[0-9]{9}/.test(text), text.slice(0, 300));
    });

    // ---------------------------------------------------------------------------------------------------------
    it('stops signed in staff from reading the secret key of a token, but not the rest of the queue', async () => {
      const d = s.doctors[1];
      const r = ok(await bookAt(s, d));
      assert.ok(r.access_key);
      const ownerWho = as(s.owner);
      for (const who of [ownerWho, d.who]) {
        await failure(db.query(who, 'select access_key from public.queue_tokens limit 1'));
        await failure(db.query(who, 'select * from public.queue_tokens limit 1'));
        const rows = await db.query(who, 'select id, token_number, status from public.queue_tokens where clinic_id = $1', [s.id]);
        assert.ok(Array.isArray(rows), 'the rest of the queue stays readable');
        if (who === ownerWho) assert.ok(rows.length > 0);
      }
      // The staff screens carry no key either.
      assert.ok(!JSON.stringify(ok(await rpc(owner(s), 'get_staff_snapshot', { p_clinic: s.id }))).includes(r.access_key));
    });
  });
}
