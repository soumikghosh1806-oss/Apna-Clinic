import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { failure } from './harness.mjs';
import { ok, refused, SECRET, P1 } from './world.mjs';

const TABLES = ['appointments', 'audit_log', 'clinic_memberships', 'clinic_settings', 'clinics', 'doctor_schedules', 'doctors',
  'patient_reports', 'patients', 'prescriptions', 'profiles', 'queue_tokens', 'visits'];
const STAFF_FUNCTIONS = {
  get_staff_snapshot: (w) => ({ p_clinic: w.clinicA }),
  add_walk_in: (w) => ({ p_clinic: w.clinicA, p_name: 'Walk In', p_phone: '9876543210', p_doctor_id: w.general.id }),
  mark_arrived: (w, s) => ({ p_token_id: s.tokenP1.id }),
  call_next: (w) => ({ p_doctor_id: w.general.id }),
  search_patients: (w) => ({ p_clinic: w.clinicA, p_query: 'Pooja' }),
  get_patient_visit_list: (w, s) => ({ p_clinic: w.clinicA, p_patient_id: s.patientP1 }),
  get_patient_history: (w, s) => ({ p_clinic: w.clinicA, p_patient_id: s.patientP1 }),
  save_visit: (w, s) => ({ p_clinic: w.clinicA, p_patient_id: s.patientP1, p_visit_id: null, p_title: 'x', p_notes: 'y', p_advice: 'z' }),
  save_prescription: (w, s) => ({ p_clinic: w.clinicA, p_visit_id: s.visitP1, p_medicines: [{ name: 'x' }] }),
  update_clinic_settings: (w) => ({ p_clinic: w.clinicA, p_clinic_name: 'Hacked', p_online_booking_enabled: false, p_default_daily_limit: 5, p_default_minutes_per_patient: 5 }),
  list_staff: (w) => ({ p_clinic: w.clinicA }),
  get_report_series: (w) => ({ p_clinic: w.clinicA }),
  my_clinics: () => ({}),
  authorize_report_download: (w, s) => ({ p_report_id: s.report.id }),
  attach_staff: (w, s) => ({ p_clinic: w.clinicA, p_user_id: w.u.outsider, p_role: 'doctor', p_doctor_id: w.general.id, p_invited_by: w.u.ownerA }),
};

