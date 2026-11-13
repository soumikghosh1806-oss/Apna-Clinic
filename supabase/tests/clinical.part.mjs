import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { failure } from './harness.mjs';
import { ok, refused, nextPhone, TODAY, TOMORROW, SECRET } from './world.mjs';

export function clinicalTests(ctx) {
  const q = () => ctx.q;
  const db = () => ctx.db;

  /** A finished consultation for a fresh patient with a fresh doctor. */
  async function consultation(over = {}) {
    const doc = await q().newDoctor();
    const phone = nextPhone();
    ok(await q().book(doc, { name: over.name ?? 'Clinical Case', phone }));
    ok(await q().next(doc));
    const tokenId = await q().id(doc, 1);
    ok(await db().rpc(doc.who, 'complete_token', { p_token_id: tokenId }));
    const token = await q().token(doc, 1);
    return { doc, tokenId, patientId: token.patient_id, token };
  }
  const history = async (doc, patientId) => ok(await db().rpc(doc.who, 'get_patient_history', { p_clinic: q().clinic, p_patient_id: patientId }));

  describe('visits and prescriptions', () => {
    beforeEach(async () => { await q().reset(); });

    it('finishing a consultation creates exactly one visit, and the doctor fills it in', async () => {
      const c = await consultation();
      let h = await history(c.doc, c.patientId);
      assert.equal(h.visits.length, 1);
      assert.equal(h.visits[0].title, 'Consultation');
      assert.equal(h.visits[0].token_id, c.tokenId);
      refused(await db().rpc(c.doc.who, 'complete_token', { p_token_id: c.tokenId }), 'invalid_transition');
      assert.equal((await history(c.doc, c.patientId)).visits.length, 1, 'completing again does not add a second visit');
      const saved = ok(await db().rpc(c.doc.who, 'save_visit', {
        p_clinic: q().clinic, p_patient_id: c.patientId, p_visit_id: h.visits[0].id, p_title: 'Sore throat',
        p_notes: 'Mild redness', p_advice: 'Warm fluids', p_diagnosis: 'Pharyngitis', p_symptoms: 'Pain on swallowing',
      })).visit;
      assert.equal(saved.id, h.visits[0].id, 'updated in place');
      h = await history(c.doc, c.patientId);
      assert.deepEqual([h.visits[0].title, h.visits[0].notes, h.visits[0].advice, h.visits[0].diagnosis, h.visits[0].symptoms],
        ['Sore throat', 'Mild redness', 'Warm fluids', 'Pharyngitis', 'Pain on swallowing']);
    });

    it('adds a separate visit when none is named, newest first, and counts visits for search', async () => {
      const c = await consultation();
      await q().tick(60);
      ok(await db().rpc(c.doc.who, 'save_visit', { p_clinic: q().clinic, p_patient_id: c.patientId, p_visit_id: null, p_title: 'Follow up', p_notes: 'Better' }));
      const h = await history(c.doc, c.patientId);
      assert.equal(h.visits.length, 2);
      assert.equal(h.visits[0].title, 'Follow up');
      const found = ok(await db().rpc(q().recepW, 'search_patients', { p_clinic: q().clinic, p_query: 'Clinical Case' })).patients;
      assert.ok(found.some((p) => p.id === c.patientId && p.visit_count === 2));
    });

    it('validates a note and changes nothing when it is wrong', async () => {
      const c = await consultation();
      const save = (over) => db().rpc(c.doc.who, 'save_visit', { p_clinic: q().clinic, p_patient_id: c.patientId, p_visit_id: null, p_title: 'Ok', p_notes: 'Ok', ...over });
      assert.deepEqual(Object.keys(refused(await save({ p_title: '  ' }), 'invalid_input').field_errors), ['title']);
      assert.ok(refused(await save({ p_title: 'x'.repeat(121) }), 'invalid_input').field_errors.title);
      assert.ok(refused(await save({ p_notes: 'x'.repeat(2001) }), 'invalid_input').field_errors.notes);
      assert.ok(refused(await save({ p_advice: 'x'.repeat(2001) }), 'invalid_input').field_errors.advice);
      assert.ok(refused(await save({ p_notes: '', p_advice: '' }), 'invalid_input').field_errors.notes);
      assert.ok(refused(await save({ p_date: TOMORROW }), 'invalid_input').field_errors.date);
      assert.equal((await history(c.doc, c.patientId)).visits.length, 1);
    });

    it('records a past visit on its own day in the clinic time zone', async () => {
      const c = await consultation();
      const v = ok(await db().rpc(c.doc.who, 'save_visit', { p_clinic: q().clinic, p_patient_id: c.patientId, p_visit_id: null, p_title: 'Old visit', p_notes: 'From last week', p_date: '2026-03-03' })).visit;
      assert.equal(v.date, '2026-03-03');
      const found = ok(await db().rpc(q().recepW, 'search_patients', { p_clinic: q().clinic, p_query: 'Clinical Case' })).patients.find((p) => p.id === c.patientId);
      assert.equal(found.last_visit_date, TODAY, 'the latest visit is still today');
    });

    it('stores a prescription cleaned up, replaces it on a second save, and keeps one per visit', async () => {
      const c = await consultation();
      const visitId = (await history(c.doc, c.patientId)).visits[0].id;
      const rx = (meds, instructions) => db().rpc(c.doc.who, 'save_prescription', { p_clinic: q().clinic, p_visit_id: visitId, p_medicines: meds, p_instructions: instructions ?? null });
      const first = ok(await rx([{ name: '  Paracetamol ', dose: '500 mg ', frequency: '', evil: 'ignored', extra: { a: 1 } }], '  Rest well '));
      assert.deepEqual(first.prescription.medicines, [{ name: 'Paracetamol', dose: '500 mg' }]);
      assert.equal(first.prescription.instructions, 'Rest well');
      ok(await rx([{ name: 'Cetirizine', duration: '3 days' }, { name: 'Zinc' }]));
      const h = await history(c.doc, c.patientId);
      assert.deepEqual(h.visits[0].prescription.medicines.map((m) => m.name), ['Cetirizine', 'Zinc']);
      const n = await db().admin.query('select count(*)::int as n from public.prescriptions where visit_id = $1', [visitId]);
      assert.equal(n.rows[0].n, 1);
      ok(await rx([], 'Instructions only'));
    });

    it('refuses a bad prescription', async () => {
      const c = await consultation();
      const visitId = (await history(c.doc, c.patientId)).visits[0].id;
      const rx = (meds, instructions) => db().rpc(c.doc.who, 'save_prescription', { p_clinic: q().clinic, p_visit_id: visitId, p_medicines: meds, p_instructions: instructions ?? null });
      refused(await rx([]), 'invalid_input');
      refused(await rx([{ dose: '5 mg' }]), 'invalid_input');
      refused(await rx([{ name: '  ' }]), 'invalid_input');
      refused(await rx(JSON.stringify('not a list')), 'invalid_input');
      refused(await rx([{ name: 'x'.repeat(101) }]), 'invalid_input');
      refused(await rx(Array.from({ length: 31 }, (_, i) => ({ name: `Drug ${String.fromCharCode(97 + (i % 26))}` }))), 'invalid_input');
      refused(await rx([{ name: 'Fine' }], 'x'.repeat(2001)), 'invalid_input');
      refused(await db().rpc(c.doc.who, 'save_prescription', { p_clinic: q().clinic, p_visit_id: '00000000-0000-4000-8000-000000000000', p_medicines: [{ name: 'x' }] }), 'not_found');
    });
  });

  describe('report files', () => {
    const { admin } = {};
    const w = () => ctx.w;
    const s = () => ctx.seed;
    const who = (k) => db().as(w().u[k]);
    const folder = () => `${w().clinicA}/${s().patientP1}`;
    const reg = (over = {}) => db().rpc(who('docA1'), 'register_report', {
      p_clinic: w().clinicA, p_patient_id: s().patientP1, p_visit_id: null, p_name: 'Scan', p_path: `${folder()}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-scan.pdf`,
      p_content_type: 'application/pdf', p_size_bytes: 1000, ...over,
    });
    const putObject = (name) => db().admin.query(`insert into storage.objects (bucket_id, name) values ('patient-reports', $1) on conflict do nothing`, [name]);

    it('records a report only after the file is really in the bucket, in the right folder', async () => {
      const path = `${folder()}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-scan.pdf`;
      refused(await reg({ p_path: path }), 'not_found');
      await putObject(path);
      const r = ok(await reg({ p_path: path, p_visit_id: s().visitP1 }));
      assert.equal(r.report.name, 'Scan');
      const h = ok(await db().rpc(who('docA1'), 'get_patient_history', { p_clinic: w().clinicA, p_patient_id: s().patientP1 }));
      assert.ok(h.visits[0].reports.some((x) => x.name === 'Scan'));
      assert.ok(!JSON.stringify(h).includes('file_path') && !JSON.stringify(h).includes(path), 'the history never exposes the storage path');
    });

    it('refuses the wrong folder, the wrong clinic, a bad type, a huge file and mismatched patients', async () => {
      const good = `${folder()}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-x.pdf`;
      await putObject(good);
      refused(await reg({ p_path: `${w().clinicB}/${s().patientP1}/x.pdf` }), 'invalid_input');
      refused(await reg({ p_path: `${w().clinicA}/${s().patientB}/x.pdf` }), 'invalid_input');
      refused(await reg({ p_path: `${folder()}/../${s().patientB}/x.pdf` }), 'invalid_input');
      refused(await reg({ p_path: good, p_content_type: 'text/html' }), 'invalid_input');
      refused(await reg({ p_path: good, p_content_type: 'application/x-msdownload' }), 'invalid_input');
      refused(await reg({ p_path: good, p_size_bytes: 10485761 }), 'invalid_input');
      refused(await reg({ p_path: good, p_size_bytes: 0 }), 'invalid_input');
      refused(await reg({ p_path: good, p_name: '   ' }), 'invalid_input');
      refused(await reg({ p_path: good, p_visit_id: ctx.seed.visitP1, p_patient_id: s().patientB }), 'not_found');
      refused(await db().rpc(who('docB'), 'register_report', { p_clinic: w().clinicB, p_patient_id: s().patientP1, p_visit_id: null, p_name: 'x', p_path: `${w().clinicB}/${s().patientP1}/x.pdf`, p_content_type: 'application/pdf', p_size_bytes: 5 }), 'not_found');
      for (const key of ['recepA', 'ownerA']) refused(await db().rpc(who(key), 'register_report', { p_clinic: w().clinicA, p_patient_id: s().patientP1, p_visit_id: null, p_name: 'x', p_path: good, p_content_type: 'application/pdf', p_size_bytes: 5 }), 'forbidden');
    });

    const insertObject = (key, name) => db().query(key === 'anon' ? db().anon : who(key), `insert into storage.objects (bucket_id, name, owner) values ('patient-reports', $1, null)`, [name]);
    it('lets only a doctor of that clinic add a file, and only inside that clinic and patient folder', async () => {
      const name = (suffix) => `${folder()}/cccccccc-cccc-4ccc-8ccc-cccccccccccc-${suffix}.pdf`;
      await insertObject('docA1', name('ok'));
      await insertObject('docA2', name('also-ok'));
      for (const [key, path] of [
        ['docB', name('b')], ['recepA', name('r')], ['ownerA', name('o')], ['outsider', name('x')], ['anon', name('anon')],
        ['docA1', `${w().clinicB}/${s().patientB}/cccccccc-cccc-4ccc-8ccc-cccccccccccc-other-clinic.pdf`],
        ['docA1', `${w().clinicA}/${s().patientB}/cccccccc-cccc-4ccc-8ccc-cccccccccccc-other-patient.pdf`],
        ['docA1', `${folder()}/nested/deeper/file.pdf`], ['docA1', `${folder()}/`], ['docA1', `loose-file.pdf`],
        ['docA1', `not-a-uuid/${s().patientP1}/file.pdf`], ['docA1', `${w().clinicA}/not-a-uuid/file.pdf`],
      ]) {
        const e = await failure(insertObject(key, path));
        assert.ok(['42501', 'P0001'].includes(e.code) || /row-level security|permission denied/i.test(e.message), `${key} ${path}: ${e.message}`);
      }
    });

    it('lets only doctors of that clinic open a file, and nobody change or remove one', async () => {
      const path = `${folder()}/dddddddd-dddd-4ddd-8ddd-dddddddddddd-read.pdf`;
      await putObject(path);
      const read = async (key) => (await db().query(key === 'anon' ? db().anon : who(key), `select name from storage.objects where bucket_id = 'patient-reports' and name = $1`, [path])).length;
      assert.equal(await read('docA1'), 1);
      assert.equal(await read('docA2'), 1);
      for (const key of ['docB', 'recepA', 'ownerA', 'outsider']) assert.equal(await read(key), 0, key);
      assert.equal(await read('anon'), 0);
      assert.equal((await db().query(db().anon, `select name from storage.objects`)).length, 0, 'the public sees no stored files at all');
      const upd = await db().withRole('authenticated', w().u.docA1, (c) => c.query(`update storage.objects set name = name || 'x' where bucket_id = 'patient-reports'`));
      const del = await db().withRole('authenticated', w().u.docA1, (c) => c.query(`delete from storage.objects where bucket_id = 'patient-reports'`));
      assert.deepEqual([upd.rowCount, del.rowCount], [0, 0]);
      assert.equal(await read('docA1'), 1, 'still there');
    });

    it('lets a doctor ask to open a report, records that, and tells nobody else anything', async () => {
      const r = ok(await db().rpc(who('docA2'), 'authorize_report_download', { p_report_id: s().report.id }));
      assert.equal(r.path, s().reportPath);
      const log = await db().admin.query(`select actor_id from public.audit_log where action = 'report.open' and entity_id = $1`, [s().report.id]);
      assert.ok(log.rows.some((x) => x.actor_id === w().u.docA2));
      refused(await db().rpc(who('docB'), 'authorize_report_download', { p_report_id: s().report.id }), 'not_found');
    });
  });

  describe('audit log', () => {
    const w = () => ctx.w;
    const actions = async (key, clinic = w().clinicA) =>
      (await db().query(db().as(w().u[key]), 'select action, actor_id, actor_role, clinic_id from public.audit_log where clinic_id = $1', [clinic]));

    it('records registration, staff, doctors, clinical access and file events with who did them', async () => {
      const rows = await actions('ownerA');
      const names = new Set(rows.map((r) => r.action));
      for (const a of ['clinic.register', 'doctor.add', 'staff.invite', 'patient.history_read', 'visit.save', 'prescription.save', 'report.upload']) assert.ok(names.has(a), a);
      assert.ok(rows.every((r) => r.clinic_id === w().clinicA));
      const save = rows.find((r) => r.action === 'visit.save');
      assert.equal(save.actor_id, w().u.docA1);
      assert.equal(save.actor_role, 'doctor');
      assert.equal(rows.find((r) => r.action === 'staff.invite').actor_id, w().u.ownerA, 'the owner, not the server, is the actor for an invite');
    });

    it('shows each owner only their own clinic\'s log, and no one else any log', async () => {
      assert.equal((await actions('ownerB', w().clinicA)).length, 0);
      for (const key of ['recepA', 'docA1', 'docB', 'outsider']) assert.equal((await db().query(db().as(w().u[key]), 'select * from public.audit_log')).length, 0, key);
    });

    it('does not put clinical text in the log', async () => {
      const all = await db().admin.query('select details::text as d from public.audit_log');
      const text = all.rows.map((r) => r.d).join(' ');
      for (const secret of Object.values(SECRET)) assert.ok(!text.includes(secret), secret);
    });

    it('records settings changes and staff switching', async () => {
      await q().settings({ limit: 90 });
      ok(await db().rpc(q().ownerW, 'update_clinic_settings', { p_clinic: q().clinic, p_clinic_name: 'Queue Clinic', p_online_booking_enabled: true, p_default_daily_limit: 100, p_default_minutes_per_patient: 10 }));
      const have = (await db().admin.query(`select distinct action from public.audit_log where clinic_id = $1`, [q().clinic])).rows.map((r) => r.action);
      assert.ok(have.includes('settings.update'));
    });
  });

  describe('reports', () => {
    beforeEach(async () => { await q().reset(); });

    it('counts the day from the token records, leaving cancelled tokens out of the totals but counting them', async () => {
      const d = await q().newDoctor();
      ok(await q().walkIn(d));                       // #1 arrives now
      ok(await q().book(d)); ok(await q().book(d));  // #2, #3
      const four = ok(await q().book(d));            // #4, cancelled below
      ok(await db().rpc(db().anon, 'cancel_my_token', { p_access_key: four.access_key }));
      await q().tick(300);
      ok(await q().next(d));                         // #1 called 5 minutes after arriving
      await q().tick(310);
      ok(await q().next(d, await q().id(d, 1)));     // completes #1, calls #2 (no arrival recorded, so no wait sample)
      await q().tick(700);
      ok(await db().rpc(d.who, 'complete_token', { p_token_id: await q().id(d, 2) }));
      ok(await db().rpc(q().recepW, 'mark_no_show', { p_token_id: await q().id(d, 3) }));
      await q().reset();

      const series = ok(await db().rpc(d.who, 'get_report_series', { p_clinic: q().clinic, p_end: TODAY, p_doctor_id: d.id })).days;
      assert.equal(series.length, 7);
      assert.equal(series[0].date, '2026-03-04');
      assert.equal(series[6].date, TODAY);
      assert.deepEqual(series[6], { date: TODAY, total: 3, completed: 2, no_show: 1, cancelled: 1, average_wait_minutes: 5, wait_samples: 1 });
      assert.deepEqual(series[5], { date: '2026-03-09', total: 0, completed: 0, no_show: 0, cancelled: 0, average_wait_minutes: null, wait_samples: 0 });

      const month = ok(await db().rpc(q().ownerW, 'get_report_month', { p_clinic: q().clinic, p_month: '2026-03-20', p_doctor_id: d.id })).rows;
      assert.deepEqual(month, [{ date: TODAY, opd: month[0].opd, total: 3, completed: 2, no_show: 1, cancelled: 1, average_wait_minutes: 5 }]);
    });

    it('covers every doctor when no doctor is chosen, and is open to the owner and doctors only', async () => {
      const all = ok(await db().rpc(q().ownerW, 'get_report_series', { p_clinic: q().clinic })).days;
      assert.equal(all.length, 7);
      assert.ok(all[6].total >= 3);
      refused(await db().rpc(q().recepW, 'get_report_series', { p_clinic: q().clinic }), 'forbidden');
      refused(await db().rpc(q().recepW, 'get_report_month', { p_clinic: q().clinic, p_month: TODAY }), 'forbidden');
    });
  });

  describe('settings, doctors and staff', () => {
    beforeEach(async () => { await q().reset(); });
    const owner = () => q().ownerW;

    it('validates clinic settings field by field', async () => {
      const set = (over) => db().rpc(owner(), 'update_clinic_settings', { p_clinic: q().clinic, p_clinic_name: 'Queue Clinic', p_online_booking_enabled: true, p_default_daily_limit: 100, p_default_minutes_per_patient: 10, ...over });
      assert.deepEqual(Object.keys(refused(await set({ p_clinic_name: 'x' }), 'invalid_input').field_errors), ['clinicName']);
      assert.deepEqual(Object.keys(refused(await set({ p_default_daily_limit: 0 }), 'invalid_input').field_errors), ['defaultDailyLimit']);
      assert.deepEqual(Object.keys(refused(await set({ p_default_daily_limit: 501 }), 'invalid_input').field_errors), ['defaultDailyLimit']);
      assert.deepEqual(Object.keys(refused(await set({ p_default_minutes_per_patient: 61 }), 'invalid_input').field_errors), ['defaultMinutesPerPatient']);
      assert.deepEqual(Object.keys(refused(await set({ p_max_online_bookings_per_phone: 21 }), 'invalid_input').field_errors), ['maxOnlineBookingsPerPhone']);
      const good = ok(await set({ p_clinic_name: '  Queue   Clinic ' }));
      assert.equal(good.settings.clinic_name, 'Queue Clinic');
    });

    it('validates a doctor\'s OPD timings', async () => {
      const add = (sessions, over = {}) => db().rpc(owner(), 'add_doctor', { p_clinic: q().clinic, p_name: 'Dr Valid', p_opd: 'Valid OPD', p_sessions: sessions, ...over });
      for (const bad of [[], [{ start: '10:00', end: '09:00' }], [{ start: '10:00', end: '10:00' }], [{ start: '25:00', end: '26:00' }],
        [{ start: 'ten', end: '11:00' }], [{ start: '09:00', end: '11:00' }, { start: '10:30', end: '12:00' }], JSON.stringify('nope'), null,
        [1, 2, 3, 4].map((i) => ({ start: `${8 + i * 2}:00`, end: `${9 + i * 2}:00` }))]) {
        assert.ok(refused(await add(bad), 'invalid_input').field_errors.sessions, JSON.stringify(bad));
      }
      assert.ok(refused(await add([{ start: '09:00', end: '10:00' }], { p_name: 'D' }), 'invalid_input').field_errors.name);
      assert.ok(refused(await add([{ start: '09:00', end: '10:00' }], { p_opd: 'O' }), 'invalid_input').field_errors.opd);
      assert.ok(refused(await add([{ start: '09:00', end: '10:00' }], { p_daily_limit: 0 }), 'invalid_input').field_errors.dailyLimit);
      assert.ok(refused(await add([{ start: '09:00', end: '10:00' }], { p_minutes_per_patient: 61 }), 'invalid_input').field_errors.minutesPerPatient);
      ok(await add([{ start: '9:30', end: '10:45' }, { start: '10:45', end: '12:00' }])); // back to back is fine
    });

    it('stores timings for every weekday and updates them in place', async () => {
      const d = await q().newDoctor({ sessions: [{ start: '09:00', end: '12:00' }, { start: '15:00', end: '18:00' }] });
      const count = async () => Number((await db().admin.query('select count(*) from public.doctor_schedules where doctor_id = $1', [d.id])).rows[0].count);
      assert.equal(await count(), 14);
      const upd = ok(await db().rpc(owner(), 'update_doctor', { p_clinic: q().clinic, p_doctor_id: d.id, p_name: 'Dr Renamed', p_opd: 'Skin OPD', p_sessions: [{ start: '08:00', end: '09:00' }], p_daily_limit: 20, p_minutes_per_patient: 12 }));
      assert.deepEqual(upd.doctor.sessions, [{ start: '08:00', end: '09:00' }]);
      assert.equal(await count(), 7);
      const page = ok(await db().rpc(db().anon, 'get_public_clinic', { p_slug: q().slug })).doctors.find((x) => x.id === d.id);
      assert.deepEqual([page.name, page.opd, page.daily_limit, page.minutes_per_patient], ['Dr Renamed', 'Skin OPD', 20, 12]);
    });

    it('refuses to remove a doctor with open tokens, keeps the last doctor, and keeps removed doctors for reports', async () => {
      const a = await q().newDoctor();
      const b = await q().newDoctor();
      ok(await q().book(a));
      const blocked = refused(await db().rpc(owner(), 'remove_doctor', { p_clinic: q().clinic, p_doctor_id: a.id }), 'invalid_transition');
      assert.match(blocked.message, /still has 1 open token for today or tomorrow/);
      ok(await q().act(q().recepW, 'mark_no_show', await q().id(a, 1)));
      ok(await db().rpc(owner(), 'remove_doctor', { p_clinic: q().clinic, p_doctor_id: a.id }));
      const row = await db().admin.query('select is_active from public.doctors where id = $1', [a.id]);
      assert.equal(row.rows[0].is_active, false);
      assert.ok(!ok(await db().rpc(db().anon, 'get_public_clinic', { p_slug: q().slug })).doctors.some((x) => x.id === a.id));
      assert.equal((await q().snapshot()).doctors.find((x) => x.id === a.id).active, false);
      refused(await db().rpc(owner(), 'remove_doctor', { p_clinic: q().clinic, p_doctor_id: a.id }), 'not_found');
      refused(await db().rpc(a.who, 'call_next', { p_doctor_id: a.id }), 'doctor_unavailable');

      // A clinic with a single doctor cannot remove them.
      const solo = await db().createUser('solo-owner@test.local', 'Solo');
      const reg = ok(await db().rpc(db().as(solo), 'register_clinic', { p_clinic_name: 'Solo Clinic', p_slug: 'solo-clinic', p_owner_name: 'Solo Owner' }));
      const only = ok(await db().rpc(db().as(solo), 'add_doctor', { p_clinic: reg.clinic.id, p_name: 'Dr Only', p_opd: 'Only OPD', p_sessions: [{ start: '09:00', end: '10:00' }] })).doctor;
      assert.match(refused(await db().rpc(db().as(solo), 'remove_doctor', { p_clinic: reg.clinic.id, p_doctor_id: only.id }), 'invalid_transition').message, /Keep at least one doctor/);
      assert.ok(b);
    });

    it('lists staff with their login emails, and the doctors that still have no login', async () => {
      const free = await q().newDoctor();
      await db().admin.query('update public.doctors set profile_id = null where id = $1', [free.id]);
      const r = ok(await db().rpc(owner(), 'list_staff', { p_clinic: q().clinic }));
      assert.ok(r.staff.some((s) => s.role === 'owner' && s.email === 'q-owner@test.local'));
      assert.ok(r.staff.some((s) => s.role === 'receptionist' && s.is_active));
      assert.ok(r.doctors_without_login.some((x) => x.id === free.id));
    });

    it('attaches staff safely: a doctor login needs a doctor, roles do not clash, and the owner cannot be switched off', async () => {
      const att = (user, role, doctorId, over = {}) => db().rpc(db().service, 'attach_staff', { p_clinic: q().clinic, p_user_id: user, p_role: role, p_doctor_id: doctorId, p_invited_by: q().owner, ...over });
      const person = await db().createUser('attach-person@test.local', 'Attach Person');
      const d = await q().newDoctor();
      await db().admin.query('update public.doctors set profile_id = null where id = $1', [d.id]);
      refused(await att(person, 'owner', null), 'invalid_input');
      refused(await att(person, 'doctor', null), 'not_found');
      refused(await att(person, 'doctor', '00000000-0000-4000-8000-000000000000'), 'not_found');
      refused(await att(person, 'doctor', ctx.w.general.id), 'not_found');
      ok(await att(person, 'doctor', d.id));
      ok(await att(person, 'doctor', d.id));                         // inviting again is harmless
      refused(await att(person, 'receptionist', null), 'invalid_transition');
      const other = await db().createUser('attach-other@test.local', 'Attach Other');
      refused(await att(other, 'doctor', d.id), 'invalid_transition'); // that doctor already has a login
      refused(await db().rpc(owner(), 'set_staff_active', { p_clinic: q().clinic, p_user_id: q().owner, p_active: false }), 'invalid_transition');
      refused(await db().rpc(owner(), 'set_staff_active', { p_clinic: q().clinic, p_user_id: other, p_active: false }), 'not_found');
      const linked = ok(await db().rpc(db().as(person), 'my_clinics')).clinics.find((c) => c.slug === 'queue-clinic');
      assert.equal(linked.doctor_id, d.id);
    });
  });
}
