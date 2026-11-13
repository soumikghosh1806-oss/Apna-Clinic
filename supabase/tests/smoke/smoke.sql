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
  res := res || jsonb_build_array(jsonb_build_object('t', 'every new sign in gets a profile', 'ok', coalesce(((select count(*) from public.profiles where id in (v_owner, v_recep, v_doc, v_out, v_owner2)) = 5), false)));

  -- Registration and staff
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_owner::text, true); set local role authenticated;
  r := public.register_clinic('Smoke Clinic', v_slug, 'Smoke Owner');
  reset role;
  v_clinic := (r->'clinic'->>'id')::uuid;
  res := res || jsonb_build_array(jsonb_build_object('t', 'owner registers a clinic and becomes its owner', 'ok', coalesce(((r->>'ok')::boolean and exists (select 1 from public.clinic_memberships where clinic_id = v_clinic and user_id = v_owner and role = 'owner')), false)));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner2, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_owner2::text, true); set local role authenticated;
  r := public.register_clinic('Other Clinic', v_slug || '-b', 'Other Owner');
  reset role;
  v_clinic2 := (r->'clinic'->>'id')::uuid;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true); perform set_config('request.jwt.claim.sub', '', true); set local role anon;
  begin execute format('select public.register_clinic(%L, %L, %L)', 'X Clinic', 'x-clinic-zz', 'X Owner'); code := 'ok'; exception when others then code := sqlstate; end;
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'the public cannot register a clinic', 'ok', coalesce((code = '42501'), false)));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_owner::text, true); set local role authenticated;
  r := public.add_doctor(v_clinic, 'Dr Smoke', 'General OPD', '[{"start":"00:00","end":"23:59"}]'::jsonb);
  reset role;
  v_dr := (r->'doctor'->>'id')::uuid;
  res := res || jsonb_build_array(jsonb_build_object('t', 'owner adds a doctor with OPD timings', 'ok', coalesce(((r->>'ok')::boolean and v_dr is not null), false)));
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true); perform set_config('request.jwt.claim.sub', '', true); set local role service_role;
  r := public.attach_staff(v_clinic, v_recep, 'receptionist', null, v_owner, 'Smoke Reception');
  r2 := public.attach_staff(v_clinic, v_doc, 'doctor', v_dr, v_owner, 'Dr Smoke');
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'the server side invite function attaches a receptionist and a doctor', 'ok', coalesce(((r->>'ok')::boolean and (r2->>'ok')::boolean), false)));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_owner::text, true); set local role authenticated;
  begin execute format('select public.attach_staff(%L, %L, %L, %L, %L)', v_clinic, v_out, 'doctor', v_dr, v_owner); code := 'ok'; exception when others then code := sqlstate; end;
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'a signed in browser cannot call the invite function', 'ok', coalesce((code = '42501'), false)));

  -- Public booking
  perform set_config('request.jwt.claims', '{"role":"anon"}', true); perform set_config('request.jwt.claim.sub', '', true); set local role anon;
  r := public.get_public_clinic(v_slug);
  reset role;
  v_today := (r->>'today')::date;
  res := res || jsonb_build_array(jsonb_build_object('t', 'the booking page lists the doctor and no staff details', 'ok', coalesce(((r->>'ok')::boolean and jsonb_array_length(r->'doctors') = 1 and r::text not like '%@smoke.test%' and r::text not like '%' || v_owner::text || '%'), false)));
  perform set_config('request.jwt.claims', '{"role":"anon"}', true); perform set_config('request.jwt.claim.sub', '', true); set local role anon;
  b1 := public.book_token(v_slug, 'Asha Verma', '9876543210', v_dr, v_today);
  b2 := public.book_token(v_slug, 'Bala Kumar', '+91 98765 43211', v_dr, v_today);
  r := public.book_token(v_slug, 'Asha  Verma', '09876543210', v_dr, v_today);
  r2 := public.book_token(v_slug, 'Bad Phone', '12345', v_dr, v_today);
  r3 := public.book_token(v_slug, 'Far Date', '9876543288', v_dr, v_today + 5);
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'online booking gives numbers 1 and 2', 'ok', coalesce(((b1->'token'->>'number')::int = 1 and (b2->'token'->>'number')::int = 2), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'the public never gets internal ids back', 'ok', coalesce((b1->'token'->>'id' is null and b1->'token'->>'patient_id' is null and b1->>'access_key' is not null), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'the same person cannot hold two live tokens', 'ok', coalesce((r->>'code' = 'duplicate' and r->>'existing_token_id' is null), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'a bad phone number is refused with a field error', 'ok', coalesce((r2->>'code' = 'invalid_input' and jsonb_exists(r2->'field_errors', 'phone')), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'booking more than tomorrow is refused', 'ok', coalesce((r3->>'code' = 'invalid_date'), false)));
  v_k1 := (b1->>'access_key')::uuid;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true); perform set_config('request.jwt.claim.sub', '', true); set local role anon;
  r := public.get_my_token(v_k1);
  r2 := public.get_public_queue(v_slug, v_dr, null);
  r3 := public.get_my_token(gen_random_uuid());
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'a patient sees their number and first name only', 'ok', coalesce((r->>'first_name' = 'Asha' and r::text not like '%Verma%' and r::text not like '%9876543210%'), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'the waiting room shows numbers and no names or phones', 'ok', coalesce(((r2->>'ok')::boolean and r2::text not like '%Asha%' and r2::text not like '%Bala%' and r2::text not like '%98765%'), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'a guessed link finds nothing', 'ok', coalesce((r3->>'code' = 'not_found'), false)));
  perform set_config('request.jwt.claims', '{"role":"anon"}', true); perform set_config('request.jwt.claim.sub', '', true); set local role anon;
  begin execute 'select count(*) from public.patients'; code := 'ok'; exception when others then code := sqlstate; end;
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'the public cannot read any table directly', 'ok', coalesce((code = '42501'), false)));
  perform set_config('request.jwt.claims', '{"role":"anon"}', true); perform set_config('request.jwt.claim.sub', '', true); set local role anon;
  begin execute format('select public.get_staff_snapshot(%L)', v_clinic); code := 'ok'; exception when others then code := sqlstate; end;
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'the public cannot call staff functions', 'ok', coalesce((code = '42501'), false)));

  -- Reception and the queue
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_recep, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_recep::text, true); set local role authenticated;
  r := public.add_walk_in(v_clinic, 'Chitra Das', '9876543212', v_dr, false);
  r2 := public.get_staff_snapshot(v_clinic);
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'reception adds a walk in as number 3, already arrived', 'ok', coalesce(((r->>'ok')::boolean and (r->'token'->>'number')::int = 3 and r->'token'->>'source' = 'walk_in' and r->'token'->>'arrived_at' is not null), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'the staff snapshot shows the three tokens, with no clinical data', 'ok', coalesce((jsonb_array_length(r2->'tokens') = 3 and r2::text not like '%diagnosis%' and r2::text not like '%medicines%'), false)));
  v_t1 := (select (t->>'id')::uuid from jsonb_array_elements(r2->'tokens') t where (t->>'number')::int = 1);
  v_t2 := (select (t->>'id')::uuid from jsonb_array_elements(r2->'tokens') t where (t->>'number')::int = 2);
  v_t3 := (select (t->>'id')::uuid from jsonb_array_elements(r2->'tokens') t where (t->>'number')::int = 3);
  v_pat := (select patient_id from public.queue_tokens where id = v_t1);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_recep, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_recep::text, true); set local role authenticated;
  r := public.mark_arrived(v_t1);
  r2 := public.call_next(v_dr, null);
  r3 := public.get_patient_history(v_clinic, v_pat);
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'reception marks arrival', 'ok', coalesce(((r->>'ok')::boolean and r->'token'->>'arrival_source' = 'reception'), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'reception cannot press NEXT', 'ok', coalesce((r2->>'code' = 'forbidden'), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'reception cannot read clinical history', 'ok', coalesce((r3->>'code' = 'forbidden'), false)));

  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_doc, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_doc::text, true); set local role authenticated;
  r := public.call_next(v_dr, null);
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'NEXT calls token 1 first', 'ok', coalesce(((r->>'ok')::boolean and (r->'called'->>'number')::int = 1), false)));
  perform set_config('app.fake_now', (v_base + interval '10 seconds')::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_doc, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_doc::text, true); set local role authenticated;
  r := public.call_next(v_dr, v_t1);
  r2 := public.call_next(v_dr, null);
  r3 := public.call_next(v_dr, v_t2);
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'NEXT finishes token 1 and calls token 2', 'ok', coalesce(((r->>'ok')::boolean and (r->'completed'->>'number')::int = 1 and (r->'called'->>'number')::int = 2), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'a press from an out of date screen changes nothing', 'ok', coalesce((r2->>'code' = 'stale'), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'a quick second press does not skip the patient just called', 'ok', coalesce((r3->>'code' = 'too_soon'), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'finishing a consultation made exactly one visit', 'ok', coalesce(((select count(*) from public.visits where queue_token_id = v_t1) = 1), false)));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_doc, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_doc::text, true); set local role authenticated;
  r := public.hold_token(v_t2);
  r2 := public.resume_token(v_t2);
  r3 := public.call_next(v_dr, null);
  r4 := public.skip_token(v_t2);
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'hold, resume, call and skip work for the doctor', 'ok', coalesce(((r->>'ok')::boolean and (r2->>'ok')::boolean and (r3->'called'->>'number')::int = 2 and r4->'token'->>'status' = 'skipped'), false)));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_recep, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_recep::text, true); set local role authenticated;
  r := public.requeue_token(v_t2);
  reset role;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_doc, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_doc::text, true); set local role authenticated;
  r2 := public.call_next(v_dr, null);
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'a skipped patient returned by reception goes to the end of the line', 'ok', coalesce(((r->>'ok')::boolean and (r2->'called'->>'number')::int = 3), false)));
  perform set_config('app.fake_now', (v_base + interval '30 seconds')::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_doc, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_doc::text, true); set local role authenticated;
  r := public.call_next(v_dr, v_t3);
  r2 := public.complete_token(v_t2);
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'the queue ends in order 3 then 2, both completed', 'ok', coalesce(((r->'called'->>'number')::int = 2 and (r2->>'ok')::boolean and (select count(*) from public.queue_tokens where doctor_id = v_dr and status = 'completed') = 3), false)));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_doc, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_doc::text, true); set local role authenticated;
  r := public.complete_token(v_t1);
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'a token cannot be finished twice', 'ok', coalesce((r->>'code' = 'invalid_transition'), false)));

  -- Clinical records
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_doc, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_doc::text, true); set local role authenticated;
  r := public.get_patient_history(v_clinic, v_pat);
  v_visit := (r->'visits'->0->>'id')::uuid;
  r2 := public.save_visit(v_clinic, v_pat, v_visit, 'Sore throat', 'Mild redness SMOKE-NOTE', 'Warm fluids', null, null, 'Pharyngitis');
  r3 := public.save_prescription(v_clinic, v_visit, '[{"name":"Paracetamol","dose":"500 mg"}]'::jsonb, 'Rest');
  r4 := public.get_patient_history(v_clinic, v_pat);
  select count(*) into n from public.visits;
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'a doctor opens history, writes a note and a prescription', 'ok', coalesce(((r->>'ok')::boolean and (r2->>'ok')::boolean and (r3->>'ok')::boolean and r4::text like '%SMOKE-NOTE%' and r4::text like '%Paracetamol%'), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'a doctor can read the clinic visit rows', 'ok', coalesce((n >= 3), false)));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_recep, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_recep::text, true); set local role authenticated;
  r := public.get_patient_visit_list(v_clinic, v_pat);
  select count(*) into n from public.visits;
  select count(*) into n2 from public.prescriptions;
  select count(*) into n3 from public.patient_reports;
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'reception sees visit dates and titles only', 'ok', coalesce(((r->>'ok')::boolean and r::text like '%Sore throat%' and r::text not like '%SMOKE-NOTE%' and r::text not like '%Pharyngitis%'), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'reception reads no visit, prescription or report rows', 'ok', coalesce((n = 0 and n2 = 0 and n3 = 0), false)));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_owner::text, true); set local role authenticated;
  select count(*) into n from public.visits;
  select count(*) into n2 from public.prescriptions;
  r := public.get_patient_history(v_clinic, v_pat);
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'the owner reads no clinical records', 'ok', coalesce((n = 0 and n2 = 0 and r->>'code' = 'forbidden'), false)));

  -- Report files
  v_path := v_clinic::text || '/' || v_pat::text || '/' || gen_random_uuid()::text || '-scan.pdf';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_doc, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_doc::text, true); set local role authenticated;
  begin execute format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'patient-reports', v_path); code := 'ok'; exception when others then code := sqlstate; end;
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'a doctor uploads a report file into the private bucket', 'ok', coalesce((code = 'ok'), false)));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_recep, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_recep::text, true); set local role authenticated;
  begin execute format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'patient-reports', v_clinic::text || '/' || v_pat::text || '/' || gen_random_uuid()::text || '-r.pdf'); code := 'ok'; exception when others then code := sqlstate; end;
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'reception cannot upload report files', 'ok', coalesce((code <> 'ok'), false)));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner2, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_owner2::text, true); set local role authenticated;
  begin execute format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'patient-reports', v_clinic::text || '/' || v_pat::text || '/' || gen_random_uuid()::text || '-x.pdf'); code := 'ok'; exception when others then code := sqlstate; end;
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'another clinic cannot upload into this clinic folder', 'ok', coalesce((code <> 'ok'), false)));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_doc, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_doc::text, true); set local role authenticated;
  r := public.register_report(v_clinic, v_pat, v_visit, 'Blood test', v_path, 'application/pdf', 12345);
  v_rep := (r->'report'->>'id')::uuid;
  r2 := public.authorize_report_download(v_rep);
  r3 := public.register_report(v_clinic, v_pat, v_visit, 'Ghost', v_clinic::text || '/' || v_pat::text || '/nothing-here.pdf', 'application/pdf', 10);
  r4 := public.register_report(v_clinic, v_pat, v_visit, 'Odd', v_clinic::text || '/' || v_pat::text || '/../x.pdf', 'application/pdf', 10);
  b2 := public.get_patient_history(v_clinic, v_pat);
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'the doctor records the uploaded report and can open it', 'ok', coalesce(((r->>'ok')::boolean and (r2->>'ok')::boolean and r2->>'path' = v_path), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'a report that is not really in storage, or has a tricky path, is refused', 'ok', coalesce((r3->>'code' = 'not_found' and r4->>'code' = 'invalid_input'), false)));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner2, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_owner2::text, true); set local role authenticated;
  r := public.authorize_report_download(v_rep);
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'another clinic cannot open the report', 'ok', coalesce((r->>'code' = 'not_found'), false)));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_recep, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_recep::text, true); set local role authenticated;
  r := public.register_report(v_clinic, v_pat, v_visit, 'x', v_path, 'application/pdf', 10);
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'reception cannot record reports', 'ok', coalesce((r->>'code' = 'forbidden'), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'the history lists the report by name and never shows the storage path', 'ok', coalesce((b2::text like '%Blood test%' and b2::text not like '%' || v_path || '%'), false)));

  -- Another clinic and strangers
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner2, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_owner2::text, true); set local role authenticated;
  r := public.get_staff_snapshot(v_clinic);
  r2 := public.search_patients(v_clinic, 'Asha');
  r3 := public.complete_token(v_t1);
  select count(*) into n from public.patients;
  select count(*) into n2 from public.queue_tokens;
  select count(*) into n3 from public.clinics;
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'another clinic is refused by every function', 'ok', coalesce((r->>'code' = 'forbidden' and r2->>'code' = 'forbidden' and r3->>'code' = 'not_found'), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'another clinic reads no patients or tokens, and sees only its own clinic', 'ok', coalesce((n = 0 and n2 = 0 and n3 = 1), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'nobody can edit the clinic table directly', 'ok', coalesce((not has_table_privilege('authenticated', 'public.clinics', 'update') and not has_table_privilege('anon', 'public.clinics', 'update')), false)));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_out, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_out::text, true); set local role authenticated;
  r := public.my_clinics();
  select count(*) into n from public.clinics;
  select count(*) into n2 from public.audit_log;
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'a signed in stranger works in no clinic and sees nothing', 'ok', coalesce((jsonb_array_length(r->'clinics') = 0 and n = 0 and n2 = 0), false)));

  -- Direct writes are closed (checked from the privilege catalog, so nothing is written to try it)
  res := res || jsonb_build_array(jsonb_build_object('t', 'signed in users have read only access to the clinic tables', 'ok', coalesce((not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and grantee = 'authenticated' and privilege_type <> 'SELECT')), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'the public has no right on any clinic table', 'ok', coalesce((not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon')), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'a person may change their own name but not their email on the profile row', 'ok', coalesce((has_column_privilege('authenticated', 'public.profiles', 'full_name', 'update') and not has_column_privilege('authenticated', 'public.profiles', 'email', 'update') and not has_column_privilege('authenticated', 'public.profiles', 'id', 'update')), false)));

  -- Settings, limits and reports
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_owner::text, true); set local role authenticated;
  r := public.update_clinic_settings(v_clinic, 'Smoke Clinic', true, 3, 10, 4);
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true); perform set_config('request.jwt.claim.sub', '', true); set local role anon;
  r2 := public.book_token(v_slug, 'Dev Rao', '9876543299', v_dr, v_today);
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'the daily token limit closes online booking', 'ok', coalesce(((r->>'ok')::boolean and r2->>'code' = 'full'), false)));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_owner::text, true); set local role authenticated;
  r := public.update_clinic_settings(v_clinic, 'Smoke Clinic', false, 100, 10, 4);
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true); perform set_config('request.jwt.claim.sub', '', true); set local role anon;
  r2 := public.book_token(v_slug, 'Dev Rao', '9876543299', v_dr, v_today);
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'switching online booking off refuses patients', 'ok', coalesce((r2->>'code' = 'online_disabled'), false)));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_owner::text, true); set local role authenticated;
  r := public.update_clinic_settings(v_clinic, 'Smoke Clinic', true, 100, 10, 1);
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true); perform set_config('request.jwt.claim.sub', '', true); set local role anon;
  r2 := public.book_token(v_slug, 'Eka Pal', '9876543210', v_dr, v_today);
  r3 := public.book_token(v_slug, 'Eka Pal', '9876543277', v_dr, v_today);
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'one mobile number is held to its daily limit, others are not', 'ok', coalesce((r2->>'code' = 'rate_limited' and (r3->>'ok')::boolean), false)));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_owner::text, true); set local role authenticated;
  r := public.get_report_series(v_clinic);
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'the owner sees the day counted from the token records', 'ok', coalesce(((r->>'ok')::boolean and jsonb_array_length(r->'days') = 7 and (r->'days'->6->>'completed')::int = 3), false)));
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_recep, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_recep::text, true); set local role authenticated;
  r := public.get_report_series(v_clinic);
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'reception cannot open the reports', 'ok', coalesce((r->>'code' = 'forbidden'), false)));

  -- Audit log and live updates
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_owner::text, true); set local role authenticated;
  select count(*) into n from public.audit_log;
  reset role;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_recep, 'role', 'authenticated')::text, true); perform set_config('request.jwt.claim.sub', v_recep::text, true); set local role authenticated;
  select count(*) into n2 from public.audit_log;
  reset role;
  res := res || jsonb_build_array(jsonb_build_object('t', 'the owner can read the audit log and reception cannot', 'ok', coalesce((n >= 8 and n2 = 0), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'the audit log holds no clinical text', 'ok', coalesce((not exists (select 1 from public.audit_log where details::text like '%SMOKE-NOTE%' or details::text like '%Pharyngitis%')), false)));
  res := res || jsonb_build_array(jsonb_build_object('t', 'history reads and report opens are audited', 'ok', coalesce((exists (select 1 from public.audit_log where clinic_id = v_clinic and action = 'patient.history_read' and actor_id = v_doc) and exists (select 1 from public.audit_log where clinic_id = v_clinic and action = 'report.open')), false)));
  if to_regclass('realtime.messages') is not null then
    execute format('select count(*) from realtime.messages where topic = %L', 'queue:' || v_clinic) into n;
  else
    execute format('select count(*) from realtime.sent where topic = %L', 'queue:' || v_clinic) into n;
  end if;
  res := res || jsonb_build_array(jsonb_build_object('t', 'every queue change sent a live update signal on the clinic channel', 'ok', coalesce((n >= 8), false)));

  raise exception 'SMOKE_RESULT total=% failed=% %', jsonb_array_length(res),
    (select count(*) from jsonb_array_elements(res) e where not (e->>'ok')::boolean),
    (select coalesce(jsonb_agg(e->>'t'), '[]'::jsonb) from jsonb_array_elements(res) e where not (e->>'ok')::boolean);
end
$smoke$;
