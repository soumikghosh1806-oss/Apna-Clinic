import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ok, refused, nextPhone, TODAY, TOMORROW, NOW } from './world.mjs';
import { failure } from './harness.mjs';

export function queueTests(ctx) {
  const q = () => ctx.q;
  const db = () => ctx.db;

  describe('booking tokens', () => {
    beforeEach(async () => { await q().reset(); });

    it('gives the next number for that doctor and day, and numbers each day separately', async () => {
      const d = await q().newDoctor();
      const nums = [];
      for (let i = 0; i < 3; i += 1) nums.push(ok(await q().book(d)).token.number);
      assert.deepEqual(nums, [1, 2, 3]);
      assert.equal(ok(await q().book(d, { date: TOMORROW })).token.number, 1);
      const other = await q().newDoctor();
      assert.equal(ok(await q().book(other)).token.number, 1);
    });

    it('never repeats a number, even when a token is cancelled', async () => {
      const d = await q().newDoctor();
      ok(await q().book(d));
      const two = ok(await q().book(d));
      ok(await db().rpc(db().anon, 'cancel_my_token', { p_access_key: two.access_key }));
      assert.equal(ok(await q().book(d)).token.number, 3);
    });

    it('puts online and walk-in tokens in one queue with one numbering', async () => {
      const d = await q().newDoctor();
      assert.equal(ok(await q().book(d)).token.number, 1);
      const w = ok(await q().walkIn(d));
      assert.equal(w.token.number, 2);
      assert.equal(w.token.source, 'walk_in');
      assert.ok(w.token.arrived_at, 'a walk-in is at the clinic already');
      assert.equal(w.token.arrival_source, 'walk_in');
      assert.equal(ok(await q().book(d)).token.number, 3);
    });

    it('reuses the patient record for the same name and number, ignoring case and spacing', async () => {
      const d = await q().newDoctor();
      const phone = nextPhone();
      const first = ok(await q().book(d, { name: 'Meera  Nair', phone }));
      ok(await db().rpc(db().anon, 'cancel_my_token', { p_access_key: first.access_key }));
      ok(await q().book(d, { name: 'meera nair', phone: `+91 ${phone.slice(0, 5)}-${phone.slice(5)}` }));
      const { rows } = await db().admin.query(`select count(*)::int as n from public.patients where phone = $1`, [phone]);
      assert.equal(rows[0].n, 1);
    });

    it('refuses a second live token for the same patient, doctor and day, and points to the first', async () => {
      const d = await q().newDoctor();
      const phone = nextPhone();
      const first = ok(await q().book(d, { name: 'Dup Person', phone }));
      const second = refused(await q().book(d, { name: 'dup person', phone }), 'duplicate');
      assert.equal(second.existing_access_key, first.access_key);
      assert.equal(second.existing_token_id, undefined, 'the public never gets the internal id');
      assert.match(second.message, /#1/);
      // The same person may book another doctor, another day, or again after cancelling.
      const other = await q().newDoctor();
      ok(await q().book(other, { name: 'Dup Person', phone }));
      ok(await q().book(d, { name: 'Dup Person', phone, date: TOMORROW }));
      ok(await db().rpc(db().anon, 'cancel_my_token', { p_access_key: first.access_key }));
      ok(await q().book(d, { name: 'Dup Person', phone }));
    });

    it('allows family members with different names on one phone', async () => {
      const d = await q().newDoctor();
      const phone = nextPhone();
      ok(await q().book(d, { name: 'Anita Rao', phone }));
      ok(await q().book(d, { name: 'Dev Rao', phone }));
    });

    it('treats common ways of writing a mobile number as the same number', async () => {
      const d = await q().newDoctor();
      ok(await q().book(d, { name: 'Phone Format', phone: '98765 43210' }));
      for (const variant of ['+91 98765-43210', '09876543210', '919876543210', '(98765) 43210']) {
        refused(await q().book(d, { name: 'Phone Format', phone: variant }), 'duplicate');
      }
    });

    it('returns field errors for bad input and changes nothing', async () => {
      const d = await q().newDoctor();
      const before = (await q().tokens(d)).length;
      const r = refused(await q().book(d, { name: '', phone: '12345' }), 'invalid_input');
      assert.deepEqual(Object.keys(r.field_errors).sort(), ['name', 'phone']);
      for (const phone of ['5123456789', '98765', 'abcdefghij', '']) refused(await q().book(d, { phone }), 'invalid_input');
      for (const name of ['A', 'Ravi123', '<script>', '.Dot', '!!', 'x'.repeat(61)]) refused(await q().book(d, { name }), 'invalid_input');
      assert.equal((await q().tokens(d)).length, before);
      const patients = await db().admin.query(`select count(*)::int as n from public.patients where name in ('Ravi123', '<script>')`);
      assert.equal(patients.rows[0].n, 0);
    });

    it('accepts names in any script, with dots, hyphens and apostrophes', async () => {
      const d = await q().newDoctor();
      for (const name of ['अनिल शर्मा', 'অমিত রায়', 'José Ñuñez', "Mary O'Brien-Smith Jr.", 'முருகன்']) ok(await q().book(d, { name }));
    });

    it('only books today or tomorrow online, and walk-ins only for today', async () => {
      const d = await q().newDoctor();
      ok(await q().book(d, { date: TODAY }));
      ok(await q().book(d, { date: TOMORROW }));
      for (const date of ['2026-03-12', '2026-03-09', '2027-01-01']) refused(await q().book(d, { date }), 'invalid_date');
      refused(await db().rpc(db().anon, 'book_token', { p_slug: q().slug, p_name: 'No Date', p_phone: nextPhone(), p_doctor_id: d.id, p_date: null }), 'invalid_date');
    });

    it('refuses a doctor who is removed or who belongs to another clinic', async () => {
      const keep = await q().newDoctor();
      const gone = await q().newDoctor();
      ok(await db().rpc(q().ownerW, 'remove_doctor', { p_clinic: q().clinic, p_doctor_id: gone.id }));
      refused(await q().book(gone), 'doctor_unavailable');
      refused(await q().walkIn(gone), 'doctor_unavailable');
      refused(await db().rpc(db().anon, 'book_token', { p_slug: ctx.w.slugA, p_name: 'Cross Clinic', p_phone: nextPhone(), p_doctor_id: keep.id, p_date: TODAY }), 'doctor_unavailable');
      refused(await db().rpc(db().anon, 'book_token', { p_slug: 'no-such-clinic', p_name: 'Nobody', p_phone: nextPhone(), p_doctor_id: keep.id, p_date: TODAY }), 'not_found');
    });

    it('closes booking at the daily limit per doctor and day, and lets cancelled tokens free no number but do free a place', async () => {
      const d = await q().newDoctor({ limit: 3 });
      const keys = [];
      for (let i = 0; i < 3; i += 1) keys.push(ok(await q().book(d)).access_key);
      const full = refused(await q().book(d), 'full');
      assert.match(full.message, /All 3 tokens/);
      ok(await q().book(d, { date: TOMORROW }));
      ok(await db().rpc(db().anon, 'cancel_my_token', { p_access_key: keys[0] }));
      assert.equal(ok(await q().book(d)).token.number, 4, 'a place is free again but the number is new');
    });

    it('applies the clinic limit unless a doctor has their own', async () => {
      ok(await q().settings({ limit: 2 }));
      const clinicWide = await q().newDoctor();
      const own = await q().newDoctor({ limit: 4 });
      for (let i = 0; i < 2; i += 1) ok(await q().book(clinicWide));
      refused(await q().book(clinicWide), 'full');
      for (let i = 0; i < 4; i += 1) ok(await q().book(own));
      refused(await q().book(own), 'full');
    });

    it('lets reception go over the limit only when asked to', async () => {
      const d = await q().newDoctor({ limit: 1 });
      ok(await q().book(d));
      refused(await q().walkIn(d), 'full');
      const over = ok(await q().walkIn(d, { over: true }));
      assert.equal(over.token.number, 2);
      refused(await q().book(d), 'full');
    });

    it('stops online booking when switched off but still allows walk-ins', async () => {
      const d = await q().newDoctor();
      ok(await q().settings({ online: false }));
      refused(await q().book(d), 'online_disabled');
      ok(await q().walkIn(d));
      const page = ok(await db().rpc(db().anon, 'get_public_clinic', { p_slug: q().slug }));
      assert.equal(page.online_booking_enabled, false);
      assert.equal(page.doctors.find((x) => x.id === d.id).availability.today.reason, 'online_disabled');
    });

    it('only issues walk-in tokens for today', async () => {
      const d = await q().newDoctor();
      // add_walk_in has no date argument. Today is chosen by the server, so a walk-in can never be for another day.
      const r = ok(await q().walkIn(d));
      assert.equal(r.token.date, TODAY);
    });

    it('caps public bookings per mobile number per clinic day, but never blocks walk-ins', async () => {
      ok(await q().settings({ phoneCap: 3 }));
      const a = await q().newDoctor();
      const b = await q().newDoctor();
      const phone = nextPhone();
      ok(await q().book(a, { name: 'Cap One', phone }));
      ok(await q().book(b, { name: 'Cap Two', phone }));
      ok(await q().book(a, { name: 'Cap Three', phone, date: TOMORROW }));
      const blocked = refused(await q().book(b, { name: 'Cap Four', phone }), 'rate_limited');
      assert.match(blocked.message, /reception/i);
      ok(await q().walkIn(a, { name: 'Cap Five', phone }));
      ok(await q().book(a, { name: 'Other Phone', phone: nextPhone() }));
      // A new clinic day (Kolkata time) starts a new count.
      await q().tick(14 * 3600);
      ok(await q().book(b, { name: 'Cap Six', phone, date: '2026-03-11' }));
    });

    it('works out "today" in the clinic time zone, not UTC', async () => {
      const d = await q().newDoctor();
      await db().setNow('2026-03-10T19:00:00Z'); // 00:30 on the 11th in Kolkata
      refused(await q().book(d, { date: '2026-03-10' }), 'invalid_date');
      assert.equal(ok(await q().book(d, { date: '2026-03-11' })).token.date, '2026-03-11');
      assert.equal(ok(await q().book(d, { date: '2026-03-12' })).token.date, '2026-03-12');
      assert.equal(ok(await q().walkIn(d)).token.date, '2026-03-11');
      assert.equal(ok(await db().rpc(db().anon, 'get_public_clinic', { p_slug: q().slug })).today, '2026-03-11');
    });
  });

  describe('queue movement', () => {
    beforeEach(async () => { await q().reset(); });

    async function line(doc, count = 3) {
      for (let i = 0; i < count; i += 1) ok(await q().book(doc));
      return Promise.all(Array.from({ length: count }, (_, i) => q().id(doc, i + 1)));
    }

    it('NEXT calls the lowest waiting number first and notes that the doctor, not reception, recorded the arrival', async () => {
      const d = await q().newDoctor();
      await line(d);
      const r = ok(await q().next(d));
      assert.equal(r.called.number, 1);
      assert.equal(r.called.status, 'serving');
      assert.equal(r.called.arrival_source, 'doctor_call');
      assert.equal(r.completed, null);
    });

    it('NEXT completes the current patient, records exactly one visit and calls the next waiting token', async () => {
      const d = await q().newDoctor();
      const [one, two] = await line(d);
      ok(await db().rpc(q().recepW, 'mark_arrived', { p_token_id: two }));
      ok(await q().next(d));
      await q().tick(10);
      const r = ok(await q().next(d, one));
      assert.equal(r.completed.number, 1);
      assert.equal(r.completed.status, 'completed');
      assert.ok(r.completed.completed_at);
      assert.equal(r.called.number, 2);
      assert.equal(r.called.arrival_source, 'reception', 'an arrival reception recorded is kept');
      const visits = await db().admin.query('select title, doctor_id from public.visits where queue_token_id = $1', [one]);
      assert.equal(visits.rowCount, 1);
      assert.equal(visits.rows[0].title, 'Consultation');
      const appt = await db().admin.query(`select a.status from public.appointments a join public.queue_tokens t on t.appointment_id = a.id where t.id = $1`, [one]);
      assert.equal(appt.rows[0].status, 'completed');
    });

    it('ignores a NEXT press from an out of date screen', async () => {
      const d = await q().newDoctor();
      const [one, two] = await line(d);
      ok(await q().next(d));
      refused(await q().next(d, null), 'stale');           // screen still thinks nobody is being seen
      refused(await q().next(d, two), 'stale');            // screen is looking at the wrong token
      assert.equal((await q().token(d, 1)).status, 'serving');
      assert.equal((await q().token(d, 2)).status, 'waiting');
      assert.ok(one);
    });

    it('does not let a quick second press advance the patient who was just called', async () => {
      const d = await q().newDoctor();
      const [one] = await line(d);
      ok(await q().next(d));
      await q().tick(2);
      refused(await q().next(d, one), 'too_soon');
      assert.equal((await q().token(d, 1)).status, 'serving');
      await q().tick(4);
      ok(await q().next(d, one));
      assert.equal((await q().token(d, 1)).status, 'completed');
    });

    it('reports an empty queue, and completes the last patient when nobody is waiting', async () => {
      const d = await q().newDoctor();
      refused(await q().next(d), 'empty');
      const [one] = await line(d, 1);
      ok(await q().next(d));
      await q().tick(5);
      const r = ok(await q().next(d, one));
      assert.equal(r.completed.number, 1);
      assert.equal(r.called, null);
      refused(await q().next(d), 'empty');
    });

    it('skips the current patient, and reception can put them at the end of the line', async () => {
      const d = await q().newDoctor();
      const [one, two, three] = await line(d);
      ok(await q().next(d));
      const skipped = ok(await q().act(d.who, 'skip_token', one));
      assert.equal(skipped.token.status, 'skipped');
      const back = ok(await q().act(q().recepW, 'requeue_token', one));
      assert.equal(back.token.status, 'waiting');
      assert.equal(back.token.number, 1, 'the token number does not change');
      assert.ok(back.token.order_key > (await q().token(d, 3)).order_key, 'but the place in line does');
      const order = [];
      for (let i = 0; i < 3; i += 1) {
        const r = ok(await q().next(d, order.length === 0 ? null : (await q().tokens(d)).find((t) => t.status === 'serving')?.id ?? null));
        order.push(r.called.number);
        await q().tick(5 * (i + 1));
      }
      assert.deepEqual(order, [2, 3, 1]);
      assert.ok(two && three);
    });

    it('holds the current patient and resumes them to the front of the line', async () => {
      const d = await q().newDoctor();
      const [one] = await line(d);
      ok(await q().next(d));
      assert.equal(ok(await q().act(d.who, 'hold_token', one)).token.status, 'on_hold');
      ok(await q().next(d)); // doctor takes token 2 while 1 is away
      const resumed = ok(await q().act(d.who, 'resume_token', one));
      assert.equal(resumed.token.status, 'waiting');
      assert.ok(resumed.token.order_key < (await q().token(d, 3)).order_key, 'goes ahead of everyone waiting');
      const waiting = (await q().tokens(d)).filter((t) => t.status === 'waiting').sort((a, b) => a.order_key - b.order_key);
      assert.equal(waiting[0].number, 1);
    });

    it('refuses moves that do not make sense, and says why', async () => {
      const d = await q().newDoctor();
      const [one, two] = await line(d);
      for (const fn of ['complete_token', 'hold_token', 'resume_token']) refused(await q().act(d.who, fn, one), 'invalid_transition');
      refused(await q().act(q().recepW, 'requeue_token', one), 'invalid_transition');
      ok(await q().next(d));
      ok(await q().act(d.who, 'complete_token', one));
      const r = refused(await q().act(d.who, 'skip_token', one), 'invalid_transition');
      assert.match(r.message, /Token #1 cannot be skipped while it is completed/);
      refused(await q().act(q().recepW, 'mark_no_show', one), 'invalid_transition');
      refused(await db().rpc(db().anon, 'cancel_my_token', { p_access_key: await q().accessKey(one) }), 'invalid_transition');
      assert.ok(two);
    });

    it('marks arrival once, and lets a late arrival return after being marked no-show', async () => {
      const d = await q().newDoctor();
      const [one] = await line(d, 1);
      ok(await q().act(q().recepW, 'mark_arrived', one));
      const again = refused(await q().act(q().recepW, 'mark_arrived', one), 'invalid_transition');
      assert.match(again.message, /already marked as arrived/);
      assert.equal(ok(await q().act(q().recepW, 'mark_no_show', one)).token.status, 'no_show');
      const back = ok(await q().act(q().recepW, 'requeue_token', one));
      assert.equal(back.token.status, 'waiting');
      const appt = await db().admin.query(`select a.status from public.appointments a join public.queue_tokens t on t.appointment_id = a.id where t.id = $1`, [one]);
      assert.equal(appt.rows[0].status, 'booked');
    });

    it('will not requeue a token if the patient has since booked again', async () => {
      const d = await q().newDoctor();
      const phone = nextPhone();
      ok(await q().book(d, { name: 'Late Comer', phone }));
      const one = await q().id(d, 1);
      ok(await q().act(q().recepW, 'mark_no_show', one));
      ok(await q().book(d, { name: 'Late Comer', phone }));
      refused(await q().act(q().recepW, 'requeue_token', one), 'duplicate');
    });

    it('keeps the other doctor\'s queue untouched', async () => {
      const a = await q().newDoctor();
      const b = await q().newDoctor();
      await line(a);
      await line(b);
      ok(await q().next(a));
      assert.ok((await q().tokens(b)).every((t) => t.status === 'waiting'));
      refused(await q().next(b, await q().id(a, 1)), 'stale');
    });

    it('allows only one patient with a doctor at a time, enforced by the database', async () => {
      const d = await q().newDoctor();
      await line(d);
      ok(await q().next(d));
      const two = await q().id(d, 2);
      const e = await failure(db().admin.query(`update public.queue_tokens set status = 'serving' where id = $1`, [two]));
      assert.equal(e.code, '23505');
    });

    it('lets the patient cancel their own waiting token only', async () => {
      const d = await q().newDoctor();
      const b = ok(await q().book(d));
      const mine = ok(await db().rpc(db().anon, 'cancel_my_token', { p_access_key: b.access_key }));
      assert.deepEqual(mine.token, { number: 1, status: 'cancelled' });
      const appt = await db().admin.query(`select a.status from public.appointments a join public.queue_tokens t on t.appointment_id = a.id where t.access_key = $1`, [b.access_key]);
      assert.equal(appt.rows[0].status, 'cancelled');
      refused(await db().rpc(db().anon, 'cancel_my_token', { p_access_key: b.access_key }), 'invalid_transition');
    });
  });

  describe('what patients see', () => {
    beforeEach(async () => { await q().reset(); });
    const view = async (b) => ok(await db().rpc(db().anon, 'get_my_token', { p_access_key: b.access_key }));

    it('counts the patient with the doctor as ahead, and the count falls as the queue moves', async () => {
      const d = await q().newDoctor();
      const books = [];
      for (let i = 0; i < 3; i += 1) books.push(ok(await q().book(d)));
      assert.equal((await view(books[2])).view.patients_ahead, 2);
      ok(await q().next(d));
      assert.equal((await view(books[2])).view.patients_ahead, 2, 'one is with the doctor, one waiting');
      assert.equal((await view(books[0])).view.patients_ahead, 0);
      await q().tick(5);
      ok(await q().next(d, await q().id(d, 1)));
      assert.equal((await view(books[2])).view.patients_ahead, 1);
      assert.equal((await view(books[2])).view.estimated_wait_minutes, 10);
    });

    it('uses a doctor specific minutes per patient', async () => {
      const d = await q().newDoctor({ minutes: 7 });
      ok(await q().book(d));
      const b = ok(await q().book(d));
      const v = (await view(b)).view;
      assert.equal(v.minutes_per_patient, 7);
      assert.equal(v.estimated_wait_minutes, 7);
    });

    it('gives no estimate once a token is no longer queued', async () => {
      const d = await q().newDoctor();
      const b = ok(await q().book(d));
      ok(await db().rpc(db().anon, 'cancel_my_token', { p_access_key: b.access_key }));
      const v = (await view(b)).view;
      assert.equal(v.patients_ahead, null);
      assert.equal(v.estimated_wait_minutes, null);
      assert.equal(v.estimated_time, null);
    });

    it('counts only OPD hours when working out a clock time (10 to 14 and 16 to 19, at 11:00)', async () => {
      const d = await q().newDoctor();
      const at = async (offset, date = TODAY) => (await db().admin.query(`select private.estimate_clock_time($1, 'Asia/Kolkata', $2::date, $3) as r`, [d.id, date, offset])).rows[0].r;
      const local = (iso) => new Date(Date.parse(iso) + 5.5 * 3600 * 1000).toISOString().slice(11, 16);
      assert.deepEqual([local((await at(0)).at), (await at(0)).outside_hours], ['11:00', false]);
      assert.deepEqual([local((await at(30)).at), (await at(30)).outside_hours], ['11:30', false]);
      assert.deepEqual([local((await at(180)).at), (await at(180)).outside_hours], ['14:00', false]);
      assert.deepEqual([local((await at(181)).at), (await at(181)).outside_hours], ['16:01', false]);
      assert.deepEqual([local((await at(360)).at), (await at(360)).outside_hours], ['19:00', false]);
      assert.deepEqual([local((await at(361)).at), (await at(361)).outside_hours], ['19:01', true]);
      assert.equal(local((await at(30, TOMORROW)).at), '10:30', 'another day starts when the first session opens');
    });

    it('says who the doctor is seeing, and where the queue stands, in words a patient can read', async () => {
      const d = await q().newDoctor();
      const board = async (date) => ok(await db().rpc(db().anon, 'get_public_queue', { p_slug: q().slug, p_doctor_id: d.id, p_date: date ?? null })).board;
      assert.equal((await board()).status.label, 'No tokens issued yet');
      const books = [];
      for (let i = 0; i < 4; i += 1) books.push(ok(await q().book(d)));
      assert.equal((await board()).status.label, 'Not started yet');
      ok(await q().next(d));
      const running = await board();
      assert.equal(running.status.label, 'Doctor is seeing token #1');
      assert.equal(running.current_number, 1);
      assert.deepEqual(running.upcoming, [2, 3, 4]);
      await q().tick(5);
      ok(await db().rpc(d.who, 'complete_token', { p_token_id: await q().id(d, 1) }));
      assert.equal((await board()).status.label, 'Between patients, the next token will be called soon');
      assert.equal((await board(TOMORROW)).status.label, 'Queue opens on the day of the visit');
      for (const n of [2, 3, 4]) ok(await db().rpc(q().recepW, 'mark_no_show', { p_token_id: await q().id(d, n) }));
      assert.equal((await board()).status.label, 'All tokens for today are done');
    });

    it('shows the waiting room the next three waiting numbers in calling order', async () => {
      const d = await q().newDoctor();
      for (let i = 0; i < 6; i += 1) ok(await q().book(d));
      ok(await q().next(d));
      ok(await db().rpc(d.who, 'hold_token', { p_token_id: await q().id(d, 1) }));
      ok(await db().rpc(d.who, 'resume_token', { p_token_id: await q().id(d, 1) }));
      const b = ok(await db().rpc(db().anon, 'get_public_queue', { p_slug: q().slug, p_doctor_id: d.id })).board;
      assert.deepEqual(b.upcoming, [1, 2, 3], 'a resumed patient goes to the front');
      assert.equal(b.waiting_count, 6);
    });

    it('falls back to the first doctor when the requested one does not exist', async () => {
      const r = ok(await db().rpc(db().anon, 'get_public_queue', { p_slug: q().slug, p_doctor_id: '00000000-0000-4000-8000-000000000000' }));
      assert.ok(r.doctor.id);
      refused(await db().rpc(db().anon, 'get_public_queue', { p_slug: 'nobody-here' }), 'not_found');
    });

    it('describes how far through the line in front a token is', async () => {
      const d = await q().newDoctor();
      const books = [];
      for (let i = 0; i < 4; i += 1) books.push(ok(await q().book(d)));
      assert.equal((await view(books[3])).view.progress, 0);
      ok(await q().act(q().recepW, 'mark_no_show', await q().id(d, 1)));
      ok(await q().act(q().recepW, 'mark_no_show', await q().id(d, 2)));
      assert.equal((await view(books[3])).view.progress, 0.6667);
      assert.equal((await view(books[0])).view.progress, 1, 'nobody in front');
    });
  });

  describe('patient search', () => {
    beforeEach(async () => { await q().reset(); });
    const search = async (query, who = () => q().recepW) => ok(await db().rpc(who(), 'search_patients', { p_clinic: q().clinic, p_query: query })).patients;

    it('searches by part of a name ignoring case, by phone digits, and not on a single character', async () => {
      const d = await q().newDoctor();
      ok(await q().book(d, { name: 'Searchable Sunita', phone: '9700000001' }));
      ok(await q().book(d, { name: 'Searchable Sunil', phone: '9700000002' }));
      assert.deepEqual((await search('searchable SUN')).map((p) => p.name), ['Searchable Sunil', 'Searchable Sunita']);
      assert.deepEqual((await search('97000 00002')).map((p) => p.name), ['Searchable Sunil']);
      assert.deepEqual(await search('s'), []);
      assert.deepEqual(await search('   '), []);
      assert.deepEqual(await search('%'), [], 'wildcards are not special');
      assert.deepEqual(await search('_____'), []);
    });

    it('counts visits and finds the last visit date', async () => {
      const d = await q().newDoctor();
      ok(await q().book(d, { name: 'Counted Carol', phone: '9700000009' }));
      ok(await q().next(d));
      ok(await db().rpc(d.who, 'complete_token', { p_token_id: await q().id(d, 1) }));
      const [p] = await search('Counted Carol');
      assert.equal(p.visit_count, 1);
      assert.equal(p.last_visit_date, TODAY);
    });

    it('returns at most 25 patients', async () => {
      const d = await q().newDoctor({ limit: 60 });
      for (let i = 0; i < 27; i += 1) ok(await q().walkIn(d, { name: `Many Match ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, over: true }));
      assert.equal((await search('Many Match')).length, 25);
    });
  });
}
