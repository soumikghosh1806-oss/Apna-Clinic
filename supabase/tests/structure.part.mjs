import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { failure } from './harness.mjs';
import { ok, refused } from './world.mjs';

const TABLES = ['appointments', 'audit_log', 'booking_verifications', 'clinic_invitations', 'clinic_memberships', 'clinic_settings', 'clinics', 'doctor_schedule_exceptions', 'doctor_schedules', 'doctors',
  'email_events', 'patient_reports', 'patients', 'prescriptions', 'profiles', 'queue_tokens', 'visits'];
const PUBLIC_FUNCTIONS = ['book_token', 'cancel_my_token', 'directory_filters', 'directory_search', 'get_my_position', 'get_my_token', 'get_public_clinic', 'get_public_queue'];

export function structureTests(ctx) {
  describe('schema and grants', () => {
    it('has the 12 original tables plus audit_log, invitations, the email log, schedule exceptions and verifications, all with row level security on', async () => {
      const { rows } = await ctx.db.admin.query(
        `select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1`);
      assert.deepEqual(rows.map((r) => r.relname), TABLES);
      assert.ok(rows.every((r) => r.relrowsecurity), 'every table has RLS on');
    });

    it('gives the public (anon) role no table access at all', async () => {
      const { rows } = await ctx.db.admin.query(
        `select t, p from unnest($1::text[]) t, unnest(array['select','insert','update','delete','truncate','references','trigger']) p
         where has_table_privilege('anon', 'public.' || t, p)`, [TABLES]);
      assert.deepEqual(rows, []);
    });

    it('lets signed in users read tables but never write them directly', async () => {
      const { rows } = await ctx.db.admin.query(
        `select t, p from unnest($1::text[]) t, unnest(array['insert','update','delete','truncate','references','trigger']) p
         where has_table_privilege('authenticated', 'public.' || t, p) and not (t = 'profiles' and p = 'update')`, [TABLES]);
      assert.deepEqual(rows, []);
      const cols = await ctx.db.admin.query(
        `select c from unnest(array['id','full_name','phone','email','created_at']) c where has_column_privilege('authenticated', 'public.profiles', c, 'update')`);
      assert.deepEqual(cols.rows.map((r) => r.c).sort(), ['full_name', 'phone']);
    });

    it('lets the public call only the eight patient functions', async () => {
      const { rows } = await ctx.db.admin.query(
        `select p.proname from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
         and p.prokind = 'f' and has_function_privilege('anon', p.oid, 'execute') order by 1`);
      assert.deepEqual(rows.map((r) => r.proname), PUBLIC_FUNCTIONS);
    });

    it('keeps the private schema and the server only function away from browsers', async () => {
      const r = await ctx.db.admin.query(`select has_schema_privilege('anon', 'private', 'usage') as a, has_schema_privilege('authenticated', 'private', 'usage') as b,
        has_function_privilege('authenticated', 'public.attach_staff(uuid,uuid,text,uuid,uuid,text)', 'execute') as c,
        has_function_privilege('anon', 'public.attach_staff(uuid,uuid,text,uuid,uuid,text)', 'execute') as d,
        has_function_privilege('service_role', 'public.attach_staff(uuid,uuid,text,uuid,uuid,text)', 'execute') as e,
        has_function_privilege('authenticated', 'public.rls_auto_enable()', 'execute') as f`);
      assert.deepEqual(r.rows[0], { a: false, b: true, c: false, d: false, e: true, f: false });
    });

    it('removed the old public helper functions that anyone could call', async () => {
      const { rows } = await ctx.db.admin.query(
        `select proname from pg_proc where pronamespace = 'public'::regnamespace and proname in ('is_clinic_member', 'is_clinic_manager', 'is_clinic_owner')`);
      assert.deepEqual(rows, []);
    });

    it('still switches row level security on for a table created later', async () => {
      await ctx.db.admin.query('create table public.zz_probe (id int)');
      const { rows } = await ctx.db.admin.query(`select relrowsecurity from pg_class where oid = 'public.zz_probe'::regclass`);
      await ctx.db.admin.query('drop table public.zz_probe');
      assert.equal(rows[0].relrowsecurity, true);
    });

    it('creates a private bucket for reports with a size and type limit', async () => {
      const { rows } = await ctx.db.admin.query(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'patient-reports'`);
      assert.equal(rows[0].public, false);
      assert.equal(Number(rows[0].file_size_limit), 10485760);
      assert.deepEqual([...rows[0].allowed_mime_types].sort(), ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
    });

    it('creates a profile row for every new sign in', async () => {
      const id = await ctx.db.createUser('profile-check@test.local', 'Profile Check');
      const { rows } = await ctx.db.admin.query('select full_name, email from public.profiles where id = $1', [id]);
      assert.deepEqual(rows[0], { full_name: 'Profile Check', email: 'profile-check@test.local' });
    });

    it('rejects bad data at the table level too', async () => {
      const { admin } = ctx.db;
      const { clinicA, general } = ctx.w;
      // Every one of these must be refused by a check constraint (23514), so a rule that goes missing fails loudly.
      const bad = async (sql, params = []) => assert.equal((await failure(admin.query(sql, params))).code, '23514');
      await bad(`insert into public.patients (clinic_id, name, phone) values ($1, 'Valid Name', '12345')`, [clinicA]);
      await bad(`insert into public.patients (clinic_id, name, phone) values ($1, 'X', '9123456789')`, [clinicA]);
      await bad(`update public.clinic_settings set daily_token_limit = 501 where clinic_id = $1`, [clinicA]);
      await bad(`insert into public.doctor_schedules (clinic_id, doctor_id, day_of_week, start_time, end_time) values ($1, $2, 7, '09:00', '10:00')`, [clinicA, general.id]);
      await bad(`insert into public.patient_reports (clinic_id, patient_id, report_name, file_path)
                 select $1, id, 'x', 'other-clinic/abc/file.pdf' from public.patients where clinic_id = $1 limit 1`, [clinicA]);
    });
  });

  describe('clinic registration', () => {
    const who = (id) => ctx.db.as(id);
    const reg = (id, over = {}) => ctx.db.rpc(who(id), 'register_clinic',
      { p_clinic_name: 'Gamma Clinic', p_slug: 'gamma-clinic', p_owner_name: 'Gita Owner', ...over });

    it('creates the clinic, its settings and an owner membership', async () => {
      const id = await ctx.db.createUser('gamma@test.local', 'Gita');
      const r = ok(await reg(id));
      assert.equal(r.clinic.slug, 'gamma-clinic');
      const m = await ctx.db.admin.query('select role, is_active from public.clinic_memberships where clinic_id = $1 and user_id = $2', [r.clinic.id, id]);
      assert.deepEqual(m.rows, [{ role: 'owner', is_active: true }]);
      const s = await ctx.db.admin.query('select daily_token_limit, average_consultation_minutes, online_booking_enabled, max_online_bookings_per_phone_per_day from public.clinic_settings where clinic_id = $1', [r.clinic.id]);
      assert.deepEqual(s.rows, [{ daily_token_limit: 100, average_consultation_minutes: 10, online_booking_enabled: true, max_online_bookings_per_phone_per_day: 4 }]);
    });

    it('needs a signed in user', async () => {
      const e = await failure(ctx.db.rpc(ctx.db.anon, 'register_clinic', { p_clinic_name: 'Nope Clinic', p_slug: 'nope-clinic', p_owner_name: 'No Body' }));
      assert.equal(e.code, '42501', 'the public may not even call this function');
      const none = await ctx.db.admin.query(`select count(*)::int as n from public.clinics where slug = 'nope-clinic'`);
      assert.equal(none.rows[0].n, 0);
    });

    it('refuses a slug that is taken, reserved or badly formed, and says which field', async () => {
      const id = await ctx.db.createUser('slugs@test.local', 'Slug Tester');
      const taken = refused(await reg(id, { p_slug: 'alpha-clinic' }), 'slug_taken');
      assert.ok(taken.field_errors.slug);
      for (const slug of ['admin', 'UPPER', 'a', 'has space', '-lead', 'trail-', 'double--dash', 'x'.repeat(41)]) {
        const r = await reg(id, { p_slug: slug });
        if (slug === 'UPPER') { ok(r); continue; } // upper case is folded to lower case, which is fine
        refused(r, 'invalid_input');
        assert.ok(r.field_errors.slug, `slug ${slug}`);
      }
    });

    it('checks the clinic name, owner name, phone and time zone', async () => {
      const id = await ctx.db.createUser('fields@test.local', 'Field Tester');
      const r = refused(await reg(id, { p_clinic_name: 'x', p_owner_name: '', p_phone: '123', p_timezone: 'Mars/Base' }), 'invalid_input');
      assert.deepEqual(Object.keys(r.field_errors).sort(), ['clinicName', 'ownerName', 'phone', 'timezone']);
    });

    it('limits one account to five clinics', async () => {
      const id = await ctx.db.createUser('many@test.local', 'Many Clinics');
      for (let i = 1; i <= 5; i += 1) ok(await reg(id, { p_slug: `many-clinic-${i}`, p_clinic_name: `Many ${i}` }));
      refused(await reg(id, { p_slug: 'many-clinic-6', p_clinic_name: 'Many 6' }), 'invalid_input');
    });

    it('lists the clinics a user works in, and nothing for other people', async () => {
      const mine = ok(await ctx.db.rpc(who(ctx.w.u.recepA), 'my_clinics'));
      assert.deepEqual(mine.clinics.map((c) => [c.slug, c.role]), [['alpha-clinic', 'receptionist']]);
      const doc = ok(await ctx.db.rpc(who(ctx.w.u.docA1), 'my_clinics'));
      assert.equal(doc.clinics[0].doctor_id, ctx.w.general.id);
      const none = ok(await ctx.db.rpc(who(ctx.w.u.outsider), 'my_clinics'));
      assert.deepEqual(none.clinics, []);
    });
  });
}
