// Builds two clinics through the same functions the app uses, so tests start from realistic data.
import assert from 'node:assert/strict';

export const NOW = '2026-03-10T05:30:00Z'; // 11:00 in Kolkata
export const TODAY = '2026-03-10';
export const TOMORROW = '2026-03-11';
export const GENERAL_SESSIONS = [{ start: '10:00', end: '14:00' }, { start: '16:00', end: '19:00' }];
export const CHILD_SESSIONS = [{ start: '09:00', end: '13:00' }];

export const ok = (r) => {
  assert.equal(r?.ok, true, `Expected ok, got ${JSON.stringify(r)}`);
  return r;
};
export const refused = (r, code) => {
  assert.equal(r?.ok, false, `Expected a refusal, got ${JSON.stringify(r)}`);
  if (code) assert.equal(r.code, code, `Expected ${code}, got ${JSON.stringify(r)}`);
  return r;
};

let phoneCounter = 0;
/** A fresh valid mobile number each time. */
export const nextPhone = () => `9${String(100000000 + ++phoneCounter)}`;

export async function buildWorld(db) {
  await db.setNow(NOW);
  const { as, rpc, service } = db;

  const u = {};
  for (const [key, email, name] of [
    ['ownerA', 'owner-a@test.local', 'Asha Owner'], ['recepA', 'recep-a@test.local', 'Ravi Reception'],
    ['docA1', 'doc-a1@test.local', 'Dr Anil'], ['docA2', 'doc-a2@test.local', 'Dr Bela'],
    ['ownerB', 'owner-b@test.local', 'Bimal Owner'], ['recepB', 'recep-b@test.local', 'Rita Reception'],
    ['docB', 'doc-b@test.local', 'Dr Chitra'], ['outsider', 'outsider@test.local', 'Out Sider'],
  ]) u[key] = await db.createUser(email, name);

  const regA = ok(await rpc(as(u.ownerA), 'register_clinic', {
    p_clinic_name: 'Alpha Clinic', p_slug: 'alpha-clinic', p_owner_name: 'Asha Owner', p_phone: '9000000001', p_city: 'Kolkata',
  }));
  const regB = ok(await rpc(as(u.ownerB), 'register_clinic', { p_clinic_name: 'Beta Clinic', p_slug: 'beta-clinic', p_owner_name: 'Bimal Owner' }));
  const clinicA = regA.clinic.id;
  const clinicB = regB.clinic.id;

  const doctor = async (owner, clinic, name, opd, sessions, limit = null, minutes = null) =>
    ok(await rpc(as(owner), 'add_doctor', { p_clinic: clinic, p_name: name, p_opd: opd, p_sessions: sessions, p_daily_limit: limit, p_minutes_per_patient: minutes })).doctor;
  const general = await doctor(u.ownerA, clinicA, 'Dr Anil Sen', 'General OPD', GENERAL_SESSIONS);
  const child = await doctor(u.ownerA, clinicA, 'Dr Bela Roy', 'Child OPD', CHILD_SESSIONS, null, 8);
  const betaDoc = await doctor(u.ownerB, clinicB, 'Dr Chitra Das', 'General OPD', GENERAL_SESSIONS);

  const attach = async (clinic, user, role, doctorId, invitedBy, name) =>
    ok(await rpc(service, 'attach_staff', { p_clinic: clinic, p_user_id: user, p_role: role, p_doctor_id: doctorId, p_invited_by: invitedBy, p_full_name: name }));
  await attach(clinicA, u.recepA, 'receptionist', null, u.ownerA, 'Ravi Reception');
  await attach(clinicA, u.docA1, 'doctor', general.id, u.ownerA, 'Dr Anil Sen');
  await attach(clinicA, u.docA2, 'doctor', child.id, u.ownerA, 'Dr Bela Roy');
  await attach(clinicB, u.recepB, 'receptionist', null, u.ownerB, 'Rita Reception');
  await attach(clinicB, u.docB, 'doctor', betaDoc.id, u.ownerB, 'Dr Chitra Das');

  return { u, clinicA, clinicB, general, child, betaDoc, slugA: 'alpha-clinic', slugB: 'beta-clinic' };
}

