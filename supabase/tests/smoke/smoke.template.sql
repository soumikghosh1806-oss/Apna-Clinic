do $smoke$
declare
  v_owner uuid := gen_random_uuid(); v_recep uuid := gen_random_uuid(); v_doc uuid := gen_random_uuid();
  v_out uuid := gen_random_uuid(); v_owner2 uuid := gen_random_uuid();
  v_base timestamptz := now(); v_today date;
  res jsonb := '[]'::jsonb; r jsonb; r2 jsonb; r3 jsonb; r4 jsonb; b1 jsonb; b2 jsonb; code text; n int; n2 int; n3 int;
  v_clinic uuid; v_clinic2 uuid; v_dr uuid; v_t1 uuid; v_t2 uuid; v_t3 uuid; v_k1 uuid; v_pat uuid; v_visit uuid; v_rep uuid;
  v_path text; v_slug text := 'smoke-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
begin
  execute $f$ create or replace function private.clock() returns timestamptz language sql stable set search_path = '' as
    $g$ select coalesce(nullif(current_setting('app.fake_now', true), '')::timestamptz, now()) $g$ $f$;

  insert into auth.users (id, email, raw_user_meta_data) values
    (v_owner, 'owner-' || v_owner || '@smoke.test', '{"full_name":"Smoke Owner"}'),
    (v_recep, 'recep-' || v_recep || '@smoke.test', '{"full_name":"Smoke Reception"}'),
    (v_doc, 'doc-' || v_doc || '@smoke.test', '{"full_name":"Dr Smoke"}'),
    (v_out, 'out-' || v_out || '@smoke.test', '{}'),
    (v_owner2, 'owner2-' || v_owner2 || '@smoke.test', '{"full_name":"Other Owner"}');
  @chk 'every new sign in gets a profile' | (select count(*) from public.profiles where id in (v_owner, v_recep, v_doc, v_out, v_owner2)) = 5

  -- Registration and staff
  @as v_owner
  r := public.register_clinic('Smoke Clinic', v_slug, 'Smoke Owner');
  @root
  v_clinic := (r->'clinic'->>'id')::uuid;
  @chk 'owner registers a clinic and becomes its owner' | (r->>'ok')::boolean and exists (select 1 from public.clinic_memberships where clinic_id = v_clinic and user_id = v_owner and role = 'owner')
  @as v_owner2
  r := public.register_clinic('Other Clinic', v_slug || '-b', 'Other Owner');
  @root
  v_clinic2 := (r->'clinic'->>'id')::uuid;
  @anon
  @try format('select public.register_clinic(%L, %L, %L)', 'X Clinic', 'x-clinic-zz', 'X Owner')
  @root
  @chk 'the public cannot register a clinic' | code = '42501'
  @as v_owner
  r := public.add_doctor(v_clinic, 'Dr Smoke', 'General OPD', '[{"start":"00:00","end":"23:59"}]'::jsonb);
  @root
  v_dr := (r->'doctor'->>'id')::uuid;
  @chk 'owner adds a doctor with OPD timings' | (r->>'ok')::boolean and v_dr is not null
  @svc
  r := public.attach_staff(v_clinic, v_recep, 'receptionist', null, v_owner, 'Smoke Reception');
  r2 := public.attach_staff(v_clinic, v_doc, 'doctor', v_dr, v_owner, 'Dr Smoke');
  @root
  @chk 'the server side invite function attaches a receptionist and a doctor' | (r->>'ok')::boolean and (r2->>'ok')::boolean
  @as v_owner
  @try format('select public.attach_staff(%L, %L, %L, %L, %L)', v_clinic, v_out, 'doctor', v_dr, v_owner)
  @root
  @chk 'a signed in browser cannot call the invite function' | code = '42501'

  -- Public booking
  @anon
  r := public.get_public_clinic(v_slug);
  @root
  v_today := (r->>'today')::date;
  @chk 'the booking page lists the doctor and no staff details' | (r->>'ok')::boolean and jsonb_array_length(r->'doctors') = 1 and r::text not like '%@smoke.test%' and r::text not like '%' || v_owner::text || '%'
  @anon
  b1 := public.book_token(v_slug, 'Asha Verma', '9876543210', v_dr, v_today);
  b2 := public.book_token(v_slug, 'Bala Kumar', '+91 98765 43211', v_dr, v_today);
  r := public.book_token(v_slug, 'Asha  Verma', '09876543210', v_dr, v_today);
  r2 := public.book_token(v_slug, 'Bad Phone', '12345', v_dr, v_today);
  r3 := public.book_token(v_slug, 'Far Date', '9876543288', v_dr, v_today + 5);
  @root
  @chk 'online booking gives numbers 1 and 2' | (b1->'token'->>'number')::int = 1 and (b2->'token'->>'number')::int = 2
  @chk 'the public never gets internal ids back' | b1->'token'->>'id' is null and b1->'token'->>'patient_id' is null and b1->>'access_key' is not null
  @chk 'the same person cannot hold two live tokens' | r->>'code' = 'duplicate' and r->>'existing_token_id' is null
  @chk 'a bad phone number is refused with a field error' | r2->>'code' = 'invalid_input' and jsonb_exists(r2->'field_errors', 'phone')
  @chk 'booking more than tomorrow is refused' | r3->>'code' = 'invalid_date'
  v_k1 := (b1->>'access_key')::uuid;
  @anon
  r := public.get_my_token(v_k1);
  r2 := public.get_public_queue(v_slug, v_dr, null);
  r3 := public.get_my_token(gen_random_uuid());
  @root
  @chk 'a patient sees their number and first name only' | r->>'first_name' = 'Asha' and r::text not like '%Verma%' and r::text not like '%9876543210%'
  @chk 'the waiting room shows numbers and no names or phones' | (r2->>'ok')::boolean and r2::text not like '%Asha%' and r2::text not like '%Bala%' and r2::text not like '%98765%'
  @chk 'a guessed link finds nothing' | r3->>'code' = 'not_found'
  @anon
  @try 'select count(*) from public.patients'
  @root
  @chk 'the public cannot read any table directly' | code = '42501'
  @anon
  @try format('select public.get_staff_snapshot(%L)', v_clinic)
  @root
  @chk 'the public cannot call staff functions' | code = '42501'

  -- Reception and the queue
  @as v_recep
  r := public.add_walk_in(v_clinic, 'Chitra Das', '9876543212', v_dr, false);
  r2 := public.get_staff_snapshot(v_clinic);
  @root
  @chk 'reception adds a walk in as number 3, already arrived' | (r->>'ok')::boolean and (r->'token'->>'number')::int = 3 and r->'token'->>'source' = 'walk_in' and r->'token'->>'arrived_at' is not null
  @chk 'the staff snapshot shows the three tokens, with no clinical data' | jsonb_array_length(r2->'tokens') = 3 and r2::text not like '%diagnosis%' and r2::text not like '%medicines%'
  v_t1 := (select (t->>'id')::uuid from jsonb_array_elements(r2->'tokens') t where (t->>'number')::int = 1);
  v_t2 := (select (t->>'id')::uuid from jsonb_array_elements(r2->'tokens') t where (t->>'number')::int = 2);
  v_t3 := (select (t->>'id')::uuid from jsonb_array_elements(r2->'tokens') t where (t->>'number')::int = 3);
  v_pat := (select patient_id from public.queue_tokens where id = v_t1);
  @as v_recep
  r := public.mark_arrived(v_t1);
  r2 := public.call_next(v_dr, null);
  r3 := public.get_patient_history(v_clinic, v_pat);
  @root
  @chk 'reception marks arrival' | (r->>'ok')::boolean and r->'token'->>'arrival_source' = 'reception'
  @chk 'reception cannot press NEXT' | r2->>'code' = 'forbidden'
  @chk 'reception cannot read clinical history' | r3->>'code' = 'forbidden'

  @as v_doc
  r := public.call_next(v_dr, null);
  @root
  @chk 'NEXT calls token 1 first' | (r->>'ok')::boolean and (r->'called'->>'number')::int = 1
  @tick 10
  @as v_doc
  r := public.call_next(v_dr, v_t1);
  r2 := public.call_next(v_dr, null);
  r3 := public.call_next(v_dr, v_t2);
  @root
  @chk 'NEXT finishes token 1 and calls token 2' | (r->>'ok')::boolean and (r->'completed'->>'number')::int = 1 and (r->'called'->>'number')::int = 2
  @chk 'a press from an out of date screen changes nothing' | r2->>'code' = 'stale'
  @chk 'a quick second press does not skip the patient just called' | r3->>'code' = 'too_soon'
  @chk 'finishing a consultation made exactly one visit' | (select count(*) from public.visits where queue_token_id = v_t1) = 1
  @as v_doc
  r := public.hold_token(v_t2);
  r2 := public.resume_token(v_t2);
  r3 := public.call_next(v_dr, null);
  r4 := public.skip_token(v_t2);
  @root
  @chk 'hold, resume, call and skip work for the doctor' | (r->>'ok')::boolean and (r2->>'ok')::boolean and (r3->'called'->>'number')::int = 2 and r4->'token'->>'status' = 'skipped'
  @as v_recep
  r := public.requeue_token(v_t2);
  @root
  @as v_doc
  r2 := public.call_next(v_dr, null);
  @root
  @chk 'a skipped patient returned by reception goes to the end of the line' | (r->>'ok')::boolean and (r2->'called'->>'number')::int = 3
  @tick 30
  @as v_doc
  r := public.call_next(v_dr, v_t3);
  r2 := public.complete_token(v_t2);
  @root
  @chk 'the queue ends in order 3 then 2, both completed' | (r->'called'->>'number')::int = 2 and (r2->>'ok')::boolean and (select count(*) from public.queue_tokens where doctor_id = v_dr and status = 'completed') = 3
  @as v_doc
  r := public.complete_token(v_t1);
  @root
  @chk 'a token cannot be finished twice' | r->>'code' = 'invalid_transition'

  -- Clinical records
  @as v_doc
  r := public.get_patient_history(v_clinic, v_pat);
  v_visit := (r->'visits'->0->>'id')::uuid;
  r2 := public.save_visit(v_clinic, v_pat, v_visit, 'Sore throat', 'Mild redness SMOKE-NOTE', 'Warm fluids', null, null, 'Pharyngitis');
  r3 := public.save_prescription(v_clinic, v_visit, '[{"name":"Paracetamol","dose":"500 mg"}]'::jsonb, 'Rest');
  r4 := public.get_patient_history(v_clinic, v_pat);
  select count(*) into n from public.visits;
  @root
  @chk 'a doctor opens history, writes a note and a prescription' | (r->>'ok')::boolean and (r2->>'ok')::boolean and (r3->>'ok')::boolean and r4::text like '%SMOKE-NOTE%' and r4::text like '%Paracetamol%'
  @chk 'a doctor can read the clinic visit rows' | n >= 3
  @as v_recep
  r := public.get_patient_visit_list(v_clinic, v_pat);
  select count(*) into n from public.visits;
  select count(*) into n2 from public.prescriptions;
  select count(*) into n3 from public.patient_reports;
  @root
  @chk 'reception sees visit dates and titles only' | (r->>'ok')::boolean and r::text like '%Sore throat%' and r::text not like '%SMOKE-NOTE%' and r::text not like '%Pharyngitis%'
  @chk 'reception reads no visit, prescription or report rows' | n = 0 and n2 = 0 and n3 = 0
  @as v_owner
  select count(*) into n from public.visits;
  select count(*) into n2 from public.prescriptions;
  r := public.get_patient_history(v_clinic, v_pat);
  @root
  @chk 'the owner reads no clinical records' | n = 0 and n2 = 0 and r->>'code' = 'forbidden'

  -- Report files
  v_path := v_clinic::text || '/' || v_pat::text || '/' || gen_random_uuid()::text || '-scan.pdf';
  @as v_doc
  @try format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'patient-reports', v_path)
  @root
  @chk 'a doctor uploads a report file into the private bucket' | code = 'ok'
  @as v_recep
  @try format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'patient-reports', v_clinic::text || '/' || v_pat::text || '/' || gen_random_uuid()::text || '-r.pdf')
  @root
  @chk 'reception cannot upload report files' | code <> 'ok'
  @as v_owner2
  @try format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'patient-reports', v_clinic::text || '/' || v_pat::text || '/' || gen_random_uuid()::text || '-x.pdf')
  @root
  @chk 'another clinic cannot upload into this clinic folder' | code <> 'ok'
  @as v_doc
  r := public.register_report(v_clinic, v_pat, v_visit, 'Blood test', v_path, 'application/pdf', 12345);
  v_rep := (r->'report'->>'id')::uuid;
  r2 := public.authorize_report_download(v_rep);
  r3 := public.register_report(v_clinic, v_pat, v_visit, 'Ghost', v_clinic::text || '/' || v_pat::text || '/nothing-here.pdf', 'application/pdf', 10);
  r4 := public.register_report(v_clinic, v_pat, v_visit, 'Odd', v_clinic::text || '/' || v_pat::text || '/../x.pdf', 'application/pdf', 10);
  b2 := public.get_patient_history(v_clinic, v_pat);
  @root
  @chk 'the doctor records the uploaded report and can open it' | (r->>'ok')::boolean and (r2->>'ok')::boolean and r2->>'path' = v_path
  @chk 'a report that is not really in storage, or has a tricky path, is refused' | r3->>'code' = 'not_found' and r4->>'code' = 'invalid_input'
  @as v_owner2
  r := public.authorize_report_download(v_rep);
  @root
  @chk 'another clinic cannot open the report' | r->>'code' = 'not_found'
  @as v_recep
  r := public.register_report(v_clinic, v_pat, v_visit, 'x', v_path, 'application/pdf', 10);
  @root
  @chk 'reception cannot record reports' | r->>'code' = 'forbidden'
  @chk 'the history lists the report by name and never shows the storage path' | b2::text like '%Blood test%' and b2::text not like '%' || v_path || '%'

  -- Another clinic and strangers
  @as v_owner2
  r := public.get_staff_snapshot(v_clinic);
  r2 := public.search_patients(v_clinic, 'Asha');
  r3 := public.complete_token(v_t1);
  select count(*) into n from public.patients;
  select count(*) into n2 from public.queue_tokens;
  select count(*) into n3 from public.clinics;
  @root
  @chk 'another clinic is refused by every function' | r->>'code' = 'forbidden' and r2->>'code' = 'forbidden' and r3->>'code' = 'not_found'
  @chk 'another clinic reads no patients or tokens, and sees only its own clinic' | n = 0 and n2 = 0 and n3 = 1
  @chk 'nobody can edit the clinic table directly' | not has_table_privilege('authenticated', 'public.clinics', 'update') and not has_table_privilege('anon', 'public.clinics', 'update')
  @as v_out
  r := public.my_clinics();
  select count(*) into n from public.clinics;
  select count(*) into n2 from public.audit_log;
  @root
  @chk 'a signed in stranger works in no clinic and sees nothing' | jsonb_array_length(r->'clinics') = 0 and n = 0 and n2 = 0

  -- Direct writes are closed (checked from the privilege catalog, so nothing is written to try it)
  @chk 'signed in users have read only access to the clinic tables' | not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and grantee = 'authenticated' and privilege_type <> 'SELECT')
  @chk 'the public has no right on any clinic table' | not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon')
  @chk 'a person may change their own name but not their email on the profile row' | has_column_privilege('authenticated', 'public.profiles', 'full_name', 'update') and not has_column_privilege('authenticated', 'public.profiles', 'email', 'update') and not has_column_privilege('authenticated', 'public.profiles', 'id', 'update')

  -- Settings, limits and reports
  @as v_owner
  r := public.update_clinic_settings(v_clinic, 'Smoke Clinic', true, 3, 10, 4);
  @root
  @anon
  r2 := public.book_token(v_slug, 'Dev Rao', '9876543299', v_dr, v_today);
  @root
  @chk 'the daily token limit closes online booking' | (r->>'ok')::boolean and r2->>'code' = 'full'
  @as v_owner
  r := public.update_clinic_settings(v_clinic, 'Smoke Clinic', false, 100, 10, 4);
  @root
  @anon
  r2 := public.book_token(v_slug, 'Dev Rao', '9876543299', v_dr, v_today);
  @root
  @chk 'switching online booking off refuses patients' | r2->>'code' = 'online_disabled'
  @as v_owner
  r := public.update_clinic_settings(v_clinic, 'Smoke Clinic', true, 100, 10, 1);
  @root
  @anon
  r2 := public.book_token(v_slug, 'Eka Pal', '9876543210', v_dr, v_today);
  r3 := public.book_token(v_slug, 'Eka Pal', '9876543277', v_dr, v_today);
  @root
  @chk 'one mobile number is held to its daily limit, others are not' | r2->>'code' = 'rate_limited' and (r3->>'ok')::boolean
  @as v_owner
  r := public.get_report_series(v_clinic);
  @root
  @chk 'the owner sees the day counted from the token records' | (r->>'ok')::boolean and jsonb_array_length(r->'days') = 7 and (r->'days'->6->>'completed')::int = 3
  @as v_recep
  r := public.get_report_series(v_clinic);
  @root
  @chk 'reception cannot open the reports' | r->>'code' = 'forbidden'

  -- Audit log and live updates
  @as v_owner
  select count(*) into n from public.audit_log;
  @root
  @as v_recep
  select count(*) into n2 from public.audit_log;
  @root
  @chk 'the owner can read the audit log and reception cannot' | n >= 8 and n2 = 0
  @chk 'the audit log holds no clinical text' | not exists (select 1 from public.audit_log where details::text like '%SMOKE-NOTE%' or details::text like '%Pharyngitis%')
  @chk 'history reads and report opens are audited' | exists (select 1 from public.audit_log where clinic_id = v_clinic and action = 'patient.history_read' and actor_id = v_doc) and exists (select 1 from public.audit_log where clinic_id = v_clinic and action = 'report.open')
  if to_regclass('realtime.messages') is not null then
    execute format('select count(*) from realtime.messages where topic = %L', 'queue:' || v_clinic) into n;
  else
    execute format('select count(*) from realtime.sent where topic = %L', 'queue:' || v_clinic) into n;
  end if;
  @chk 'every queue change sent a live update signal on the clinic channel' | n >= 8

  raise exception 'SMOKE_RESULT total=% failed=% %', jsonb_array_length(res),
    (select count(*) from jsonb_array_elements(res) e where not (e->>'ok')::boolean),
    (select coalesce(jsonb_agg(e->>'t'), '[]'::jsonb) from jsonb_array_elements(res) e where not (e->>'ok')::boolean);
end
$smoke$;
