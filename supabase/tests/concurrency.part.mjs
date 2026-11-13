import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ok, nextPhone, TODAY } from './world.mjs';

const letters = (n) => String(n).split('').map((d) => 'abcdefghij'[Number(d)]).join('');
const tally = (results) => results.reduce((m, r) => { const k = r.ok ? 'ok' : r.code; m[k] = (m[k] ?? 0) + 1; return m; }, {});
const sorted = (xs) => [...xs].sort((a, b) => a - b);

export function concurrencyTests(ctx) {
  const q = () => ctx.q;
  const db = () => ctx.db;
  const publicBook = (doc, name, phone, date = TODAY) =>
    db().rpc(db().anon, 'book_token', { p_slug: q().slug, p_name: name, p_phone: phone, p_doctor_id: doc.id, p_date: date });

  describe('many people at the same moment', () => {
    beforeEach(async () => { await q().reset(); });

    it('gives 30 simultaneous bookings 30 different numbers, 1 to 30, with no gaps', async () => {
      const d = await q().newDoctor();
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => publicBook(d, `Crowd ${letters(i)}`, nextPhone())));
      assert.deepEqual(tally(results), { ok: 30 });
      assert.deepEqual(sorted(results.map((r) => r.token.number)), Array.from({ length: 30 }, (_, i) => i + 1));
      const stored = await db().admin.query(
        'select token_number from public.queue_tokens where doctor_id = $1 and queue_date = $2 order by 1', [d.id, TODAY]);
      assert.deepEqual(stored.rows.map((r) => r.token_number), Array.from({ length: 30 }, (_, i) => i + 1));
    });

    it('numbers online bookings and reception walk-ins together when they arrive at the same time', async () => {
      const d = await q().newDoctor();
      const calls = [];
      for (let i = 0; i < 12; i += 1) {
        calls.push(publicBook(d, `Online ${letters(i)}`, nextPhone()));
        calls.push(q().walkIn(d, { name: `Walk ${letters(i)}` }));
      }
      const results = await Promise.all(calls);
      assert.deepEqual(tally(results), { ok: 24 });
      assert.deepEqual(sorted(results.map((r) => r.token.number)), Array.from({ length: 24 }, (_, i) => i + 1));
    });

    it('lets exactly one of many simultaneous bookings for the same person through', async () => {
      const d = await q().newDoctor();
      const phone = nextPhone();
      const results = await Promise.all(Array.from({ length: 12 }, () => publicBook(d, 'Same Person', phone)));
      assert.deepEqual(tally(results), { ok: 1, duplicate: 11 });
      const rows = await db().admin.query('select count(*)::int as n from public.queue_tokens where doctor_id = $1 and queue_date = $2', [d.id, TODAY]);
      assert.equal(rows.rows[0].n, 1);
      const patients = await db().admin.query('select count(*)::int as n from public.patients where clinic_id = $1 and phone = $2', [q().clinic, phone]);
      assert.equal(patients.rows[0].n, 1, 'one patient record, not twelve');
    });

    it('stops at the daily token limit even when everyone presses at once', async () => {
      const d = await q().newDoctor({ limit: 5 });
      const results = await Promise.all(Array.from({ length: 14 }, (_, i) => publicBook(d, `Limit ${letters(i)}`, nextPhone())));
      assert.deepEqual(tally(results), { ok: 5, full: 9 });
      assert.deepEqual(sorted(results.filter((r) => r.ok).map((r) => r.token.number)), [1, 2, 3, 4, 5]);
    });

    it('holds one mobile number to its daily online limit across two doctors at once', async () => {
      await q().settings({ phoneCap: 4 });
      const a = await q().newDoctor();
      const b = await q().newDoctor();
      const phone = nextPhone();
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => publicBook(i % 2 ? a : b, `Family ${letters(i)}`, phone)));
      assert.deepEqual(tally(results), { ok: 4, rate_limited: 8 });
      const rows = await db().admin.query(
        `select count(*)::int as n from public.queue_tokens t join public.patients p on p.id = t.patient_id
         where t.clinic_id = $1 and p.phone = $2 and t.queue_date = $3 and t.source = 'online'`, [q().clinic, phone, TODAY]);
      assert.equal(rows.rows[0].n, 4);
      // Another number is not affected.
      ok(await publicBook(a, 'Someone Else', nextPhone()));
    });

    it('keeps booking safe across two doctors and two days at once', async () => {
      const a = await q().newDoctor();
      const b = await q().newDoctor();
      const calls = [];
      for (let i = 0; i < 10; i += 1) for (const [doc, date] of [[a, TODAY], [a, q().TOMORROW], [b, TODAY]]) calls.push(publicBook(doc, `Mix ${letters(i)}`, nextPhone(), date));
      const results = await Promise.all(calls);
      assert.deepEqual(tally(results), { ok: 30 });
      for (const [doc, date] of [[a, TODAY], [a, q().TOMORROW], [b, TODAY]]) {
        const nums = (await q().tokens(doc, date)).map((t) => t.number);
        assert.deepEqual(nums, Array.from({ length: 10 }, (_, i) => i + 1), `${doc.name} ${date}`);
      }
    });
  });

  describe('doctor and reception pressing buttons at the same moment', () => {
    beforeEach(async () => { await q().reset(); });

    it('lets only one of many simultaneous NEXT presses win, and never serves two patients', async () => {
      const d = await q().newDoctor();
      for (let i = 0; i < 4; i += 1) ok(await q().book(d));
      const first = await Promise.all(Array.from({ length: 8 }, () => q().next(d)));
      assert.deepEqual(tally(first), { ok: 1, stale: 7 });
      assert.equal(first.find((r) => r.ok).called.number, 1);

      await q().tick(60);
      const current = await q().id(d, 1);
      const second = await Promise.all(Array.from({ length: 8 }, () => q().next(d, current)));
      assert.deepEqual(tally(second), { ok: 1, stale: 7 });
      const t = await q().tokens(d);
      assert.deepEqual(t.map((x) => x.status), ['completed', 'serving', 'waiting', 'waiting']);
      assert.equal(t.filter((x) => x.status === 'serving').length, 1);
    });

    it('finishes a consultation once however many times it is pressed, with one visit record', async () => {
      const d = await q().newDoctor();
      ok(await q().book(d));
      ok(await q().next(d));
      const id = await q().id(d, 1);
      const results = await Promise.all(Array.from({ length: 6 }, () => db().rpc(d.who, 'complete_token', { p_token_id: id })));
      assert.deepEqual(tally(results), { ok: 1, invalid_transition: 5 });
      const visits = await db().admin.query('select count(*)::int as n from public.visits where queue_token_id = $1', [id]);
      assert.equal(visits.rows[0].n, 1);
    });

    it('settles a race between finishing and skipping the same patient, so only one takes effect', async () => {
      const d = await q().newDoctor();
      ok(await q().book(d));
      ok(await q().next(d));
      const id = await q().id(d, 1);
      const [complete, skip] = await Promise.all([
        db().rpc(d.who, 'complete_token', { p_token_id: id }),
        db().rpc(d.who, 'skip_token', { p_token_id: id }),
      ]);
      assert.equal([complete, skip].filter((r) => r.ok).length, 1, 'only one of the two takes effect');
      assert.equal([complete, skip].find((r) => !r.ok).code, 'invalid_transition');
      const final = (await q().token(d, 1)).status;
      assert.equal(final, complete.ok ? 'completed' : 'skipped');
      const visits = await db().admin.query('select count(*)::int as n from public.visits where queue_token_id = $1', [id]);
      assert.equal(visits.rows[0].n, complete.ok ? 1 : 0);
    });

    it('a patient cancelling while the doctor calls them ends in one clear state', async () => {
      const d = await q().newDoctor();
      const booked = ok(await q().book(d));
      const [cancel, call] = await Promise.all([
        db().rpc(db().anon, 'cancel_my_token', { p_access_key: booked.token.access_key }),
        q().next(d),
      ]);
      const status = (await q().token(d, 1)).status;
      if (cancel.ok) { assert.equal(status, 'cancelled'); assert.equal(call.ok, false); }
      else { assert.equal(status, 'serving'); assert.equal(call.ok, true); }
      const serving = await db().admin.query(`select count(*)::int as n from public.queue_tokens where doctor_id = $1 and status = 'serving'`, [d.id]);
      assert.ok(serving.rows[0].n <= 1);
    });
  });

  describe('live updates', () => {
    beforeEach(async () => { await q().reset(); });
    const sentAfter = async (id) => (await db().admin.query('select topic, event, payload, is_private from realtime.sent where id > $1 order by id', [id])).rows;
    const lastId = async () => Number((await db().admin.query('select coalesce(max(id), 0) as m from realtime.sent')).rows[0].m);

    it('sends a small "queue changed" signal on the clinic channel with no patient details', async () => {
      const d = await q().newDoctor();
      const mark = await lastId();
      const booked = ok(await q().book(d, { name: 'Private Person' }));
      ok(await q().next(d));
      const events = await sentAfter(mark);
      assert.ok(events.length >= 2, 'one for the booking, one for calling');
      for (const e of events) {
        assert.equal(e.topic, `queue:${q().clinic}`);
        assert.equal(e.event, 'queue_changed');
        assert.deepEqual(Object.keys(e.payload), ['doctor_id']);
        assert.equal(e.payload.doctor_id, d.id);
        assert.equal(e.is_private, false);
      }
      const text = JSON.stringify(events.map((e) => e.payload));
      assert.ok(!/Private|Person|phone|access_key/i.test(text));
      assert.ok(!text.includes(booked.token.access_key));
    });

    it('does not signal another clinic\'s channel', async () => {
      const d = await q().newDoctor();
      const mark = await lastId();
      ok(await q().book(d));
      const topics = new Set((await sentAfter(mark)).map((e) => e.topic));
      assert.deepEqual([...topics], [`queue:${q().clinic}`]);
    });

    it('never blocks a booking when the signal cannot be sent', async () => {
      const d = await q().newDoctor();
      await db().admin.query(`create or replace function realtime.send(payload jsonb, event text, topic text, is_private boolean default true)
        returns void language plpgsql as $$ begin raise exception 'realtime is down'; end $$`);
      try {
        const r = ok(await q().book(d));
        assert.equal(r.token.number, 1);
        ok(await q().next(d));
      } finally {
        await db().admin.query(`create or replace function realtime.send(payload jsonb, event text, topic text, is_private boolean default true)
          returns void language plpgsql as $$ begin insert into realtime.sent (topic, event, payload, is_private) values (topic, event, payload, is_private); end $$`);
      }
      assert.equal((await q().token(d, 1)).status, 'serving');
    });
  });
}