/** Public booking helper. */
export async function book(db, w, over = {}) {
  return db.rpc(db.anon, 'book_token', {
    p_slug: w.slugA, p_name: over.name ?? 'Test Patient', p_phone: over.phone ?? nextPhone(),
    p_doctor_id: over.doctor ?? w.general.id, p_date: over.date ?? TODAY,
  });
}

export const SECRET = { diagnosis: 'SECRET-DIAGNOSIS-A', notes: 'SECRET-NOTES-A', advice: 'SECRET-ADVICE-A', drug: 'SECRET-DRUG-A' };
export const P1 = { name: 'Pooja Sharma', phone: '9811111111' };
export const P2 = { name: 'Rahul Verma', phone: '9822222222' };

/** Clinical data in both clinics, so access tests have something to protect. */
export async function seedData(db, w) {
  const { as, rpc } = db;
  const snapshot = async (user, clinic) => ok(await rpc(as(user), 'get_staff_snapshot', { p_clinic: clinic }));
  const tokenOf = async (user, clinic, name) => (await snapshot(user, clinic)).tokens.find((t) => t.patient_name === name);

  // Clinic A: two public bookings, one consultation finished with notes, a prescription and a report file.
  ok(await book(db, w, { name: P1.name, phone: P1.phone }));
  ok(await book(db, w, { name: P2.name, phone: P2.phone, doctor: w.child.id }));
  const t1 = await tokenOf(w.u.recepA, w.clinicA, P1.name);
  ok(await rpc(as(w.u.recepA), 'mark_arrived', { p_token_id: t1.id }));
  ok(await rpc(as(w.u.docA1), 'call_next', { p_doctor_id: w.general.id, p_expected_current: null }));
  ok(await rpc(as(w.u.docA1), 'complete_token', { p_token_id: t1.id }));
  const hist = ok(await rpc(as(w.u.docA1), 'get_patient_history', { p_clinic: w.clinicA, p_patient_id: t1.patient_id }));
  const visitId = hist.visits[0].id;
  ok(await rpc(as(w.u.docA1), 'save_visit', {
    p_clinic: w.clinicA, p_patient_id: t1.patient_id, p_visit_id: visitId, p_title: 'Fever and cough',
    p_notes: SECRET.notes, p_advice: SECRET.advice, p_diagnosis: SECRET.diagnosis,
  }));
  ok(await rpc(as(w.u.docA1), 'save_prescription', {
    p_clinic: w.clinicA, p_visit_id: visitId, p_medicines: [{ name: SECRET.drug, dose: '500 mg', frequency: 'twice a day', duration: '5 days' }], p_instructions: 'Rest',
  }));
  const reportPath = `${w.clinicA}/${t1.patient_id}/11111111-1111-4111-8111-111111111111-lab.pdf`;
  await db.admin.query(`insert into storage.objects (bucket_id, name) values ('patient-reports', $1)`, [reportPath]);
  const report = ok(await rpc(as(w.u.docA1), 'register_report', {
    p_clinic: w.clinicA, p_patient_id: t1.patient_id, p_visit_id: visitId, p_name: 'Blood test', p_path: reportPath,
    p_content_type: 'application/pdf', p_size_bytes: 120000,
  })).report;

  // Clinic B: one patient with a finished consultation.
  const walk = ok(await rpc(as(w.u.recepB), 'add_walk_in', { p_clinic: w.clinicB, p_name: 'Bina Das', p_phone: '9833333333', p_doctor_id: w.betaDoc.id }));
  ok(await rpc(as(w.u.docB), 'call_next', { p_doctor_id: w.betaDoc.id, p_expected_current: null }));
  ok(await rpc(as(w.u.docB), 'complete_token', { p_token_id: walk.token.id }));
  const histB = ok(await rpc(as(w.u.docB), 'get_patient_history', { p_clinic: w.clinicB, p_patient_id: walk.token.patient_id }));
  ok(await rpc(as(w.u.docB), 'save_visit', {
    p_clinic: w.clinicB, p_patient_id: walk.token.patient_id, p_visit_id: histB.visits[0].id, p_title: 'Checkup', p_notes: 'SECRET-NOTES-B', p_advice: 'x', p_diagnosis: 'SECRET-DIAGNOSIS-B',
  }));

  return { tokenP1: t1, patientP1: t1.patient_id, visitP1: visitId, report, reportPath, patientB: walk.token.patient_id, tokenB: walk.token };
}
