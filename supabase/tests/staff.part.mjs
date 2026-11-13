// Migration 7: staff accounts with a temporary password, forced first password change, and consented invitations.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { failure } from './harness.mjs';
import { ok, refused } from './world.mjs';

export function staffTests(ctx) {
  describe('staff provisioning (temporary password and invitations)', () => {
    let db, as, rpc, service, owner, clinic, slug;
    const mk = async (email, name) => db.createUser(email, name);
    const DOC = { specialization: 'Dermatologist', qualification: 'MBBS, MD', phone: '9876543210', consultation_fee: '400', opd: 'Skin OPD' };
    const pre = (over = {}) => rpc(service, 'staff_precheck', {
      p_clinic: clinic, p_email: 'new.person@test.local', p_role: 'receptionist', p_doctor_id: null, p_inviter: owner,
      p_full_name: 'New Person', p_new_doctor: null, ...over });
    const provision = (user, over = {}) => rpc(service, 'provision_staff', {
      p_clinic: clinic, p_user_id: user, p_role: 'receptionist', p_doctor_id: null, p_new_doctor: null, p_inviter: owner,
      p_full_name: 'New Person', p_must_change: true, ...over });

    before(async () => {
      db = ctx.db; ({ as, rpc, service } = db);
      owner = await mk('staff-lab-owner@test.local', 'Lab Owner');
      const reg = ok(await rpc(as(owner), 'register_clinic', { p_clinic_name: 'Staff Lab', p_slug: 'staff-lab', p_owner_name: 'Lab Owner' }));
      clinic = reg.clinic.id; slug = 'staff-lab';
    });

    it('lets only the clinic owner (checked by the server function) pre-check or create staff', async () => {
      const stranger = await mk('lab-stranger@test.local', 'Stranger');
      refused(await pre({ p_inviter: stranger }), 'forbidden');
      refused(await provision(await mk('lab-x1@test.local', 'X One'), { p_inviter: stranger }), 'forbidden');
    });

    it('keeps the server functions away from browsers and the public', async () => {
      for (const [fn, args] of [
        ['staff_precheck', { p_clinic: clinic, p_email: 'a@b.co', p_role: 'receptionist', p_doctor_id: null, p_inviter: owner }],
        ['finish_first_login', { p_user_id: owner }],
      ]) {
        await failure(rpc(as(owner), fn, args));
        await failure(rpc(db.anon, fn, args));
      }
    });

    it('reports what an email address already is, and validates the details', async () => {
      assert.equal((await pre()).state, 'new');
      const e = refused(await pre({ p_full_name: 'A1', p_role: 'doctor' }), 'invalid_input');
      assert.ok(e.field_errors.fullName && e.field_errors.specialization);
      const e2 = refused(await pre({ p_role: 'doctor', p_new_doctor: { specialization: 'X', phone: '123', consultation_fee: '-5' } }), 'invalid_input');
      assert.ok(e2.field_errors.specialization && e2.field_errors.doctorPhone && e2.field_errors.consultationFee);
      refused(await pre({ p_role: 'admin' }), 'invalid_input');
    });

    it('creates a receptionist who cannot do anything until the password is changed', async () => {
      const u = await mk('lab-recep@test.local', 'Rina Recep');
      ok(await provision(u, { p_full_name: 'Rina Recep' }));
      const me = ok(await rpc(as(u), 'my_clinics'));
      assert.equal(me.must_change_password, true);
      assert.equal(me.clinics.length, 1, 'the membership exists so the app can show the forced change screen');
      refused(await rpc(as(u), 'get_staff_snapshot', { p_clinic: clinic }), 'forbidden');
      refused(await rpc(as(u), 'add_walk_in', { p_clinic: clinic, p_name: 'Walk In', p_phone: '9111111111', p_doctor_id: ctx.w.general.id }), 'forbidden');
      assert.equal((await db.query(as(u), 'select id from public.patients')).length, 0);
      assert.equal((await db.query(as(u), 'select id from public.clinics')).length, 0, 'no clinic rows are visible either');

      ok(await rpc(service, 'finish_first_login', { p_user_id: u }));
      const after = ok(await rpc(as(u), 'my_clinics'));
      assert.equal(after.must_change_password, false);
      ok(await rpc(as(u), 'get_staff_snapshot', { p_clinic: clinic }));
      const audit = await db.admin.query(`select action from public.audit_log where clinic_id = $1 and entity_id = $2 order by id`, [clinic, u]);
      assert.deepEqual(audit.rows.map((r) => r.action), ['staff.create', 'staff.password_changed']);
    });

    it('creates a doctor with professional details and a login, with no timings yet', async () => {
      const u = await mk('lab-doc@test.local', 'Dr Dev Skin');
      const r = ok(await provision(u, { p_role: 'doctor', p_new_doctor: DOC, p_full_name: 'Dr Dev Skin' }));
      const d = (await db.admin.query('select * from public.doctors where id = $1', [r.doctor_id])).rows[0];
      assert.equal(d.profile_id, u);
      assert.equal(d.specialization, 'Dermatologist');
      assert.equal(d.qualification, 'MBBS, MD');
      assert.equal(d.phone, '9876543210');
      assert.equal(Number(d.consultation_fee), 400);
      assert.equal(d.opd_name, 'Skin OPD');
      assert.equal((await db.admin.query('select count(*)::int n from public.doctor_schedules where doctor_id = $1', [d.id])).rows[0].n, 0);
    });

    it('links a new login to an existing doctor without one, and refuses a doctor who has a login', async () => {
      const free = ok(await rpc(as(owner), 'add_doctor', { p_clinic: clinic, p_name: 'Dr Free Doc', p_opd: 'Free OPD', p_sessions: [{ start: '10:00', end: '12:00' }] })).doctor;
      const u = await mk('lab-doc2@test.local', 'Dr Free Doc');
      ok(await provision(u, { p_role: 'doctor', p_doctor_id: free.id, p_full_name: 'Dr Free Doc' }));
      const u2 = await mk('lab-doc3@test.local', 'Dr Other');
      refused(await provision(u2, { p_role: 'doctor', p_doctor_id: free.id }), 'invalid_transition');
      refused(await provision(u2, { p_role: 'doctor' }), 'invalid_input');
    });

    it('refuses a duplicate and says the address is already on the team', async () => {
      const u = await mk('lab-dup@test.local', 'Dup Person');
      ok(await provision(u, { p_full_name: 'Dup Person' }));
      refused(await provision(u), 'duplicate');
      const r = await pre({ p_email: 'LAB-DUP@test.local' });
      assert.equal(r.state, 'already_member');
    });

    it('treats an existing account elsewhere as an existing user, never attaching it', async () => {
      const outsider = ctx.w.u.outsider;
      const r = await pre({ p_email: 'outsider@test.local' });
      assert.equal(r.state, 'existing_user');
      assert.equal(r.user_id, outsider);
      const members = await db.admin.query('select 1 from public.clinic_memberships where clinic_id = $1 and user_id = $2', [clinic, outsider]);
      assert.equal(members.rowCount, 0);
    });

    describe('invitations (consent)', () => {
      let invitee, inviteId;
      before(async () => { invitee = await mk('lab-invitee@test.local', 'Ivy Invitee'); });

      it('creates a pending invitation without giving any access', async () => {
        const r = ok(await rpc(service, 'create_invitation', { p_clinic: clinic, p_user_id: invitee, p_role: 'doctor', p_doctor_id: null, p_new_doctor: DOC, p_inviter: owner }));
        inviteId = r.invitation_id;
        assert.equal((await db.admin.query('select 1 from public.clinic_memberships where user_id = $1', [invitee])).rowCount, 0);
        const mine = ok(await rpc(as(invitee), 'my_invitations'));
        assert.equal(mine.invitations.length, 1);
        assert.equal(mine.invitations[0].clinic_name, 'Staff Lab');
        assert.equal(ok(await rpc(as(invitee), 'my_clinics')).pending_invitations, 1);
        const list = ok(await rpc(as(owner), 'list_staff', { p_clinic: clinic }));
        assert.equal(list.pending_invitations.length, 1);
      });

      it('keeps the invitation private to the invited person', async () => {
        assert.equal(ok(await rpc(as(ctx.w.u.outsider), 'my_invitations')).invitations.length, 0);
        refused(await rpc(as(ctx.w.u.outsider), 'respond_invitation', { p_invitation: inviteId, p_accept: true }), 'not_found');
        await failure(db.query(as(invitee), 'select id from public.clinic_invitations')); // no direct table access
      });

      it('attaches the person, creating the doctor record, only when they accept', async () => {
        const r = ok(await rpc(as(invitee), 'respond_invitation', { p_invitation: inviteId, p_accept: true }));
        assert.equal(r.accepted, true);
        const m = (await db.admin.query('select role, is_active from public.clinic_memberships where user_id = $1 and clinic_id = $2', [invitee, clinic])).rows;
        assert.deepEqual(m, [{ role: 'doctor', is_active: true }]);
        const d = (await db.admin.query('select specialization from public.doctors where profile_id = $1', [invitee])).rows;
        assert.deepEqual(d, [{ specialization: 'Dermatologist' }]);
        refused(await rpc(as(invitee), 'respond_invitation', { p_invitation: inviteId, p_accept: true }), 'stale');
        const actions = (await db.admin.query(`select action from public.audit_log where clinic_id = $1 and entity_id = $2 order by id`, [clinic, invitee])).rows.map((x) => x.action);
        assert.deepEqual(actions, ['staff.invitation_sent', 'staff.invitation_accepted']);
      });

      it('lets a person decline, lets the owner revoke, and ignores expired invitations', async () => {
        const a = await mk('lab-decl@test.local', 'Dee Cline');
        const i1 = ok(await rpc(service, 'create_invitation', { p_clinic: clinic, p_user_id: a, p_role: 'receptionist', p_doctor_id: null, p_new_doctor: null, p_inviter: owner })).invitation_id;
        assert.equal(ok(await rpc(as(a), 'respond_invitation', { p_invitation: i1, p_accept: false })).accepted, false);
        assert.equal((await db.admin.query('select 1 from public.clinic_memberships where user_id = $1', [a])).rowCount, 0);

        const i2 = ok(await rpc(service, 'create_invitation', { p_clinic: clinic, p_user_id: a, p_role: 'receptionist', p_doctor_id: null, p_new_doctor: null, p_inviter: owner })).invitation_id;
        const i3 = ok(await rpc(service, 'create_invitation', { p_clinic: clinic, p_user_id: a, p_role: 'receptionist', p_doctor_id: null, p_new_doctor: null, p_inviter: owner })).invitation_id;
        refused(await rpc(as(a), 'respond_invitation', { p_invitation: i2, p_accept: true }), 'stale');
        ok(await rpc(as(owner), 'revoke_invitation', { p_clinic: clinic, p_invitation: i3 }));
        refused(await rpc(as(a), 'respond_invitation', { p_invitation: i3, p_accept: true }), 'stale');

        const i4 = ok(await rpc(service, 'create_invitation', { p_clinic: clinic, p_user_id: a, p_role: 'receptionist', p_doctor_id: null, p_new_doctor: null, p_inviter: owner })).invitation_id;
        await db.admin.query(`update public.clinic_invitations set expires_at = private.clock() - interval '1 minute' where id = $1`, [i4]);
        assert.equal(ok(await rpc(as(a), 'my_invitations')).invitations.length, 0);
        refused(await rpc(as(a), 'respond_invitation', { p_invitation: i4, p_accept: true }), 'stale');
      });

      it('does not let a non-owner revoke, and a stranger cannot create invitations', async () => {
        refused(await rpc(as(ctx.w.u.recepA), 'revoke_invitation', { p_clinic: ctx.w.clinicA, p_invitation: inviteId }), 'forbidden');
        refused(await rpc(service, 'create_invitation', { p_clinic: clinic, p_user_id: invitee, p_role: 'receptionist', p_doctor_id: null, p_new_doctor: null, p_inviter: ctx.w.u.outsider }), 'forbidden');
      });
    });

    it('limits how many staff the owner can add per hour', async () => {
      const o2 = await mk('lab-owner2@test.local', 'Rate Owner');
      const c2 = ok(await rpc(as(o2), 'register_clinic', { p_clinic_name: 'Rate Lab', p_slug: 'rate-lab', p_owner_name: 'Rate Owner' })).clinic.id;
      for (let i = 0; i < 20; i += 1) {
        const u = await mk(`rate-${i}@test.local`, 'Rate Person');
        ok(await rpc(service, 'provision_staff', { p_clinic: c2, p_user_id: u, p_role: 'receptionist', p_doctor_id: null, p_new_doctor: null, p_inviter: o2, p_full_name: 'Rate Person', p_must_change: true }));
      }
      refused(await rpc(service, 'staff_precheck', { p_clinic: c2, p_email: 'one.more@test.local', p_role: 'receptionist', p_doctor_id: null, p_inviter: o2, p_full_name: 'One More' }), 'rate_limited');
    });

    it('logs email outcomes with a masked address and lets only the owner read them', async () => {
      await db.rpc(service, 'log_email_event', { p_clinic: clinic, p_template: 'staff_activation', p_recipient: 'person@example.com', p_status: 'failed', p_provider_id: null, p_error: 'domain is not verified' });
      const rows = await db.query(as(owner), 'select template, recipient_hint, status, error from public.email_events where clinic_id = $1', [clinic]);
      assert.deepEqual(rows, [{ template: 'staff_activation', recipient_hint: 'p***@example.com', status: 'failed', error: 'domain is not verified' }]);
      assert.equal((await db.query(as(ctx.w.u.ownerB), 'select id from public.email_events')).length, 0);
      assert.equal((await db.query(as(ctx.w.u.recepA), 'select id from public.email_events')).length, 0);
    });
  });
}
