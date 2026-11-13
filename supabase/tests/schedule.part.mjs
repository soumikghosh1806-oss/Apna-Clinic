// Migration 8: customisable doctor schedules (free times, several sessions, breaks, per-weekday timings, leave,
// holidays, one-day timings, extra sessions) and what they mean for booking and the queue.
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { failure } from './harness.mjs';
import { ok, refused, nextPhone, NOW, TODAY, TOMORROW } from './world.mjs';

const letters = (n) => String(n).split('').map((d) => 'abcdefghij'[Number(d)]).join('');
/** A wall clock time in the clinic's zone (Asia/Kolkata unless a test changes it) as a UTC instant. */
const ist = (date, hhmm) => new Date(`${date}T${hhmm}:00+05:30`).toISOString();

// The example week from the brief. Keys are weekdays, 0 = Sunday.
const WEEK = {
  1: [{ start: '09:30', end: '12:45' }, { start: '17:30', end: '20:15' }],
  2: [{ start: '10:15', end: '13:30' }],
  3: [],
  4: [{ start: '16:00', end: '21:00' }],
  5: [{ start: '09:00', end: '12:00' }, { start: '18:00', end: '20:30' }],
  6: [{ start: '10:00', end: '14:00' }],
  0: [],
};
const ALL_DAYS = (sessions) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), sessions]));