export function accessTests(ctx) {
  const db = () => ctx.db;
  const as = (key) => ctx.db.as(ctx.w.u[key]);
  const count = async (who, table, where = 'true', params = []) =>
    Number((await ctx.db.query(who, `select count(*)::int as n from public.${table} where ${where}`, params))[0].n);

  describe('who can read which tables', () => {
    it('shows the public nothing: every table refuses an anonymous reader', async () => {
      for (const t of TABLES) {
        const e = await failure(ctx.db.query(ctx.db.anon, `select * from public.${t} limit 1`));
        assert.equal(e.code, '42501', `${t} should refuse anon`);
      }
    });

    it('shows a signed in stranger nothing of any clinic', async () => {
      for (const t of TABLES.filter((x) => x !== 'profiles')) assert.equal(await count(as('outsider'), t), 0, t);
    });

    it('lets each clinic see only its own rows', async () => {
      const { clinicA } = ctx.w;
      for (const key of ['ownerB', 'recepB', 'docB']) {
        for (const t of ['appointments', 'clinic_settings', 'doctors', 'doctor_schedules', 'patients', 'queue_tokens', 'visits', 'prescriptions', 'patient_reports', 'audit_log', 'clinic_memberships']) {
          assert.equal(await count(as(key), t, 'clinic_id = $1', [clinicA]), 0, `${key} reading ${t} of clinic A`);
        }
        assert.equal(await count(as(key), 'clinics', 'id = $1', [clinicA]), 0, `${key} reading clinic A`);
      }
    });

    it('lets a receptionist see patients and the queue but no clinical record', async () => {
      const who = as('recepA');
      for (const t of ['patients', 'queue_tokens', 'appointments', 'doctors', 'doctor_schedules', 'clinic_settings']) assert.ok(await count(who, t) > 0, t);
      assert.equal(await count(who, 'clinics'), 1);
      for (const t of ['visits', 'prescriptions', 'patient_reports', 'audit_log']) assert.equal(await count(who, t), 0, t);
      assert.equal(await count(who, 'clinic_memberships'), 1, 'sees only their own membership');
    });

    it('lets the owner manage the clinic but not read clinical records', async () => {
      const who = as('ownerA');
      for (const t of ['patients', 'queue_tokens', 'audit_log', 'doctors']) assert.ok(await count(who, t) > 0, t);
      assert.equal(await count(who, 'clinic_memberships'), 4, 'owner sees all staff of the clinic');
      for (const t of ['visits', 'prescriptions', 'patient_reports']) assert.equal(await count(who, t), 0, t);
    });

    it('lets a doctor read the clinical records of their clinic, including patients seen by another doctor', async () => {
      for (const key of ['docA1', 'docA2']) {
        const who = as(key);
        for (const t of ['visits', 'prescriptions', 'patient_reports']) assert.ok(await count(who, t) > 0, `${key} ${t}`);
        assert.equal(await count(who, 'audit_log'), 0, 'doctors do not read the audit log');
        assert.equal(await count(who, 'clinic_memberships'), 1);
      }
    });

    it('stops a switched off staff member from seeing anything', async () => {
      const id = await ctx.db.createUser('temp-recep@test.local', 'Temp Recep');
      ok(await ctx.db.rpc(ctx.db.service, 'attach_staff', { p_clinic: ctx.w.clinicA, p_user_id: id, p_role: 'receptionist', p_doctor_id: null, p_invited_by: ctx.w.u.ownerA }));
      assert.ok(await count(ctx.db.as(id), 'patients') > 0);
      ok(await ctx.db.rpc(as('ownerA'), 'set_staff_active', { p_clinic: ctx.w.clinicA, p_user_id: id, p_active: false }));
      assert.equal(await count(ctx.db.as(id), 'patients'), 0);
      refused(await ctx.db.rpc(ctx.db.as(id), 'get_staff_snapshot', { p_clinic: ctx.w.clinicA }), 'forbidden');
      assert.deepEqual(ok(await ctx.db.rpc(ctx.db.as(id), 'my_clinics')).clinics, []);
      ok(await ctx.db.rpc(as('ownerA'), 'set_staff_active', { p_clinic: ctx.w.clinicA, p_user_id: id, p_active: true }));
      assert.ok(await count(ctx.db.as(id), 'patients') > 0);
    });
  });

  describe('direct writes are closed', () => {
    const attempts = (w, s) => [
      `insert into public.queue_tokens (clinic_id, patient_id, doctor_id, token_number, queue_date) values ('${w.clinicA}', '${s.patientP1}', '${w.general.id}', 99, current_date)`,
      `update public.queue_tokens set status = 'completed'`,
      `delete from public.queue_tokens`,
      `insert into public.patients (clinic_id, name, phone) values ('${w.clinicA}', 'Injected Person', '9000011111')`,
      `update public.patients set name = 'Renamed'`,
      `update public.visits set diagnosis = 'changed'`,
      `insert into public.prescriptions (clinic_id, visit_id, patient_id, doctor_id) values ('${w.clinicA}', '${s.visitP1}', '${s.patientP1}', '${w.general.id}')`,
      `update public.clinic_memberships set role = 'owner'`,
      `insert into public.clinic_memberships (clinic_id, user_id, role) values ('${w.clinicA}', '${w.u.outsider}', 'owner')`,
      `update public.clinic_settings set daily_token_limit = 1`,
      `update public.clinics set name = 'Hacked'`,
      `update public.doctors set is_active = false`,
      `insert into public.audit_log (clinic_id, action) values ('${w.clinicA}', 'fake.event')`,
      `delete from public.audit_log`,
      `update public.audit_log set action = 'edited.event'`,
      `delete from public.patient_reports`,
    ];
    it('refuses every direct insert, update and delete, for every role', async () => {
      for (const key of ['ownerA', 'recepA', 'docA1', 'outsider']) {
        for (const sql of attempts(ctx.w, ctx.seed)) {
          const e = await failure(ctx.db.query(as(key), sql));
          assert.equal(e.code, '42501', `${key}: ${sql}`);
        }
      }
    });

    it('lets people change only their own name and phone on their profile', async () => {
      const who = as('recepA');
      await ctx.db.query(who, `update public.profiles set full_name = 'Ravi R', phone = '9000000009' where id = $1`, [ctx.w.u.recepA]);
      const rows = await ctx.db.query(who, 'select full_name from public.profiles');
      assert.deepEqual(rows, [{ full_name: 'Ravi R' }], 'sees only their own profile');
      assert.equal((await failure(ctx.db.query(who, `update public.profiles set email = 'x@y.z' where id = $1`, [ctx.w.u.recepA]))).code, '42501');
      const other = await ctx.db.withRole('authenticated', ctx.w.u.recepA, (c) => c.query(`update public.profiles set full_name = 'Taken Over' where id = $1`, [ctx.w.u.ownerA]));
      assert.equal(other.rowCount, 0, 'another profile is not touched');
      const check = await ctx.db.admin.query('select full_name from public.profiles where id = $1', [ctx.w.u.ownerA]);
      assert.notEqual(check.rows[0].full_name, 'Taken Over');
    });
  });

  describe('functions check the role themselves', () => {
    it('refuses every staff function to the public', async () => {
      for (const [fn, args] of Object.entries(STAFF_FUNCTIONS)) {
        const e = await failure(ctx.db.rpc(ctx.db.anon, fn, args(ctx.w, ctx.seed)));
        assert.equal(e.code, '42501', fn);
      }
    });

    it('refuses the server only function to signed in users', async () => {
      const e = await failure(ctx.db.rpc(as('ownerA'), 'attach_staff', STAFF_FUNCTIONS.attach_staff(ctx.w)));
      assert.equal(e.code, '42501');
    });

    it('keeps clinical functions away from receptionists and owners', async () => {
      const { w, seed } = ctx;
      for (const key of ['recepA', 'ownerA']) {
        refused(await db().rpc(as(key), 'get_patient_history', { p_clinic: w.clinicA, p_patient_id: seed.patientP1 }), 'forbidden');
        refused(await db().rpc(as(key), 'save_visit', STAFF_FUNCTIONS.save_visit(w, seed)), 'forbidden');
        refused(await db().rpc(as(key), 'save_prescription', STAFF_FUNCTIONS.save_prescription(w, seed)), 'forbidden');
        refused(await db().rpc(as(key), 'authorize_report_download', { p_report_id: seed.report.id }), 'not_found');
        refused(await db().rpc(as(key), 'call_next', { p_doctor_id: w.general.id }), 'forbidden');
        refused(await db().rpc(as(key), 'complete_token', { p_token_id: seed.tokenP1.id }), 'forbidden');
      }
    });

    it('keeps owner functions away from receptionists and doctors', async () => {
      const { w } = ctx;
      for (const key of ['recepA', 'docA1']) {
        for (const [fn, args] of [['update_clinic_settings', STAFF_FUNCTIONS.update_clinic_settings(w)], ['list_staff', { p_clinic: w.clinicA }],
          ['add_doctor', { p_clinic: w.clinicA, p_name: 'Dr Nope', p_opd: 'Nope OPD', p_sessions: [{ start: '09:00', end: '10:00' }] }],
          ['remove_doctor', { p_clinic: w.clinicA, p_doctor_id: w.child.id }], ['set_staff_active', { p_clinic: w.clinicA, p_user_id: w.u.docA2, p_active: false }]]) {
          refused(await db().rpc(as(key), fn, args), 'forbidden');
        }
      }
    });

    it('keeps reception functions away from doctors and lets the owner help at the desk', async () => {
      const { w, seed } = ctx;
      refused(await db().rpc(as('docA1'), 'add_walk_in', STAFF_FUNCTIONS.add_walk_in(w)), 'forbidden');
      refused(await db().rpc(as('docA1'), 'mark_arrived', { p_token_id: seed.tokenP1.id }), 'forbidden');
      refused(await db().rpc(as('docA1'), 'mark_no_show', { p_token_id: seed.tokenP1.id }), 'forbidden');
      refused(await db().rpc(as('ownerA'), 'mark_arrived', { p_token_id: seed.tokenP1.id }), 'invalid_transition'); // allowed role, wrong state
    });

    it('keeps one doctor out of another doctor\'s queue and records, but shares patient history inside the clinic', async () => {
      const { w, seed } = ctx;
      refused(await db().rpc(as('docA2'), 'call_next', { p_doctor_id: w.general.id }), 'forbidden');
      refused(await db().rpc(as('docA2'), 'complete_token', { p_token_id: seed.tokenP1.id }), 'forbidden');
      refused(await db().rpc(as('docA2'), 'save_visit', { p_clinic: w.clinicA, p_patient_id: seed.patientP1, p_visit_id: seed.visitP1, p_title: 'Edited', p_notes: 'tampered' }), 'forbidden');
      refused(await db().rpc(as('docA2'), 'save_prescription', { p_clinic: w.clinicA, p_visit_id: seed.visitP1, p_medicines: [{ name: 'tampered' }] }), 'forbidden');
      const hist = ok(await db().rpc(as('docA2'), 'get_patient_history', { p_clinic: w.clinicA, p_patient_id: seed.patientP1 }));
      assert.equal(hist.visits[0].diagnosis, SECRET.diagnosis);
    });

    it('keeps another clinic out of every function', async () => {
      const { w, seed } = ctx;
      for (const key of ['ownerB', 'recepB', 'docB', 'outsider']) {
        refused(await db().rpc(as(key), 'get_staff_snapshot', { p_clinic: w.clinicA }), 'forbidden');
        refused(await db().rpc(as(key), 'search_patients', { p_clinic: w.clinicA, p_query: 'Pooja' }), 'forbidden');
        refused(await db().rpc(as(key), 'get_patient_visit_list', { p_clinic: w.clinicA, p_patient_id: seed.patientP1 }), 'forbidden');
        refused(await db().rpc(as(key), 'get_patient_history', { p_clinic: w.clinicA, p_patient_id: seed.patientP1 }), 'forbidden');
        refused(await db().rpc(as(key), 'add_walk_in', STAFF_FUNCTIONS.add_walk_in(w)), 'forbidden');
        refused(await db().rpc(as(key), 'update_clinic_settings', STAFF_FUNCTIONS.update_clinic_settings(w)), 'forbidden');
        refused(await db().rpc(as(key), 'list_staff', { p_clinic: w.clinicA }), 'forbidden');
        refused(await db().rpc(as(key), 'get_report_series', { p_clinic: w.clinicA }), 'forbidden');
        for (const fn of ['mark_arrived', 'mark_no_show', 'requeue_token', 'complete_token', 'skip_token', 'hold_token', 'resume_token']) {
          refused(await db().rpc(as(key), fn, { p_token_id: seed.tokenP1.id }), 'not_found');
        }
      }
      refused(await db().rpc(as('docB'), 'call_next', { p_doctor_id: w.general.id }), 'doctor_unavailable');
    });

    it('does not let a clinic mix up another clinic\'s patient or visit by passing its own clinic id', async () => {
      const { w, seed } = ctx;
      refused(await db().rpc(as('docB'), 'get_patient_history', { p_clinic: w.clinicB, p_patient_id: seed.patientP1 }), 'not_found');
      refused(await db().rpc(as('docB'), 'save_visit', { p_clinic: w.clinicB, p_patient_id: seed.patientP1, p_visit_id: null, p_title: 'x', p_notes: 'y' }), 'not_found');
      refused(await db().rpc(as('docB'), 'save_prescription', { p_clinic: w.clinicB, p_visit_id: seed.visitP1, p_medicines: [{ name: 'x' }] }), 'not_found');
      refused(await db().rpc(as('recepB'), 'get_patient_visit_list', { p_clinic: w.clinicB, p_patient_id: seed.patientP1 }), 'not_found');
      refused(await db().rpc(as('recepB'), 'add_walk_in', { p_clinic: w.clinicB, p_name: 'Mixed Up', p_phone: '9876500000', p_doctor_id: w.general.id }), 'doctor_unavailable');
    });
  });

  describe('what each role is shown', () => {
    it('shows a receptionist visit dates and titles only', async () => {
      const r = ok(await db().rpc(as('recepA'), 'get_patient_visit_list', { p_clinic: ctx.w.clinicA, p_patient_id: ctx.seed.patientP1 }));
      assert.deepEqual(Object.keys(r.visits[0]).sort(), ['date', 'doctor_name', 'id', 'title']);
      assert.equal(r.visits[0].title, 'Fever and cough');
      const text = JSON.stringify(r);
      for (const secret of Object.values(SECRET)) assert.ok(!text.includes(secret), secret);
    });

    it('keeps clinical text out of the staff snapshot and out of patient search', async () => {
      for (const key of ['recepA', 'ownerA']) {
        const snap = JSON.stringify(ok(await db().rpc(as(key), 'get_staff_snapshot', { p_clinic: ctx.w.clinicA })));
        const found = JSON.stringify(ok(await db().rpc(as(key), 'search_patients', { p_clinic: ctx.w.clinicA, p_query: 'Pooja' })));
        for (const secret of Object.values(SECRET)) assert.ok(!snap.includes(secret) && !found.includes(secret), `${key}: ${secret}`);
        assert.ok(snap.includes(P1.name), 'but patient identity is there for staff');
      }
    });

    it('shows the patient\'s own link only a first name, a token number and the queue', async () => {
      const keyRow = await ctx.db.admin.query('select access_key from public.queue_tokens where id = $1', [ctx.seed.tokenP1.id]);
      const r = ok(await db().rpc(db().anon, 'get_my_token', { p_access_key: keyRow.rows[0].access_key }));
      assert.equal(r.first_name, 'Pooja');
      const text = JSON.stringify(r);
      for (const leak of ['Sharma', P1.phone, ctx.seed.patientP1, ctx.seed.tokenP1.id, SECRET.diagnosis, ctx.w.clinicA]) assert.ok(!text.includes(leak), `leaked ${leak}`);
    });

    it('treats a guessed link as not found', async () => {
      refused(await db().rpc(db().anon, 'get_my_token', { p_access_key: '00000000-0000-4000-8000-000000000000' }), 'not_found');
      refused(await db().rpc(db().anon, 'cancel_my_token', { p_access_key: '00000000-0000-4000-8000-000000000000' }), 'not_found');
    });

    it('shows the waiting room and the booking page no names, phones or ids', async () => {
      const queue = JSON.stringify(ok(await db().rpc(db().anon, 'get_public_queue', { p_slug: ctx.w.slugA })));
      const clinic = JSON.stringify(ok(await db().rpc(db().anon, 'get_public_clinic', { p_slug: ctx.w.slugA })));
      for (const text of [queue, clinic]) {
        for (const leak of ['Pooja', 'Rahul', 'Sharma', P1.phone, 'access_key', 'patient_', 'phone', ctx.w.clinicA]) assert.ok(!text.includes(leak), `leaked ${leak}`);
      }
    });
  });
}