export function scheduleTests(ctx) {
  describe('doctor schedules', () => {
    let db, as, rpc, service, owner, recep, clinic, slug, ownerW, recepW, otherOwner, otherClinic;
    let n = 0;

    const newDoctor = async (sessions = [{ start: '10:00', end: '14:00' }], over = {}) => {
      n += 1;
      const d = ok(await rpc(ownerW, 'add_doctor', {
        p_clinic: clinic, p_name: `Dr Sched ${letters(n)}`, p_opd: `Sched OPD ${n}`, p_sessions: sessions,
        p_daily_limit: over.limit ?? null, p_minutes_per_patient: over.minutes ?? null,
      })).doctor;
      const user = await db.createUser(`sched-doc-${n}@test.local`, d.name);
      ok(await rpc(service, 'attach_staff', { p_clinic: clinic, p_user_id: user, p_role: 'doctor', p_doctor_id: d.id, p_invited_by: owner }));
      return { id: d.id, user, who: as(user), name: d.name };
    };
    const setWeek = (doc, weekly, confirm = false) => rpc(ownerW, 'set_weekly_schedule', { p_clinic: clinic, p_doctor_id: doc.id, p_weekly: weekly, p_confirm: confirm });
    const getSchedule = async (doc) => ok(await rpc(ownerW, 'get_doctor_schedule', { p_clinic: clinic, p_doctor_id: doc.id }));
    const addException = (doc, kind, start, end = null, sessions = [], reason = null, confirm = false, who = ownerW) =>
      rpc(who, 'add_schedule_exception', {
        p_clinic: clinic, p_doctor_id: doc ? doc.id : null, p_kind: kind, p_start: start, p_end: end ?? start, p_sessions: sessions, p_reason: reason, p_confirm: confirm });
    const removeException = (id, confirm = false, who = ownerW) => rpc(who, 'remove_schedule_exception', { p_clinic: clinic, p_exception: id, p_confirm: confirm });
    const day = async (doc, date) => (await db.admin.query('select private.effective_day($1, $2) as d', [doc.id, date])).rows[0].d;
    const book = (doc, over = {}) => rpc(db.anon, 'book_token', {
      p_slug: slug, p_name: over.name ?? `Patient ${letters(++n)}`, p_phone: over.phone ?? nextPhone(), p_doctor_id: doc.id,
      p_date: over.date ?? TODAY, p_session_start: over.session ?? null });
    const walkIn = (doc, over = {}) => rpc(recepW, 'add_walk_in', {
      p_clinic: clinic, p_name: over.name ?? `Walker ${letters(++n)}`, p_phone: nextPhone(), p_doctor_id: doc.id, p_allow_over_limit: false });
    const publicDoctor = async (doc) => (ok(await rpc(db.anon, 'get_public_clinic', { p_slug: slug })).doctors.find((d) => d.id === doc.id));
    const tokenRow = async (id) => (await db.admin.query('select * from public.queue_tokens where id = $1', [id])).rows[0];
    const snapshotTokens = async (doc, date = TODAY) =>
      ok(await rpc(recepW, 'get_staff_snapshot', { p_clinic: clinic })).tokens.filter((t) => t.doctor_id === doc.id && t.date === date).sort((a, b) => a.number - b.number);

    before(async () => {
      db = ctx.db; ({ as, rpc, service } = db);
      owner = await db.createUser('sched-owner@test.local', 'Sched Owner');
      recep = await db.createUser('sched-recep@test.local', 'Sched Reception');
      otherOwner = await db.createUser('sched-other-owner@test.local', 'Other Owner');
      clinic = ok(await rpc(as(owner), 'register_clinic', { p_clinic_name: 'Schedule Lab', p_slug: 'schedule-lab', p_owner_name: 'Sched Owner' })).clinic.id;
      otherClinic = ok(await rpc(as(otherOwner), 'register_clinic', { p_clinic_name: 'Other Lab', p_slug: 'other-lab', p_owner_name: 'Other Owner' })).clinic.id;
      ok(await rpc(service, 'attach_staff', { p_clinic: clinic, p_user_id: recep, p_role: 'receptionist', p_doctor_id: null, p_invited_by: owner }));
      slug = 'schedule-lab';
      ownerW = as(owner); recepW = as(recep);
    });
    afterEach(async () => { await db.setNow(NOW); });

    // ---------------------------------------------------------------------------------------------------------
    it('stores the example week exactly as entered: odd start and end times, split days, a closed Wednesday and Sunday', async () => {
      const doc = await newDoctor();
      ok(await setWeek(doc, WEEK));
      const s = await getSchedule(doc);
      assert.deepEqual(s.weekly, WEEK);
      assert.equal(s.timezone, 'Asia/Kolkata');

      // 2026-03-09 is a Monday.
      const expectDay = async (date, open, sessions) => {
        const d = await day(doc, date);
        assert.equal(d.open, open, date);
        assert.deepEqual(d.sessions, sessions, date);
      };
      await expectDay('2026-03-09', true, WEEK[1]);
      await expectDay('2026-03-10', true, WEEK[2]);
      await expectDay('2026-03-11', false, []);
      await expectDay('2026-03-12', true, WEEK[4]);
      await expectDay('2026-03-13', true, WEEK[5]);
      await expectDay('2026-03-14', true, WEEK[6]);
      await expectDay('2026-03-15', false, []);
      assert.equal((await day(doc, '2026-03-15')).reason, 'weekly_off');
    });

    it('rejects timings that make no sense, says which day is wrong, and changes nothing', async () => {
      const doc = await newDoctor();
      ok(await setWeek(doc, WEEK));
      const bad = [
        [{ 2: [{ start: '12:00', end: '11:00' }] }, /end after/i],
        [{ 2: [{ start: '12:00', end: '12:00' }] }, /end after/i],
        [{ 2: [{ start: '10:00', end: '12:00' }, { start: '11:30', end: '13:00' }] }, /overlap/i],
        [{ 2: [{ start: '16:00', end: '18:00' }, { start: '09:00', end: '12:00' }, { start: '11:00', end: '17:00' }] }, /overlap/i],
        [{ 2: [{ start: '10:00', end: '14:00', break_start: '09:00', break_end: '10:30' }] }, /inside/i],
        [{ 2: [{ start: '10:00', end: '14:00', break_start: '13:00', break_end: '15:00' }] }, /inside/i],
        [{ 2: [{ start: '10:00', end: '14:00', break_start: '12:00' }] }, /both the break/i],
        [{ 2: [{ start: '10:00', end: '14:00', break_start: '12:30', break_end: '12:00' }] }, /break must end after/i],
        [{ 2: [{ start: '25:00', end: '26:00' }] }, /hours and minutes/i],
        [{ 2: [{ start: '9am', end: '12:00' }] }, /hours and minutes/i],
        [{ 2: [{ start: '09:00' }] }, /hours and minutes/i],
        [{ 2: [1, 2] }, /start and an end/i],
        [{ 2: Array.from({ length: 7 }, (_, i) => ({ start: `${String(i * 3).padStart(2, '0')}:00`, end: `${String(i * 3 + 1).padStart(2, '0')}:00` })) }, /at most 6/i],
        [{ 7: [{ start: '09:00', end: '10:00' }] }, /numbered 0/i],
        [[], /one list/i],
        [null, /one list/i],
      ];
      for (const [weekly, message] of bad) {
        const r = refused(await setWeek(doc, weekly), 'invalid_input');
        assert.match(r.message, message, JSON.stringify(weekly));
      }
      assert.match(refused(await setWeek(doc, { 2: [{ start: '12:00', end: '11:00' }] }), 'invalid_input').message, /^Tuesday: /);
      assert.deepEqual((await getSchedule(doc)).weekly, WEEK, 'a refused change leaves the timetable alone');
    });

    it('accepts back to back sessions and a break inside a session, and keeps breaks when read back', async () => {
      const doc = await newDoctor();
      const weekly = { 2: [{ start: '09:00', end: '10:00' }, { start: '10:00', end: '11:00' }, { start: '11:30', end: '15:00', break_start: '13:00', break_end: '13:30' }] };
      ok(await setWeek(doc, weekly));
      assert.deepEqual((await getSchedule(doc)).weekly[2], weekly[2]);
      assert.deepEqual((await day(doc, TODAY)).sessions, weekly[2]);
    });

    it('lets only the owner change timings, but any member of the clinic read them', async () => {
      const doc = await newDoctor();
      for (const who of [recepW, doc.who, as(otherOwner)]) {
        const r = refused(await rpc(who, 'set_weekly_schedule', { p_clinic: clinic, p_doctor_id: doc.id, p_weekly: WEEK, p_confirm: false }), 'forbidden');
        assert.ok(r.message);
      }
      refused(await rpc(recepW, 'add_schedule_exception', { p_clinic: clinic, p_doctor_id: doc.id, p_kind: 'closed', p_start: TOMORROW, p_end: TOMORROW, p_sessions: [], p_reason: null, p_confirm: false }), 'forbidden');
      ok(await rpc(recepW, 'get_doctor_schedule', { p_clinic: clinic, p_doctor_id: doc.id }));
      ok(await rpc(doc.who, 'get_doctor_schedule', { p_clinic: clinic, p_doctor_id: doc.id }));
      refused(await rpc(as(otherOwner), 'get_doctor_schedule', { p_clinic: clinic, p_doctor_id: doc.id }), 'forbidden');
      await failure(rpc(db.anon, 'get_doctor_schedule', { p_clinic: clinic, p_doctor_id: doc.id }));
      await failure(rpc(db.anon, 'set_weekly_schedule', { p_clinic: clinic, p_doctor_id: doc.id, p_weekly: WEEK, p_confirm: false }));
      // A doctor of another clinic cannot be reached through this clinic.
      const foreign = ctx.w.betaDoc;
      refused(await rpc(ownerW, 'set_weekly_schedule', { p_clinic: clinic, p_doctor_id: foreign.id, p_weekly: WEEK, p_confirm: false }), 'not_found');
    });

    // ---------------------------------------------------------------------------------------------------------
    it('counts only consulting time when estimating a wait: closed hours and breaks are skipped', async () => {
      const doc = await newDoctor();
      ok(await setWeek(doc, { 2: [{ start: '10:00', end: '14:00', break_start: '12:00', break_end: '12:30' }, { start: '16:00', end: '19:00' }] }));
      const at = async (minutes) => (await db.admin.query(`select private.estimate_clock_time($1, 'Asia/Kolkata', $2::date, $3) as e`, [doc.id, TODAY, minutes])).rows[0].e;
      // It is 11:00. 90 minutes: 60 before the break, then 30 after it.
      assert.equal(Date.parse((await at(90)).at), Date.parse(ist(TODAY, '13:00')));
      assert.equal((await at(90)).outside_hours, false);
      // 3 hours 15 minutes: 60 + 90 before 14:00, 15 more in the evening session.
      assert.equal(Date.parse((await at(165)).at), Date.parse(ist(TODAY, '16:15')));
      // More than the day holds: marked as outside OPD hours.
      assert.equal((await at(10 * 60)).outside_hours, true);
    });

    // ---------------------------------------------------------------------------------------------------------
    it('books into the session that fits, records it on the token, and refuses sessions that are not on the timetable', async () => {
      const doc = await newDoctor();
      ok(await setWeek(doc, { 2: [{ start: '10:15', end: '13:30' }, { start: '16:00', end: '19:00' }], 3: [{ start: '09:00', end: '12:00' }] }));

      // It is 11:00: the morning session is running, so that is where an unspecified booking goes.
      const a = ok(await book(doc));
      assert.equal(a.token.session_start, '10:15');
      assert.equal(a.token.session_end, '13:30');
      const b = ok(await book(doc, { session: '16:00' }));
      assert.equal(b.token.session_start, '16:00');
      assert.equal(b.token.number, a.token.number + 1, 'token numbers run through the whole day');
      assert.equal(Number((await tokenRow((await db.admin.query('select id from public.queue_tokens where access_key = $1', [b.access_key])).rows[0].id)).session_start.slice(0, 2)), 16);

      const wrong = refused(await book(doc, { session: '12:00' }), 'invalid_input');
      assert.ok(wrong.field_errors.session);
      refused(await book(doc, { session: 'later' }), 'invalid_input');
      // Tomorrow has its own timing.
      const t = ok(await book(doc, { date: TOMORROW }));
      assert.equal(t.token.session_start, '09:00');
      refused(await book(doc, { date: TOMORROW, session: '16:00' }), 'invalid_input');

      // The patient sees the session on their own token page.
      const mine = ok(await rpc(db.anon, 'get_my_token', { p_access_key: a.access_key }));
      assert.equal(mine.token.session_start, '10:15');
      assert.equal(mine.token.session_end, '13:30');
    });

    it('refuses to book on a closed day or once the day\'s OPD is over, and never blocks tomorrow because today is over', async () => {
      const doc = await newDoctor();
      ok(await setWeek(doc, { 2: [{ start: '10:15', end: '13:30' }, { start: '16:00', end: '19:00' }], 3: [] }));

      const closed = refused(await book(doc, { date: TOMORROW }), 'doctor_unavailable');
      assert.match(closed.message, /has no OPD on/);
      let pub = await publicDoctor(doc);
      assert.equal(pub.availability.tomorrow.open, false);
      assert.equal(pub.availability.tomorrow.reason, 'closed');
      assert.equal(pub.availability.tomorrow.closed_reason, 'weekly_off');
      assert.equal(pub.availability.today.open, true);

      // 14:00: the morning session has ended, the evening one has not.
      await db.setNow(ist(TODAY, '14:00'));
      pub = await publicDoctor(doc);
      assert.deepEqual(pub.availability.today.sessions.map((s) => [s.start, s.open]), [['10:15', false], ['16:00', true]]);
      assert.equal(ok(await book(doc)).token.session_start, '16:00', 'goes to the session that is still ahead');
      assert.match(refused(await book(doc, { session: '10:15' }), 'doctor_unavailable').message, /already ended/);

      // 20:00: nothing left today.
      await db.setNow(ist(TODAY, '20:00'));
      pub = await publicDoctor(doc);
      assert.equal(pub.availability.today.open, false);
      assert.equal(pub.availability.today.reason, 'ended');
      assert.match(refused(await book(doc), 'doctor_unavailable').message, /over for/);
    });

    it('lets reception add a walk in after hours on a working day, in the last session, but not on a closed day', async () => {
      const doc = await newDoctor();
      ok(await setWeek(doc, { 2: [{ start: '10:15', end: '13:30' }, { start: '16:00', end: '19:00' }] }));
      await db.setNow(ist(TODAY, '20:30'));
      assert.equal(ok(await walkIn(doc)).token.session_start, '16:00');

      await db.setNow(NOW);
      const other = await newDoctor();
      ok(await setWeek(other, { 2: [] }));
      refused(await walkIn(other), 'doctor_unavailable');
      // During OPD a walk in joins the session in progress.
      await db.setNow(ist(TODAY, '11:30'));
      assert.equal(ok(await walkIn(doc)).token.session_start, '10:15');
      // Between sessions a walk in joins the next one.
      await db.setNow(ist(TODAY, '14:30'));
      assert.equal(ok(await walkIn(doc)).token.session_start, '16:00');
    });

    it('calls patients session by session: an earlier session first, then booking order, and requeue stays in its own session', async () => {
      const doc = await newDoctor([{ start: '10:00', end: '14:00' }, { start: '16:00', end: '19:00' }]);
      const evening1 = ok(await book(doc, { session: '16:00' }));   // 1
      const morning1 = ok(await book(doc, { session: '10:00' }));   // 2
      const evening2 = ok(await book(doc, { session: '16:00' }));   // 3
      const morning2 = ok(await book(doc, { session: '10:00' }));   // 4
      assert.deepEqual([evening1, morning1, evening2, morning2].map((r) => r.token.number), [1, 2, 3, 4]);

      const idByKey = async (r) => (await db.admin.query('select id from public.queue_tokens where access_key = $1', [r.access_key])).rows[0].id;
      for (const r of [evening1, morning1, evening2, morning2]) ok(await rpc(recepW, 'mark_arrived', { p_token_id: await idByKey(r) }));

      const called = [];
      let current = null;
      for (let i = 0; i < 4; i += 1) {
        await db.setNow(new Date(Date.parse(NOW) + (i + 1) * 60_000).toISOString());
        const r = ok(await rpc(doc.who, 'call_next', { p_doctor_id: doc.id, p_expected_current: current }));
        called.push(r.called.number);
        current = r.called.id;
        if (i === 0) {
          // The doctor skips the first morning patient and reception brings them back: they go to the back of the
          // MORNING, not behind the evening session.
          ok(await rpc(doc.who, 'skip_token', { p_token_id: current }));
          ok(await rpc(recepW, 'requeue_token', { p_token_id: current }));
          current = null;
        }
      }
      // Morning patient 2 first; sent to the back of the morning they come after morning patient 4, and both still
      // come before the evening session even though evening patient 1 booked first.
      assert.deepEqual(called, [2, 4, 2, 1]);
    });

    // ---------------------------------------------------------------------------------------------------------
    it('applies leave, a clinic holiday, one day timings and extra sessions on top of the weekly timetable', async () => {
      const doc = await newDoctor([{ start: '10:00', end: '14:00' }]);
      const colleague = await newDoctor([{ start: '09:00', end: '12:00' }]);

      // Leave for one doctor.
      const leave = ok(await addException(doc, 'closed', TOMORROW, TOMORROW, [], 'Private surgery'));
      let d = await day(doc, TOMORROW);
      assert.equal(d.open, false);
      assert.equal(d.reason, 'leave');
      assert.equal((await day(colleague, TOMORROW)).open, true, 'leave belongs to one doctor');
      const refusedBooking = refused(await book(doc, { date: TOMORROW }), 'doctor_unavailable');
      assert.match(refusedBooking.message, /not available on/);
      ok(await book(colleague, { date: TOMORROW }));

      // The reason is for staff. The public never sees it.
      const publicJson = JSON.stringify([
        ok(await rpc(db.anon, 'get_public_clinic', { p_slug: slug })),
        ok(await rpc(db.anon, 'get_public_queue', { p_slug: slug, p_doctor_id: doc.id, p_date: TOMORROW })),
        refusedBooking,
      ]);
      assert.ok(!publicJson.includes('Private surgery'));
      assert.ok(JSON.stringify(await getSchedule(doc)).includes('Private surgery'), 'staff can see their own note');
      const pub = await publicDoctor(doc);
      assert.equal(pub.availability.tomorrow.closed_reason, 'leave');

      // A clinic wide holiday closes the colleague too. Bookings that already exist (here, the colleague's, and some
      // left by earlier tests) are flagged first and kept when the owner confirms.
      const holidayWarn = refused(await addException(null, 'closed', TOMORROW, TOMORROW, [], 'Festival'), 'schedule_conflict');
      assert.ok(holidayWarn.conflicts.some((c) => c.reason === 'closed' && c.closed_reason === 'holiday'));
      const holiday = ok(await addException(null, 'closed', TOMORROW, TOMORROW, [], 'Festival', true));
      assert.equal((await day(colleague, TOMORROW)).reason, 'holiday');
      assert.equal((await day(doc, TOMORROW)).reason, 'leave', 'a doctor\'s own leave wins over the holiday');
      assert.match(refused(await book(colleague, { date: TOMORROW }), 'doctor_unavailable').message, /clinic is closed/);

      // Removing them opens the day again.
      ok(await removeException(leave.id));
      ok(await removeException(holiday.id));
      assert.equal((await day(doc, TOMORROW)).open, true);
      ok(await book(doc, { date: TOMORROW }));

      // Different timings for one date replace the weekly ones (a fresh doctor, so no booking is in the way).
      const ovr = await newDoctor([{ start: '10:00', end: '14:00' }]);
      const over = ok(await addException(ovr, 'override', TOMORROW, TOMORROW, [{ start: '15:00', end: '17:30' }], null));
      assert.deepEqual((await day(ovr, TOMORROW)).sessions, [{ start: '15:00', end: '17:30' }]);
      assert.equal((await day(ovr, '2026-03-12')).sessions[0].start, '10:00', 'other dates are untouched');
      assert.equal(ok(await book(ovr, { date: TOMORROW, name: 'Override Patient' })).token.session_start, '15:00');
      // Taking the override away would strand that booking, so the owner has to confirm.
      refused(await removeException(over.id), 'schedule_conflict');
      ok(await removeException(over.id, true));
      assert.equal((await day(ovr, TOMORROW)).sessions[0].start, '10:00');

      // An extra session is added to whatever the day already has.
      const spc = await newDoctor([{ start: '10:00', end: '14:00' }]);
      const extra = ok(await addException(spc, 'special', TOMORROW, TOMORROW, [{ start: '18:00', end: '19:30' }], 'Evening camp'));
      assert.deepEqual((await day(spc, TOMORROW)).sessions.map((s) => s.start), ['10:00', '18:00']);
      ok(await removeException(extra.id));
      assert.deepEqual((await day(spc, TOMORROW)).sessions.map((s) => s.start), ['10:00']);

      // An extra session also works on a day the doctor does not normally work.
      const off = await newDoctor([{ start: '10:00', end: '14:00' }]);
      ok(await setWeek(off, { 3: [] }));
      assert.equal((await day(off, TOMORROW)).open, false);
      ok(await addException(off, 'special', TOMORROW, TOMORROW, [{ start: '09:00', end: '11:00' }]));
      assert.equal(ok(await book(off, { date: TOMORROW })).token.session_start, '09:00');
    });

    it('refuses exceptions that overlap the regular timings, are in the past, or are malformed', async () => {
      const doc = await newDoctor([{ start: '10:00', end: '14:00' }]);
      const overlap = refused(await addException(doc, 'special', TOMORROW, TOMORROW, [{ start: '13:00', end: '15:00' }]), 'invalid_input');
      assert.match(overlap.message, /overlap/i);
      refused(await addException(doc, 'special', TOMORROW, TOMORROW, [{ start: '15:00', end: '15:00' }]), 'invalid_input');
      refused(await addException(doc, 'special', TOMORROW, TOMORROW, []), 'invalid_input');
      refused(await addException(doc, 'override', TOMORROW, TOMORROW, [{ start: '10:00', end: '12:00' }, { start: '11:00', end: '13:00' }]), 'invalid_input');
      refused(await addException(null, 'override', TOMORROW, TOMORROW, [{ start: '10:00', end: '12:00' }]), 'invalid_input');
      refused(await addException(doc, 'holiday', TOMORROW), 'invalid_input');
      refused(await addException(doc, 'closed', '2026-03-09'), 'invalid_input');
      refused(await addException(doc, 'closed', '2026-03-14', '2026-03-12'), 'invalid_input');
      refused(await addException(doc, 'closed', TOMORROW, '2028-01-01'), 'invalid_input');
      refused(await addException(doc, 'closed', TOMORROW, TOMORROW, [], 'x'.repeat(121)), 'invalid_input');
      refused(await addException(doc, 'closed', null), 'invalid_input');
      refused(await addException(ctx.w.betaDoc, 'closed', TOMORROW), 'not_found');
      refused(await addException(doc, 'closed', TOMORROW, TOMORROW, [], null, false, recepW), 'forbidden');
      refused(await addException(doc, 'closed', TOMORROW, TOMORROW, [], null, false, as(otherOwner)), 'forbidden');
      await failure(addException(doc, 'closed', TOMORROW, TOMORROW, [], null, false, db.anon));
      assert.equal((await db.admin.query('select count(*)::int as n from public.doctor_schedule_exceptions where doctor_id = $1', [doc.id])).rows[0].n, 0,
        'refused requests leave nothing behind');
      // Today is allowed (a doctor can go on leave from this morning).
      ok(await addException(doc, 'closed', TODAY));
    });

    it('covers a range of leave days and only offers real exceptions for removal', async () => {
      const doc = await newDoctor();
      const leave = ok(await addException(doc, 'closed', TOMORROW, '2026-03-14', [], 'Conference'));
      for (const date of [TOMORROW, '2026-03-12', '2026-03-13', '2026-03-14']) assert.equal((await day(doc, date)).open, false, date);
      assert.equal((await day(doc, '2026-03-15')).open, true);
      const listed = (await getSchedule(doc)).exceptions;
      assert.equal(listed.length, 1);
      assert.equal(listed[0].start_date, TOMORROW);
      assert.equal(listed[0].end_date, '2026-03-14');
      assert.equal(listed[0].clinic_wide, false);
      refused(await removeException('00000000-0000-4000-8000-000000000000'), 'not_found');
      refused(await removeException(leave.id, false, recepW), 'forbidden');
      refused(await removeException(leave.id, false, as(otherOwner)), 'forbidden');
      ok(await removeException(leave.id));
      assert.equal((await getSchedule(doc)).exceptions.length, 0);
    });

    // ---------------------------------------------------------------------------------------------------------
    it('warns before a change leaves booked patients outside the new timings, changes nothing, and keeps them if confirmed', async () => {
      const doc = await newDoctor([{ start: '10:00', end: '14:00' }]);
      const one = ok(await book(doc));
      const two = ok(await book(doc));
      const idOf = async (r) => (await db.admin.query('select id from public.queue_tokens where access_key = $1', [r.access_key])).rows[0].id;

      // Moving the session to the afternoon strands both patients: the owner is told, and nothing changes.
      const warn = refused(await setWeek(doc, ALL_DAYS([{ start: '15:00', end: '18:00' }])), 'schedule_conflict');
      assert.match(warn.message, /affects 2 booked patients/);
      assert.match(warn.message, /will NOT be cancelled/);
      assert.equal(warn.conflicts.length, 1);
      assert.deepEqual([warn.conflicts[0].date, warn.conflicts[0].tokens, warn.conflicts[0].reason], [TODAY, 2, 'session_changed']);
      assert.deepEqual(warn.conflicts[0].session, { start: '10:00', end: '14:00' });
      assert.equal((await getSchedule(doc)).weekly[2][0].start, '10:00');

      // Making the session longer (or shifting it so it still contains the booked time) is fine.
      const wider = ok(await setWeek(doc, ALL_DAYS([{ start: '09:00', end: '15:00' }])));
      assert.deepEqual(wider.kept, []);
      assert.equal((await getSchedule(doc)).weekly[2][0].start, '09:00');

      // Confirmed: the new timings apply, and the existing bookings are exactly as they were.
      const done = ok(await setWeek(doc, ALL_DAYS([{ start: '15:00', end: '18:00' }]), true));
      assert.equal(done.kept.length, 1);
      assert.equal((await getSchedule(doc)).weekly[2][0].start, '15:00');
      for (const [r, number] of [[one, 1], [two, 2]]) {
        const row = await tokenRow(await idOf(r));
        assert.equal(row.status, 'waiting');
        assert.equal(row.token_number, number);
        assert.equal(row.session_start.slice(0, 5), '10:00', 'the token still belongs to the session it was booked in');
      }
      // New bookings follow the new timings.
      await db.setNow(ist(TODAY, '14:30'));
      assert.equal(ok(await book(doc)).token.session_start, '15:00');
      const audit = await db.admin.query(`select details from public.audit_log where clinic_id = $1 and action = 'schedule.update' and entity_id = $2`, [clinic, doc.id]);
      assert.ok(audit.rows.some((r) => r.details.bookings_kept === 1));
    });

    it('warns before leave or a holiday covers booked days, keeps those bookings, and ignores cancelled ones', async () => {
      const doc = await newDoctor([{ start: '10:00', end: '14:00' }]);
      const kept = ok(await book(doc, { date: TOMORROW }));
      const cancelled = ok(await book(doc, { date: TOMORROW }));
      ok(await rpc(db.anon, 'cancel_my_token', { p_access_key: cancelled.access_key }));

      const warn = refused(await addException(doc, 'closed', TOMORROW, TOMORROW, [], null), 'schedule_conflict');
      assert.match(warn.message, /affects 1 booked patient\./);
      assert.deepEqual([warn.conflicts[0].date, warn.conflicts[0].reason, warn.conflicts[0].closed_reason], [TOMORROW, 'closed', 'leave']);
      assert.equal((await getSchedule(doc)).exceptions.length, 0, 'nothing was saved');
      assert.equal((await day(doc, TOMORROW)).open, true);

      // A clinic wide holiday warns about every doctor's bookings.
      const holidayWarn = refused(await addException(null, 'closed', TOMORROW, TOMORROW, [], null), 'schedule_conflict');
      assert.ok(holidayWarn.conflicts.some((c) => c.doctor_id === doc.id));

      const done = ok(await addException(doc, 'closed', TOMORROW, TOMORROW, [], null, true));
      assert.equal(done.kept.length, 1);
      const row = (await db.admin.query('select status from public.queue_tokens where access_key = $1', [kept.access_key])).rows[0];
      assert.equal(row.status, 'waiting', 'the booked patient is still in the queue');
      refused(await book(doc, { date: TOMORROW }), 'doctor_unavailable');

      // Removing the leave does not need a warning: nothing is stranded.
      const removed = ok(await removeException(done.id));
      assert.deepEqual(removed.kept, []);
    });

    it('warns only about bookings the change itself strands, not ones an earlier confirmed change already left behind', async () => {
      const doc = await newDoctor([{ start: '10:00', end: '14:00' }]);
      ok(await book(doc, { date: TOMORROW }));
      ok(await addException(doc, 'closed', TOMORROW, TOMORROW, [], null, true)); // confirmed: tomorrow's booking is now outside the timetable

      // An unrelated edit is not held up by that old booking.
      const week = { ...ALL_DAYS([{ start: '10:00', end: '14:00' }]), 4: [{ start: '08:00', end: '12:00' }] };
      assert.deepEqual(ok(await setWeek(doc, week)).kept, []);

      // A booking that THIS change would strand is still reported, and only that one.
      ok(await book(doc, { date: TODAY }));
      const warn = refused(await addException(doc, 'closed', TODAY, TODAY, [], null), 'schedule_conflict');
      assert.equal(warn.conflicts.length, 1);
      assert.equal(warn.conflicts[0].date, TODAY);
      assert.match(warn.message, /affects 1 booked patient\./);
    });

    it('makes the owner confirm when removing an extra session or one day timings would strand bookings', async () => {
      const doc = await newDoctor([{ start: '10:00', end: '14:00' }]);
      const camp = ok(await addException(doc, 'special', TOMORROW, TOMORROW, [{ start: '18:00', end: '20:00' }]));
      ok(await book(doc, { date: TOMORROW, session: '18:00' }));
      const warn = refused(await removeException(camp.id), 'schedule_conflict');
      assert.equal(warn.conflicts[0].session.start, '18:00');
      assert.equal((await getSchedule(doc)).exceptions.length, 1);
      ok(await removeException(camp.id, true));
      assert.equal((await db.admin.query(`select count(*)::int as n from public.queue_tokens where doctor_id = $1 and status = 'waiting'`, [doc.id])).rows[0].n, 1);
    });

    // ---------------------------------------------------------------------------------------------------------
    it('keeps the weekly timetable when a doctor is edited without sessions, and sets every day when sessions are given', async () => {
      const doc = await newDoctor();
      ok(await setWeek(doc, WEEK));
      const edit = (sessions, name) => rpc(ownerW, 'update_doctor', {
        p_clinic: clinic, p_doctor_id: doc.id, p_name: name, p_opd: 'Renamed OPD', p_sessions: sessions, p_daily_limit: 50, p_minutes_per_patient: 7 });
      const renamed = ok(await edit(null, 'Dr Renamed Person'));
      assert.equal(renamed.doctor.name, 'Dr Renamed Person');
      assert.deepEqual((await getSchedule(doc)).weekly, WEEK, 'a null session list leaves the week alone');

      ok(await edit([{ start: '08:00', end: '09:00' }], 'Dr Renamed Person'));
      const weekly = (await getSchedule(doc)).weekly;
      for (let k = 0; k < 7; k += 1) assert.deepEqual(weekly[k], [{ start: '08:00', end: '09:00' }]);
      // The same warning protects booked patients here too.
      ok(await setWeek(doc, ALL_DAYS([{ start: '10:00', end: '14:00' }])));
      ok(await book(doc));
      refused(await edit([{ start: '16:00', end: '18:00' }], 'Dr Renamed Person'), 'schedule_conflict');
      assert.equal((await getSchedule(doc)).weekly[2][0].start, '10:00');
    });

    it('adds a doctor with the same timings on every day, as before, and the public page shows today\'s sessions', async () => {
      const doc = await newDoctor([{ start: '09:00', end: '12:00' }, { start: '17:00', end: '20:00' }]);
      const weekly = (await getSchedule(doc)).weekly;
      for (let k = 0; k < 7; k += 1) assert.equal(weekly[k].length, 2);
      const pub = await publicDoctor(doc);
      assert.deepEqual(pub.sessions, [{ start: '09:00', end: '12:00' }, { start: '17:00', end: '20:00' }]);
      assert.deepEqual(pub.availability.today.sessions.map((s) => s.start), ['09:00', '17:00']);
      assert.ok(pub.availability.today.sessions.every((s) => s.open === true && s.issued === 0));
    });

    it('shows a closed day and a break on the public queue board, without any personal information', async () => {
      const doc = await newDoctor();
      ok(await setWeek(doc, { 2: [{ start: '10:00', end: '14:00', break_start: '10:30', break_end: '11:30' }], 3: [] }));
      const closed = ok(await rpc(db.anon, 'get_public_queue', { p_slug: slug, p_doctor_id: doc.id, p_date: TOMORROW }));
      assert.equal(closed.board.status.code, 'closed');
      assert.match(closed.board.status.label, /has no OPD on/);
      assert.deepEqual(closed.board.sessions, []);

      // 11:00 falls inside the break.
      const open = ok(await rpc(db.anon, 'get_public_queue', { p_slug: slug, p_doctor_id: doc.id, p_date: TODAY }));
      assert.equal(open.board.on_break, true);
      assert.equal(open.board.consulting, false);
      assert.match(open.board.status.label, /short break/);
      assert.deepEqual(open.board.sessions, [{ start: '10:00', end: '14:00', break_start: '10:30', break_end: '11:30' }]);
      await db.setNow(ist(TODAY, '12:00'));
      assert.equal(ok(await rpc(db.anon, 'get_public_queue', { p_slug: slug, p_doctor_id: doc.id, p_date: TODAY })).board.on_break, false);

      // With a patient booked and called, the board reports a consulting doctor and nothing that identifies anyone.
      await db.setNow(NOW);
      const patient = ok(await book(doc, { name: 'Secret Patient Name', phone: '9123456789' }));
      const id = (await db.admin.query('select id from public.queue_tokens where access_key = $1', [patient.access_key])).rows[0].id;
      ok(await rpc(recepW, 'mark_arrived', { p_token_id: id }));
      ok(await rpc(doc.who, 'call_next', { p_doctor_id: doc.id, p_expected_current: null }));
      const live = ok(await rpc(db.anon, 'get_public_queue', { p_slug: slug, p_doctor_id: doc.id, p_date: TODAY }));
      assert.equal(live.board.consulting, true);
      assert.equal(live.board.current_number, patient.token.number);
      const text = JSON.stringify(live);
      for (const secret of ['Secret Patient Name', '9123456789', patient.access_key, 'created_by']) assert.ok(!text.includes(secret), `${secret} leaked`);
    });

    // ---------------------------------------------------------------------------------------------------------
    it('reads "today" and the OPD hours in the clinic\'s own time zone, not the server\'s', async () => {
      const abroad = await db.createUser('sched-ny-owner@test.local', 'New York Owner');
      const ny = ok(await rpc(as(abroad), 'register_clinic', { p_clinic_name: 'Eastern Clinic', p_slug: 'eastern-clinic', p_owner_name: 'New York Owner' })).clinic.id;
      await db.admin.query(`update public.clinics set timezone = 'America/New_York' where id = $1`, [ny]);
      const doc = ok(await rpc(as(abroad), 'add_doctor', { p_clinic: ny, p_name: 'Dr Eastern Doc', p_opd: 'General', p_sessions: [{ start: '09:00', end: '17:00' }], p_daily_limit: null, p_minutes_per_patient: null })).doctor;
      const bookNy = (over = {}) => rpc(db.anon, 'book_token', { p_slug: 'eastern-clinic', p_name: over.name ?? 'Nora Patient', p_phone: nextPhone(), p_doctor_id: doc.id, p_date: over.date, p_session_start: null });

      // 10:00 in New York (EDT, UTC-4) is 14:00 UTC. In Kolkata that moment is already the evening of the same day.
      await db.setNow('2026-03-10T14:00:00Z');
      const first = ok(await bookNy({ date: '2026-03-10' }));
      assert.equal(first.token.session_start, '09:00');
      const mine = ok(await rpc(db.anon, 'get_my_token', { p_access_key: first.access_key }));
      assert.equal(mine.today, '2026-03-10');
      assert.equal(Date.parse(mine.view.estimated_time.at), Date.parse('2026-03-10T14:00:00Z'), 'the estimate is the New York wall clock time, 10:00');

      // 18:00 in New York is after closing, even though it is 03:30 tomorrow in Kolkata.
      await db.setNow('2026-03-10T22:00:00Z');
      const pub = ok(await rpc(db.anon, 'get_public_clinic', { p_slug: 'eastern-clinic' }));
      assert.equal(pub.today, '2026-03-10');
      assert.equal(pub.doctors[0].availability.today.reason, 'ended');
      assert.equal(pub.doctors[0].availability.tomorrow.open, true);
      refused(await bookNy({ date: '2026-03-10', name: 'Late Patient' }), 'doctor_unavailable');
      assert.equal(ok(await bookNy({ date: '2026-03-11', name: 'Next Day Patient' })).token.session_start, '09:00');
    });

    it('lets only members read exceptions directly and nobody write them directly', async () => {
      const doc = await newDoctor();
      ok(await addException(doc, 'closed', '2026-03-20', '2026-03-20', [], 'Direct read'));
      const count = async (who) => Number((await db.query(who, `select count(*)::int as n from public.doctor_schedule_exceptions where clinic_id = $1`, [clinic]))[0].n);
      assert.ok((await count(ownerW)) >= 1);
      assert.ok((await count(recepW)) >= 1);
      assert.equal(await count(as(otherOwner)), 0);
      await failure(db.query(db.anon, 'select * from public.doctor_schedule_exceptions limit 1'));
      await failure(db.query(ownerW, `insert into public.doctor_schedule_exceptions (clinic_id, kind, start_date, end_date) values ($1, 'closed', '2026-04-01', '2026-04-01')`, [clinic]));
      await failure(db.query(ownerW, `delete from public.doctor_schedule_exceptions where clinic_id = $1`, [clinic]));
      // The helpers behind the schedule are not callable from the outside.
      for (const fn of ['effective_day', 'schedule_conflicts', 'write_weekly']) {
        await failure(db.query(ownerW, `select private.${fn}(null, null)`));
      }
    });
  });
}
