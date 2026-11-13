-- Cliniq migration 4 of 5: functions for signed in staff (owner, receptionist, doctor).
--
-- Each function checks the caller's role in the clinic itself, and returns { ok: false, code: 'forbidden' } if the
-- role is not allowed. Screens hiding a button is only a convenience; this is the lock.

create function private.my_doctor_id(p_clinic uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select d.id from public.doctors d
  where d.clinic_id = p_clinic and d.profile_id = (select auth.uid()) and d.is_active
  limit 1
$$;

create function private.forbidden(p_message text default 'Your role is not allowed to do this.') returns jsonb
language sql immutable set search_path = '' as $$ select private.fail('forbidden', p_message) $$;

-- Marks the consultation as done and makes sure a visit record exists for it.
create function private.finish_token(t public.queue_tokens, p_now timestamptz) returns public.queue_tokens
language plpgsql security definer set search_path = '' as $$
declare r public.queue_tokens;
begin
  update public.queue_tokens set status = 'completed', completed_at = p_now where id = t.id returning * into r;
  insert into public.visits (clinic_id, patient_id, doctor_id, queue_token_id, visit_date, title, created_at)
  values (r.clinic_id, r.patient_id, r.doctor_id, r.id, p_now, 'Consultation', p_now)
  on conflict (queue_token_id) where queue_token_id is not null do nothing;
  perform private.sync_appointment(r);
  return r;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Clinic registration and "who am I"
-- ---------------------------------------------------------------------------------------------------------------

-- A signed in user creates a clinic and becomes its owner. The clinic starts with its settings and no doctors.
create function public.register_clinic(p_clinic_name text, p_slug text, p_owner_name text, p_phone text default null,
                                       p_city text default null, p_state text default null,
                                       p_timezone text default 'Asia/Kolkata') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_name text := private.clean_name(p_clinic_name);
  v_owner text := private.clean_name(p_owner_name);
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_phone text := null;
  v_errors jsonb := '{}'::jsonb;
  v_clinic uuid;
begin
  if v_uid is null then return private.fail('forbidden', 'Sign in first.'); end if;

  if char_length(v_name) < 2 or char_length(v_name) > 60 then
    v_errors := v_errors || jsonb_build_object('clinicName', 'The clinic name needs 2 to 60 characters.');
  end if;
  if char_length(v_owner) < 2 or char_length(v_owner) > 60 then
    v_errors := v_errors || jsonb_build_object('ownerName', 'Your name needs 2 to 60 characters.');
  end if;
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_slug) not between 3 and 40 then
    v_errors := v_errors || jsonb_build_object('slug', 'Use 3 to 40 lowercase letters, numbers and single hyphens.');
  elsif v_slug in ('admin', 'api', 'app', 'auth', 'book', 'clinic', 'clinics', 'cliniq', 'doctor', 'login', 'privacy',
                   'queue', 'reception', 'register', 'report', 'settings', 'staff', 'supabase', 'terms', 'token', 'tv', 'www') then
    v_errors := v_errors || jsonb_build_object('slug', 'This address is reserved. Try another.');
  end if;
  if btrim(coalesce(p_phone, '')) <> '' then
    v_phone := private.normalize_phone(p_phone);
    if v_phone is null then
      v_errors := v_errors || jsonb_build_object('phone', 'Enter a valid 10 digit mobile number that starts with 6, 7, 8 or 9.');
    end if;
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = coalesce(p_timezone, '')) then
    v_errors := v_errors || jsonb_build_object('timezone', 'Choose a valid time zone.');
  end if;
  if v_errors <> '{}'::jsonb then
    return private.fail('invalid_input', 'Please fix the highlighted fields.', jsonb_build_object('field_errors', v_errors));
  end if;

  if (select count(*) from public.clinics c where c.created_by = v_uid) >= 5 then
    return private.fail('invalid_input', 'One account can create up to 5 clinics.');
  end if;

  begin
    insert into public.clinics (name, slug, phone, city, state, timezone, created_by)
    values (v_name, v_slug, v_phone, nullif(btrim(coalesce(p_city, '')), ''), nullif(btrim(coalesce(p_state, '')), ''),
            p_timezone, v_uid)
    returning id into v_clinic;
  exception when unique_violation then
    return private.fail('slug_taken', 'This clinic address is already taken. Try another.',
      jsonb_build_object('field_errors', jsonb_build_object('slug', 'This clinic address is already taken. Try another.')));
  end;

  insert into public.clinic_settings (clinic_id) values (v_clinic);
  insert into public.profiles (id, full_name) values (v_uid, v_owner)
    on conflict (id) do update set full_name = excluded.full_name;
  insert into public.clinic_memberships (clinic_id, user_id, role) values (v_clinic, v_uid, 'owner');

  perform private.audit(v_clinic, 'clinic.register', 'clinic', v_clinic, jsonb_build_object('slug', v_slug));
  return jsonb_build_object('ok', true, 'clinic', jsonb_build_object('id', v_clinic, 'name', v_name, 'slug', v_slug));
end $$;

-- The signed in user's profile and the clinics they work in.
create function public.my_clinics() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_profile jsonb; v_clinics jsonb;
begin
  if v_uid is null then return private.fail('forbidden', 'Sign in first.'); end if;
  select jsonb_build_object('id', p.id, 'full_name', p.full_name, 'email', p.email) into v_profile
    from public.profiles p where p.id = v_uid;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'slug', c.slug, 'timezone', c.timezone, 'role', m.role,
      'doctor_id', (select d.id from public.doctors d where d.clinic_id = c.id and d.profile_id = v_uid and d.is_active limit 1))
    order by c.name), '[]'::jsonb) into v_clinics
  from public.clinic_memberships m join public.clinics c on c.id = m.clinic_id
  where m.user_id = v_uid and m.is_active;
  return jsonb_build_object('ok', true, 'profile', v_profile, 'clinics', v_clinics);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- The staff screens' data: one call, scoped to the caller's clinic and role
-- ---------------------------------------------------------------------------------------------------------------
create function public.get_staff_snapshot(p_clinic uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := private.member_role(p_clinic);
  c public.clinics; s public.clinic_settings; v_today date; v_doctors jsonb; v_tokens jsonb;
begin
  if v_role is null then return private.forbidden('You do not have access to this clinic.'); end if;
  select * into c from public.clinics where id = p_clinic;
  select * into s from public.clinic_settings where clinic_id = p_clinic;
  v_today := private.today(p_clinic);

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id, 'name', d.name, 'opd', d.opd_name, 'sessions', private.sessions_json(d.id, v_today),
      'daily_limit', d.daily_token_limit, 'minutes_per_patient', d.minutes_per_patient, 'active', d.is_active,
      'has_login', d.profile_id is not null) order by d.created_at, d.id), '[]'::jsonb) into v_doctors
  from public.doctors d where d.clinic_id = p_clinic;

  select coalesce(jsonb_agg(private.token_json(q) || jsonb_build_object(
      'patient_name', p.name, 'patient_phone', p.phone,
      'visit_number', 1 + (select count(*) from public.visits v where v.patient_id = q.patient_id and v.queue_token_id is distinct from q.id))
    order by q.doctor_id, q.token_number), '[]'::jsonb) into v_tokens
  from public.queue_tokens q join public.patients p on p.id = q.patient_id
  where q.clinic_id = p_clinic and q.queue_date between v_today and v_today + 1;

  return jsonb_build_object('ok', true, 'now', private.clock(), 'today', v_today,
    'clinic', jsonb_build_object('id', c.id, 'name', c.name, 'slug', c.slug, 'timezone', c.timezone),
    'role', v_role, 'my_doctor_id', private.my_doctor_id(p_clinic),
    'settings', jsonb_build_object('online_booking_enabled', s.online_booking_enabled,
      'default_daily_limit', s.daily_token_limit, 'default_minutes_per_patient', s.average_consultation_minutes,
      'max_online_bookings_per_phone_per_day', s.max_online_bookings_per_phone_per_day),
    'doctors', v_doctors, 'tokens', v_tokens);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Queue actions
-- ---------------------------------------------------------------------------------------------------------------

-- Reception issues a walk-in token. Going over the daily limit needs allow_over_limit.
create function public.add_walk_in(p_clinic uuid, p_name text, p_phone text, p_doctor_id uuid,
                                   p_allow_over_limit boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.member_role(p_clinic), '') not in ('owner', 'receptionist') then return private.forbidden(); end if;
  perform private.lock_doctor(p_doctor_id);
  return private.create_token(p_clinic, p_doctor_id, p_name, p_phone, private.today(p_clinic), 'walk_in', p_allow_over_limit);
end $$;

-- mark_arrived, mark_no_show, requeue, complete, skip, hold and resume share one body so the rules sit in one place.
create function private.act_on_token(p_token uuid, p_action text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.queue_tokens; v_role text; v_allowed boolean; v_now timestamptz := private.clock();
  v_key int; v_dup public.queue_tokens;
begin
  select * into t from public.queue_tokens where id = p_token;
  v_role := case when t.id is null then null else private.member_role(t.clinic_id) end;
  -- Someone outside the clinic learns nothing, not even that the token exists.
  if v_role is null then return private.fail('not_found', 'This token could not be found.'); end if;

  v_allowed := case p_action
    when 'arrived' then v_role in ('owner', 'receptionist')
    when 'no_show' then v_role in ('owner', 'receptionist')
    when 'requeue' then v_role in ('owner', 'receptionist', 'doctor')
    else v_role = 'doctor' end;
  if not v_allowed then return private.forbidden(); end if;
  if v_role = 'doctor' and private.my_doctor_id(t.clinic_id) is distinct from t.doctor_id then
    return private.forbidden('This token belongs to another doctor.');
  end if;

  perform private.lock_doctor(t.doctor_id);
  select * into t from public.queue_tokens where id = p_token for update;

  if p_action = 'arrived' then
    if t.arrived_at is not null then
      return private.fail('invalid_transition', format('Token #%s is already marked as arrived.', t.token_number));
    end if;
    if t.status not in ('waiting', 'skipped', 'on_hold') then return private.bad_transition(t, 'marked as arrived'); end if;
    update public.queue_tokens set arrived_at = v_now, arrival_source = 'reception' where id = t.id returning * into t;

  elsif p_action = 'no_show' then
    if t.status not in ('waiting', 'skipped', 'on_hold') then return private.bad_transition(t, 'marked as no-show'); end if;
    update public.queue_tokens set status = 'no_show' where id = t.id returning * into t;

  elsif p_action = 'requeue' then
    if t.status not in ('skipped', 'no_show') then return private.bad_transition(t, 'returned to the queue'); end if;
    select * into v_dup from public.queue_tokens q
      where q.patient_id = t.patient_id and q.doctor_id = t.doctor_id and q.queue_date = t.queue_date and q.id <> t.id
        and q.status in ('waiting', 'arrived', 'serving', 'on_hold', 'skipped') limit 1;
    if found then
      return private.fail('duplicate', format('A token already exists for this patient: #%s.', v_dup.token_number),
        jsonb_build_object('existing_token_id', v_dup.id));
    end if;
    select coalesce(max(q.order_key), 0) into v_key from public.queue_tokens q
      where q.doctor_id = t.doctor_id and q.queue_date = t.queue_date;
    update public.queue_tokens set status = 'waiting', order_key = v_key + 1 where id = t.id returning * into t;

  elsif p_action = 'complete' then
    if t.status <> 'serving' then return private.bad_transition(t, 'completed'); end if;
    t := private.finish_token(t, v_now);

  elsif p_action = 'skip' then
    if t.status not in ('serving', 'waiting') then return private.bad_transition(t, 'skipped'); end if;
    update public.queue_tokens set status = 'skipped' where id = t.id returning * into t;

  elsif p_action = 'hold' then
    if t.status <> 'serving' then return private.bad_transition(t, 'put on hold'); end if;
    update public.queue_tokens set status = 'on_hold' where id = t.id returning * into t;

  elsif p_action = 'resume' then
    if t.status <> 'on_hold' then return private.bad_transition(t, 'resumed'); end if;
    -- A held patient goes to the front of the waiting line.
    select coalesce(min(q.order_key), 0) into v_key from public.queue_tokens q
      where q.doctor_id = t.doctor_id and q.queue_date = t.queue_date;
    update public.queue_tokens set status = 'waiting', order_key = v_key - 1 where id = t.id returning * into t;
  end if;

  perform private.sync_appointment(t);
  return jsonb_build_object('ok', true, 'token', private.token_json(t));
end $$;

create function public.mark_arrived(p_token_id uuid) returns jsonb
language sql security definer set search_path = '' as $$ select private.act_on_token(p_token_id, 'arrived') $$;
create function public.mark_no_show(p_token_id uuid) returns jsonb
language sql security definer set search_path = '' as $$ select private.act_on_token(p_token_id, 'no_show') $$;
create function public.requeue_token(p_token_id uuid) returns jsonb
language sql security definer set search_path = '' as $$ select private.act_on_token(p_token_id, 'requeue') $$;
create function public.complete_token(p_token_id uuid) returns jsonb
language sql security definer set search_path = '' as $$ select private.act_on_token(p_token_id, 'complete') $$;
create function public.skip_token(p_token_id uuid) returns jsonb
language sql security definer set search_path = '' as $$ select private.act_on_token(p_token_id, 'skip') $$;
create function public.hold_token(p_token_id uuid) returns jsonb
language sql security definer set search_path = '' as $$ select private.act_on_token(p_token_id, 'hold') $$;
create function public.resume_token(p_token_id uuid) returns jsonb
language sql security definer set search_path = '' as $$ select private.act_on_token(p_token_id, 'resume') $$;

-- The NEXT button. Finishes the patient with the doctor and calls the next waiting token.
-- p_expected_current is the token the doctor was looking at: if the queue moved on, nothing happens.
create function public.call_next(p_doctor_id uuid, p_expected_current uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  d public.doctors; v_role text; v_today date; v_now timestamptz := private.clock();
  cur public.queue_tokens; nxt public.queue_tokens; v_done public.queue_tokens; v_called public.queue_tokens;
begin
  select * into d from public.doctors where id = p_doctor_id;
  v_role := case when d.id is null then null else private.member_role(d.clinic_id) end;
  if v_role is null then return private.fail('doctor_unavailable', 'This doctor is not available.'); end if;
  if v_role <> 'doctor' then return private.forbidden(); end if;
  if d.profile_id is distinct from (select auth.uid()) then return private.forbidden('This queue belongs to another doctor.'); end if;
  if not d.is_active then return private.fail('doctor_unavailable', 'This doctor is not available.'); end if;

  perform private.lock_doctor(d.id);
  v_today := private.today(d.clinic_id);

  select * into cur from public.queue_tokens q
    where q.doctor_id = d.id and q.queue_date = v_today and q.status = 'serving' for update;
  if cur.id is distinct from p_expected_current then
    return private.fail('stale', 'The queue has changed. The screen was updated, please check and try again.');
  end if;
  if cur.started_at is not null and extract(epoch from (v_now - cur.started_at)) < 3 then
    return private.fail('too_soon', 'This patient was only just called. Wait a moment before pressing NEXT again.');
  end if;

  select * into nxt from public.queue_tokens q
    where q.doctor_id = d.id and q.queue_date = v_today and q.status = 'waiting'
    order by q.order_key, q.token_number limit 1 for update;
  if cur.id is null and nxt.id is null then return private.fail('empty', 'No patients are waiting.'); end if;

  if cur.id is not null then v_done := private.finish_token(cur, v_now); end if;
  if nxt.id is not null then
    update public.queue_tokens
    set status = 'serving', started_at = v_now,
        arrived_at = coalesce(arrived_at, v_now),
        arrival_source = case when arrived_at is null then 'doctor_call' else arrival_source end
    where id = nxt.id returning * into v_called;
    perform private.sync_appointment(v_called);
  end if;

  return jsonb_build_object('ok', true,
    'completed', case when v_done.id is null then null else private.token_json(v_done) end,
    'called', case when v_called.id is null then null else private.token_json(v_called) end);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Patients and visits
-- ---------------------------------------------------------------------------------------------------------------

-- Reception, owner and doctors search patients by part of the name or the phone number.
create function public.search_patients(p_clinic uuid, p_query text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_text text := lower(btrim(coalesce(p_query, '')));
  v_digits text := regexp_replace(coalesce(p_query, ''), '\D', '', 'g');
  v_tz text; v_rows jsonb;
begin
  if private.member_role(p_clinic) is null then return private.forbidden('You do not have access to this clinic.'); end if;
  if char_length(v_text) < 2 and char_length(v_digits) < 2 then
    return jsonb_build_object('ok', true, 'patients', '[]'::jsonb);
  end if;
  select timezone into v_tz from public.clinics where id = p_clinic;
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'phone', r.phone,
           'visit_count', r.visit_count, 'last_visit_date', r.last_visit_date) order by lower(r.name), r.id), '[]'::jsonb)
    into v_rows
  from (
    select p.id, p.name, p.phone,
           (select count(*) from public.visits v where v.patient_id = p.id) as visit_count,
           (select max((v.visit_date at time zone v_tz)::date) from public.visits v where v.patient_id = p.id) as last_visit_date
    from public.patients p
    where p.clinic_id = p_clinic
      and ((char_length(v_text) >= 2 and strpos(lower(p.name), v_text) > 0)
        or (char_length(v_digits) >= 2 and strpos(coalesce(p.phone, ''), v_digits) > 0))
    order by lower(p.name), p.id
    limit 25) r;
  return jsonb_build_object('ok', true, 'patients', v_rows);
end $$;

-- Visit dates and titles only. This is everything a receptionist or the owner may see of a patient's visits.
create function public.get_patient_visit_list(p_clinic uuid, p_patient_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.patients; v_tz text; v_rows jsonb;
begin
  if private.member_role(p_clinic) is null then return private.forbidden('You do not have access to this clinic.'); end if;
  select * into p from public.patients where id = p_patient_id and clinic_id = p_clinic;
  if not found then return private.fail('not_found', 'This patient could not be found.'); end if;
  select timezone into v_tz from public.clinics where id = p_clinic;
  select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'date', (v.visit_date at time zone v_tz)::date,
           'title', coalesce(v.title, 'Consultation'), 'doctor_name', d.name)
         order by v.visit_date desc, v.created_at desc), '[]'::jsonb) into v_rows
  from public.visits v join public.doctors d on d.id = v.doctor_id
  where v.patient_id = p.id and v.clinic_id = p_clinic;
  return jsonb_build_object('ok', true, 'patient', jsonb_build_object('id', p.id, 'name', p.name, 'phone', p.phone), 'visits', v_rows);
end $$;

-- The full clinical history. Doctors only, and every read is written to the audit log.
create function public.get_patient_history(p_clinic uuid, p_patient_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.patients; v_tz text; v_rows jsonb; v_loose jsonb;
begin
  if private.member_role(p_clinic) is distinct from 'doctor' then return private.forbidden(); end if;
  select * into p from public.patients where id = p_patient_id and clinic_id = p_clinic;
  if not found then return private.fail('not_found', 'This patient could not be found.'); end if;
  select timezone into v_tz from public.clinics where id = p_clinic;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', v.id, 'date', (v.visit_date at time zone v_tz)::date, 'title', coalesce(v.title, 'Consultation'),
      'symptoms', v.symptoms, 'diagnosis', v.diagnosis, 'notes', v.doctor_notes, 'advice', v.advice,
      'doctor_id', v.doctor_id, 'doctor_name', d.name, 'token_id', v.queue_token_id, 'created_at', v.created_at,
      'prescription', (select jsonb_build_object('id', rx.id, 'medicines', rx.medicines, 'instructions', rx.instructions)
                       from public.prescriptions rx where rx.visit_id = v.id),
      'reports', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.report_name, 'content_type', r.content_type,
                          'size_bytes', r.size_bytes, 'uploaded_at', r.uploaded_at) order by r.uploaded_at), '[]'::jsonb)
                  from public.patient_reports r where r.visit_id = v.id))
    order by v.visit_date desc, v.created_at desc), '[]'::jsonb) into v_rows
  from public.visits v join public.doctors d on d.id = v.doctor_id
  where v.patient_id = p.id and v.clinic_id = p_clinic;

  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.report_name, 'content_type', r.content_type,
           'size_bytes', r.size_bytes, 'uploaded_at', r.uploaded_at) order by r.uploaded_at), '[]'::jsonb) into v_loose
  from public.patient_reports r where r.patient_id = p.id and r.clinic_id = p_clinic and r.visit_id is null;

  perform private.audit(p_clinic, 'patient.history_read', 'patient', p.id);
  return jsonb_build_object('ok', true, 'patient', jsonb_build_object('id', p.id, 'name', p.name, 'phone', p.phone),
    'visits', v_rows, 'other_reports', v_loose);
end $$;

-- A doctor writes or updates a consultation note. Doctors change only their own visits.
create function public.save_visit(p_clinic uuid, p_patient_id uuid, p_visit_id uuid, p_title text, p_notes text default null,
                                  p_advice text default null, p_date date default null, p_symptoms text default null,
                                  p_diagnosis text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_my uuid; v_today date; v_tz text; v_date date;
  v_title text := btrim(coalesce(p_title, '')); v_notes text := btrim(coalesce(p_notes, ''));
  v_advice text := btrim(coalesce(p_advice, '')); v_symptoms text := nullif(btrim(coalesce(p_symptoms, '')), '');
  v_diagnosis text := nullif(btrim(coalesce(p_diagnosis, '')), '');
  v_errors jsonb := '{}'::jsonb; v public.visits; v_when timestamptz; v_created boolean := false;
begin
  if private.member_role(p_clinic) is distinct from 'doctor' then return private.forbidden(); end if;
  v_my := private.my_doctor_id(p_clinic);
  if v_my is null then return private.forbidden('Your account is not linked to a doctor in this clinic.'); end if;
  if not exists (select 1 from public.patients where id = p_patient_id and clinic_id = p_clinic) then
    return private.fail('not_found', 'This patient could not be found.');
  end if;

  v_today := private.today(p_clinic);
  v_date := coalesce(p_date, v_today);
  if v_title = '' then v_errors := v_errors || jsonb_build_object('title', 'Enter a short reason for the visit.'); end if;
  if char_length(v_title) > 120 then v_errors := v_errors || jsonb_build_object('title', 'Keep the reason under 120 characters.'); end if;
  if char_length(v_notes) > 2000 then v_errors := v_errors || jsonb_build_object('notes', 'Keep the notes under 2000 characters.'); end if;
  if char_length(v_advice) > 2000 then v_errors := v_errors || jsonb_build_object('advice', 'Keep the advice under 2000 characters.'); end if;
  if char_length(coalesce(v_symptoms, '')) > 2000 then v_errors := v_errors || jsonb_build_object('symptoms', 'Keep the symptoms under 2000 characters.'); end if;
  if char_length(coalesce(v_diagnosis, '')) > 2000 then v_errors := v_errors || jsonb_build_object('diagnosis', 'Keep the diagnosis under 2000 characters.'); end if;
  if v_date > v_today then v_errors := v_errors || jsonb_build_object('date', 'The visit date cannot be in the future.'); end if;
  if v_notes = '' and v_advice = '' and v_diagnosis is null then
    v_errors := v_errors || jsonb_build_object('notes', 'Add a consultation note or advice.');
  end if;
  if v_errors <> '{}'::jsonb then
    return private.fail('invalid_input', 'Please fix the highlighted fields.', jsonb_build_object('field_errors', v_errors));
  end if;

  select timezone into v_tz from public.clinics where id = p_clinic;
  -- Today keeps the real time. An earlier day is recorded at noon of that day in the clinic's time zone.
  v_when := case when v_date = v_today then private.clock() else ((v_date::timestamp + time '12:00') at time zone v_tz) end;

  if p_visit_id is not null then
    select * into v from public.visits where id = p_visit_id and patient_id = p_patient_id and clinic_id = p_clinic for update;
    if not found then return private.fail('not_found', 'This visit could not be found.'); end if;
    if v.doctor_id <> v_my then return private.forbidden('This record belongs to another doctor.'); end if;
    update public.visits
    set title = v_title, doctor_notes = nullif(v_notes, ''), advice = nullif(v_advice, ''), symptoms = v_symptoms,
        diagnosis = v_diagnosis, visit_date = case when (v.visit_date at time zone v_tz)::date = v_date then v.visit_date else v_when end
    where id = v.id returning * into v;
  else
    insert into public.visits (clinic_id, patient_id, doctor_id, visit_date, title, doctor_notes, advice, symptoms, diagnosis, created_at)
    values (p_clinic, p_patient_id, v_my, v_when, v_title, nullif(v_notes, ''), nullif(v_advice, ''), v_symptoms, v_diagnosis, private.clock())
    returning * into v;
    v_created := true;
  end if;

  perform private.audit(p_clinic, 'visit.save', 'visit', v.id, jsonb_build_object('created', v_created));
  return jsonb_build_object('ok', true, 'visit', jsonb_build_object('id', v.id, 'date', (v.visit_date at time zone v_tz)::date,
    'title', v.title, 'notes', v.doctor_notes, 'advice', v.advice, 'symptoms', v.symptoms, 'diagnosis', v.diagnosis,
    'doctor_id', v.doctor_id));
end $$;

-- A doctor writes the prescription for their own visit. One prescription per visit.
create function public.save_prescription(p_clinic uuid, p_visit_id uuid, p_medicines jsonb, p_instructions text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_my uuid; v public.visits; m jsonb; v_clean jsonb := '[]'::jsonb; v_instr text := nullif(btrim(coalesce(p_instructions, '')), '');
  rx public.prescriptions; v_bad text;
begin
  if private.member_role(p_clinic) is distinct from 'doctor' then return private.forbidden(); end if;
  v_my := private.my_doctor_id(p_clinic);
  if v_my is null then return private.forbidden('Your account is not linked to a doctor in this clinic.'); end if;
  select * into v from public.visits where id = p_visit_id and clinic_id = p_clinic;
  if not found then return private.fail('not_found', 'This visit could not be found.'); end if;
  if v.doctor_id <> v_my then return private.forbidden('This record belongs to another doctor.'); end if;

  if jsonb_typeof(coalesce(p_medicines, 'null'::jsonb)) <> 'array' or jsonb_array_length(p_medicines) > 30 then
    v_bad := 'Send a list of up to 30 medicines.';
  else
    for m in select * from jsonb_array_elements(p_medicines) loop
      if jsonb_typeof(m) <> 'object' or btrim(coalesce(m ->> 'name', '')) = '' then
        v_bad := 'Every medicine needs a name.'; exit;
      end if;
      if char_length(btrim(m ->> 'name')) > 100 or char_length(coalesce(m ->> 'dose', '')) > 100
         or char_length(coalesce(m ->> 'frequency', '')) > 100 or char_length(coalesce(m ->> 'duration', '')) > 100
         or char_length(coalesce(m ->> 'notes', '')) > 200 then
        v_bad := 'A medicine entry is too long.'; exit;
      end if;
      v_clean := v_clean || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'name', btrim(m ->> 'name'),
        'dose', nullif(btrim(coalesce(m ->> 'dose', '')), ''),
        'frequency', nullif(btrim(coalesce(m ->> 'frequency', '')), ''),
        'duration', nullif(btrim(coalesce(m ->> 'duration', '')), ''),
        'notes', nullif(btrim(coalesce(m ->> 'notes', '')), ''))));
    end loop;
  end if;
  if v_bad is null and char_length(coalesce(v_instr, '')) > 2000 then v_bad := 'Keep the instructions under 2000 characters.'; end if;
  if v_bad is null and jsonb_array_length(v_clean) = 0 and v_instr is null then v_bad := 'Add at least one medicine or some instructions.'; end if;
  if v_bad is not null then
    return private.fail('invalid_input', 'Please fix the prescription.', jsonb_build_object('field_errors', jsonb_build_object('medicines', v_bad)));
  end if;

  insert into public.prescriptions (clinic_id, visit_id, patient_id, doctor_id, medicines, instructions, created_at)
  values (p_clinic, v.id, v.patient_id, v_my, v_clean, v_instr, private.clock())
  on conflict (visit_id) do update set medicines = excluded.medicines, instructions = excluded.instructions
  returning * into rx;

  perform private.audit(p_clinic, 'prescription.save', 'prescription', rx.id, jsonb_build_object('visit_id', v.id));
  return jsonb_build_object('ok', true, 'prescription', jsonb_build_object('id', rx.id, 'visit_id', rx.visit_id,
    'medicines', rx.medicines, 'instructions', rx.instructions));
end $$;

-- After a doctor uploads a file to the private bucket, this records it against the patient.
create function public.register_report(p_clinic uuid, p_patient_id uuid, p_visit_id uuid, p_name text, p_path text,
                                       p_content_type text, p_size_bytes bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.patient_reports; v_name text := btrim(coalesce(p_name, ''));
begin
  if private.member_role(p_clinic) is distinct from 'doctor' then return private.forbidden(); end if;
  if char_length(v_name) not between 1 and 120 then
    return private.fail('invalid_input', 'Give the report a name of up to 120 characters.');
  end if;
  if p_content_type is null or p_content_type not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp') then
    return private.fail('invalid_input', 'Upload a PDF, JPEG, PNG or WebP file.');
  end if;
  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 10485760 then
    return private.fail('invalid_input', 'The file must be 10 MB or smaller.');
  end if;
  if not exists (select 1 from public.patients where id = p_patient_id and clinic_id = p_clinic) then
    return private.fail('not_found', 'This patient could not be found.');
  end if;
  if p_visit_id is not null and not exists (select 1 from public.visits where id = p_visit_id and patient_id = p_patient_id and clinic_id = p_clinic) then
    return private.fail('not_found', 'This visit could not be found.');
  end if;
  -- The file must really be in the bucket, inside this clinic's and this patient's folder.
  -- Exactly <clinic id>/<patient id>/<file name>: no deeper folders, no "." or ".." tricks.
  if p_path is null or p_path !~ ('^' || p_clinic::text || '/' || p_patient_id::text || '/[^/]+$')
     or p_path ~ '/\.\.?$' then
    return private.fail('invalid_input', 'The file is not in the right folder.');
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'patient-reports' and o.name = p_path) then
    return private.fail('not_found', 'The uploaded file could not be found.');
  end if;

  insert into public.patient_reports (clinic_id, patient_id, visit_id, report_name, file_path, content_type, size_bytes, uploaded_by, uploaded_at)
  values (p_clinic, p_patient_id, p_visit_id, v_name, p_path, p_content_type, p_size_bytes, (select auth.uid()), private.clock())
  returning * into r;
  perform private.audit(p_clinic, 'report.upload', 'patient_report', r.id, jsonb_build_object('patient_id', p_patient_id));
  return jsonb_build_object('ok', true, 'report', jsonb_build_object('id', r.id, 'name', r.report_name,
    'content_type', r.content_type, 'size_bytes', r.size_bytes, 'uploaded_at', r.uploaded_at));
end $$;

-- A doctor asks to open a report. The answer is the file path; the screen then asks storage for a short lived link.
create function public.authorize_report_download(p_report_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.patient_reports;
begin
  select * into r from public.patient_reports where id = p_report_id;
  if not found or private.member_role(r.clinic_id) is distinct from 'doctor' then
    return private.fail('not_found', 'This report could not be found.');
  end if;
  perform private.audit(r.clinic_id, 'report.open', 'patient_report', r.id, jsonb_build_object('patient_id', r.patient_id));
  return jsonb_build_object('ok', true, 'path', r.file_path, 'name', r.report_name);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Owner: settings, doctors, staff
-- ---------------------------------------------------------------------------------------------------------------
create function public.update_clinic_settings(p_clinic uuid, p_clinic_name text, p_online_booking_enabled boolean,
                                              p_default_daily_limit integer, p_default_minutes_per_patient integer,
                                              p_max_online_bookings_per_phone integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_name text := private.clean_name(p_clinic_name); v_errors jsonb := '{}'::jsonb; s public.clinic_settings;
begin
  if private.member_role(p_clinic) is distinct from 'owner' then return private.forbidden(); end if;
  if char_length(v_name) < 2 or char_length(v_name) > 60 then v_errors := v_errors || jsonb_build_object('clinicName', 'The clinic name needs 2 to 60 characters.'); end if;
  if p_default_daily_limit is null or p_default_daily_limit not between 1 and 500 then v_errors := v_errors || jsonb_build_object('defaultDailyLimit', 'The daily token limit must be between 1 and 500.'); end if;
  if p_default_minutes_per_patient is null or p_default_minutes_per_patient not between 1 and 60 then v_errors := v_errors || jsonb_build_object('defaultMinutesPerPatient', 'Minutes per patient must be between 1 and 60.'); end if;
  if p_max_online_bookings_per_phone is not null and p_max_online_bookings_per_phone not between 1 and 20 then v_errors := v_errors || jsonb_build_object('maxOnlineBookingsPerPhone', 'The daily limit per mobile number must be between 1 and 20.'); end if;
  if p_online_booking_enabled is null then v_errors := v_errors || jsonb_build_object('onlineBookingEnabled', 'Choose on or off.'); end if;
  if v_errors <> '{}'::jsonb then
    return private.fail('invalid_input', 'Please fix the highlighted fields.', jsonb_build_object('field_errors', v_errors));
  end if;

  update public.clinics set name = v_name where id = p_clinic;
  update public.clinic_settings
  set online_booking_enabled = p_online_booking_enabled, daily_token_limit = p_default_daily_limit,
      average_consultation_minutes = p_default_minutes_per_patient,
      max_online_bookings_per_phone_per_day = coalesce(p_max_online_bookings_per_phone, max_online_bookings_per_phone_per_day)
  where clinic_id = p_clinic returning * into s;
  perform private.audit(p_clinic, 'settings.update', 'clinic', p_clinic, jsonb_build_object('online_booking_enabled', s.online_booking_enabled,
    'daily_limit', s.daily_token_limit, 'minutes', s.average_consultation_minutes));
  return jsonb_build_object('ok', true, 'settings', jsonb_build_object('clinic_name', v_name,
    'online_booking_enabled', s.online_booking_enabled, 'default_daily_limit', s.daily_token_limit,
    'default_minutes_per_patient', s.average_consultation_minutes,
    'max_online_bookings_per_phone_per_day', s.max_online_bookings_per_phone_per_day));
end $$;

-- One to three OPD windows, each ending after it starts, none overlapping. Same rules as validateSessions.
create function private.sessions_error(p jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare v_el jsonb; v_s text; v_e text; v_prev_end int := -1; r record;
begin
  if jsonb_typeof(coalesce(p, 'null'::jsonb)) <> 'array' or jsonb_array_length(p) < 1 then return 'Add at least one OPD timing.'; end if;
  if jsonb_array_length(p) > 3 then return 'Use at most 3 OPD timings.'; end if;
  for v_el in select * from jsonb_array_elements(p) loop
    v_s := v_el ->> 'start'; v_e := v_el ->> 'end';
    if v_s is null or v_e is null or v_s !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' or v_e !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
      return 'Enter every OPD time as hours and minutes.';
    end if;
    if (v_e::time) <= (v_s::time) then return 'Each OPD timing must end after it starts.'; end if;
  end loop;
  for r in select (x.el ->> 'start')::time as s_t, (x.el ->> 'end')::time as e_t
           from jsonb_array_elements(p) as x(el) order by 1 loop
    if v_prev_end >= 0 and (extract(hour from r.s_t) * 60 + extract(minute from r.s_t))::int < v_prev_end then
      return 'OPD timings must not overlap.';
    end if;
    v_prev_end := (extract(hour from r.e_t) * 60 + extract(minute from r.e_t))::int;
  end loop;
  return null;
end $$;

-- OPD timings apply to every day of the week for now. Stored per weekday so a later change needs no new table.
create function private.write_sessions(p_clinic uuid, p_doctor uuid, p_sessions jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.doctor_schedules where doctor_id = p_doctor;
  insert into public.doctor_schedules (clinic_id, doctor_id, day_of_week, start_time, end_time, is_available)
  select p_clinic, p_doctor, g.dow, (x.el ->> 'start')::time, (x.el ->> 'end')::time, true
  from generate_series(0, 6) as g(dow), jsonb_array_elements(p_sessions) as x(el);
end $$;

create function private.doctor_errors(p_name text, p_opd text, p_sessions jsonb, p_limit integer, p_minutes integer) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare e jsonb := '{}'::jsonb; v_err text;
begin
  if char_length(private.clean_name(p_name)) not between 2 and 60 then e := e || jsonb_build_object('name', 'The doctor name needs 2 to 60 characters.'); end if;
  if char_length(btrim(coalesce(p_opd, ''))) not between 2 and 40 then e := e || jsonb_build_object('opd', 'The OPD name needs 2 to 40 characters.'); end if;
  v_err := private.sessions_error(p_sessions);
  if v_err is not null then e := e || jsonb_build_object('sessions', v_err); end if;
  if p_limit is not null and p_limit not between 1 and 500 then e := e || jsonb_build_object('dailyLimit', 'The doctor token limit must be between 1 and 500.'); end if;
  if p_minutes is not null and p_minutes not between 1 and 60 then e := e || jsonb_build_object('minutesPerPatient', 'Minutes per patient must be between 1 and 60.'); end if;
  return e;
end $$;

create function private.doctor_json(d public.doctors, p_today date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', d.id, 'name', d.name, 'opd', d.opd_name, 'sessions', private.sessions_json(d.id, p_today),
    'daily_limit', d.daily_token_limit, 'minutes_per_patient', d.minutes_per_patient, 'active', d.is_active,
    'has_login', d.profile_id is not null)
$$;

create function public.add_doctor(p_clinic uuid, p_name text, p_opd text, p_sessions jsonb, p_daily_limit integer default null,
                                  p_minutes_per_patient integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_errors jsonb; d public.doctors;
begin
  if private.member_role(p_clinic) is distinct from 'owner' then return private.forbidden(); end if;
  v_errors := private.doctor_errors(p_name, p_opd, p_sessions, p_daily_limit, p_minutes_per_patient);
  if v_errors <> '{}'::jsonb then
    return private.fail('invalid_input', 'Please fix the highlighted fields.', jsonb_build_object('field_errors', v_errors));
  end if;
  insert into public.doctors (clinic_id, name, opd_name, daily_token_limit, minutes_per_patient)
  values (p_clinic, private.clean_name(p_name), btrim(p_opd), p_daily_limit, p_minutes_per_patient) returning * into d;
  perform private.write_sessions(p_clinic, d.id, p_sessions);
  perform private.audit(p_clinic, 'doctor.add', 'doctor', d.id);
  return jsonb_build_object('ok', true, 'doctor', private.doctor_json(d, private.today(p_clinic)));
end $$;

create function public.update_doctor(p_clinic uuid, p_doctor_id uuid, p_name text, p_opd text, p_sessions jsonb,
                                     p_daily_limit integer default null, p_minutes_per_patient integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_errors jsonb; d public.doctors;
begin
  if private.member_role(p_clinic) is distinct from 'owner' then return private.forbidden(); end if;
  select * into d from public.doctors where id = p_doctor_id and clinic_id = p_clinic and is_active for update;
  if not found then return private.fail('not_found', 'This doctor could not be found.'); end if;
  v_errors := private.doctor_errors(p_name, p_opd, p_sessions, p_daily_limit, p_minutes_per_patient);
  if v_errors <> '{}'::jsonb then
    return private.fail('invalid_input', 'Please fix the highlighted fields.', jsonb_build_object('field_errors', v_errors));
  end if;
  update public.doctors set name = private.clean_name(p_name), opd_name = btrim(p_opd), daily_token_limit = p_daily_limit,
    minutes_per_patient = p_minutes_per_patient where id = d.id returning * into d;
  perform private.write_sessions(p_clinic, d.id, p_sessions);
  perform private.audit(p_clinic, 'doctor.update', 'doctor', d.id);
  return jsonb_build_object('ok', true, 'doctor', private.doctor_json(d, private.today(p_clinic)));
end $$;

-- A removed doctor is kept (inactive) so old reports still add up. Refused while the doctor has open tokens.
create function public.remove_doctor(p_clinic uuid, p_doctor_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.doctors; v_open int; v_today date;
begin
  if private.member_role(p_clinic) is distinct from 'owner' then return private.forbidden(); end if;
  select * into d from public.doctors where id = p_doctor_id and clinic_id = p_clinic and is_active for update;
  if not found then return private.fail('not_found', 'This doctor could not be found.'); end if;
  if (select count(*) from public.doctors x where x.clinic_id = p_clinic and x.is_active) <= 1 then
    return private.fail('invalid_transition', 'Keep at least one doctor. Add another doctor before removing this one.');
  end if;
  perform private.lock_doctor(d.id);
  v_today := private.today(p_clinic);
  select count(*) into v_open from public.queue_tokens q
    where q.doctor_id = d.id and q.queue_date between v_today and v_today + 1 and q.status in ('waiting', 'arrived', 'serving', 'on_hold', 'skipped');
  if v_open > 0 then
    return private.fail('invalid_transition', format('%s still has %s open token%s for today or tomorrow. Finish or cancel them first.',
      d.name, v_open, case when v_open = 1 then '' else 's' end));
  end if;
  update public.doctors set is_active = false where id = d.id returning * into d;
  perform private.audit(p_clinic, 'doctor.remove', 'doctor', d.id);
  return jsonb_build_object('ok', true, 'doctor', private.doctor_json(d, v_today));
end $$;

create function public.list_staff(p_clinic uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_staff jsonb; v_free jsonb;
begin
  if private.member_role(p_clinic) is distinct from 'owner' then return private.forbidden(); end if;
  select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role, 'is_active', m.is_active,
           'full_name', pr.full_name, 'email', pr.email, 'doctor_id', d.id, 'doctor_name', d.name, 'created_at', m.created_at)
         order by m.role, m.created_at), '[]'::jsonb) into v_staff
  from public.clinic_memberships m join public.profiles pr on pr.id = m.user_id
  left join public.doctors d on d.clinic_id = m.clinic_id and d.profile_id = m.user_id
  where m.clinic_id = p_clinic;
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'opd', d.opd_name) order by d.created_at), '[]'::jsonb) into v_free
  from public.doctors d where d.clinic_id = p_clinic and d.is_active and d.profile_id is null;
  return jsonb_build_object('ok', true, 'staff', v_staff, 'doctors_without_login', v_free);
end $$;

create function public.set_staff_active(p_clinic uuid, p_user_id uuid, p_active boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.clinic_memberships;
begin
  if private.member_role(p_clinic) is distinct from 'owner' then return private.forbidden(); end if;
  select * into m from public.clinic_memberships where clinic_id = p_clinic and user_id = p_user_id for update;
  if not found then return private.fail('not_found', 'This staff member could not be found.'); end if;
  if m.role = 'owner' then return private.fail('invalid_transition', 'The clinic owner cannot be switched off.'); end if;
  update public.clinic_memberships set is_active = coalesce(p_active, false) where id = m.id;
  perform private.audit(p_clinic, case when p_active then 'staff.activate' else 'staff.deactivate' end, 'user', p_user_id);
  return jsonb_build_object('ok', true, 'user_id', p_user_id, 'is_active', coalesce(p_active, false));
end $$;

-- Called only by the invite-staff Edge Function, after it has checked the caller is the clinic owner and created the
-- invitation. Not callable by browsers (see migration 5).
create function public.attach_staff(p_clinic uuid, p_user_id uuid, p_role text, p_doctor_id uuid, p_invited_by uuid,
                                    p_full_name text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.clinic_memberships; d public.doctors;
begin
  if p_role not in ('receptionist', 'doctor') then return private.fail('invalid_input', 'Staff can be a receptionist or a doctor.'); end if;
  if not exists (select 1 from public.clinics where id = p_clinic) then return private.fail('not_found', 'This clinic could not be found.'); end if;
  if p_role = 'doctor' then
    select * into d from public.doctors where id = p_doctor_id and clinic_id = p_clinic and is_active for update;
    if not found then return private.fail('not_found', 'Choose which doctor this login is for.'); end if;
    if d.profile_id is not null and d.profile_id <> p_user_id then
      return private.fail('invalid_transition', 'This doctor already has a login.');
    end if;
  end if;

  insert into public.profiles (id, email, full_name)
  select u.id, u.email, nullif(btrim(coalesce(p_full_name, '')), '') from auth.users u where u.id = p_user_id
  on conflict (id) do update set full_name = coalesce(public.profiles.full_name, excluded.full_name);

  select * into m from public.clinic_memberships where clinic_id = p_clinic and user_id = p_user_id;
  if found and m.role <> p_role then
    return private.fail('invalid_transition', 'This person already works in the clinic in a different role.');
  end if;
  insert into public.clinic_memberships (clinic_id, user_id, role, is_active, invited_by)
  values (p_clinic, p_user_id, p_role, true, p_invited_by)
  on conflict (clinic_id, user_id) do update set is_active = true;
  if p_role = 'doctor' then update public.doctors set profile_id = p_user_id where id = d.id; end if;

  perform private.audit(p_clinic, 'staff.invite', 'user', p_user_id, jsonb_build_object('role', p_role), p_invited_by);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Reports: counted from the token records, nothing typed in by hand (dayStats)
-- ---------------------------------------------------------------------------------------------------------------
create function public.get_report_series(p_clinic uuid, p_end date default null, p_doctor_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_end date; v_rows jsonb;
begin
  if coalesce(private.member_role(p_clinic), '') not in ('owner', 'doctor') then return private.forbidden(); end if;
  v_end := coalesce(p_end, private.today(p_clinic));
  select coalesce(jsonb_agg(jsonb_build_object('date', x.day, 'total', x.total, 'completed', x.completed, 'no_show', x.no_show,
           'cancelled', x.cancelled, 'average_wait_minutes', x.avg_wait, 'wait_samples', x.samples) order by x.day), '[]'::jsonb) into v_rows
  from (
    select (v_end - 6 + g.i) as day,
      count(q.id) filter (where q.status <> 'cancelled') as total,
      count(q.id) filter (where q.status = 'completed') as completed,
      count(q.id) filter (where q.status = 'no_show') as no_show,
      count(q.id) filter (where q.status = 'cancelled') as cancelled,
      round(avg(greatest(0, extract(epoch from (q.started_at - q.arrived_at)) / 60.0)::numeric) filter (
        where q.status <> 'cancelled' and q.arrived_at is not null and q.started_at is not null and q.arrival_source is distinct from 'doctor_call'))::int as avg_wait,
      count(q.id) filter (where q.status <> 'cancelled' and q.arrived_at is not null and q.started_at is not null
        and q.arrival_source is distinct from 'doctor_call') as samples
    from generate_series(0, 6) as g(i)
    left join public.queue_tokens q on q.clinic_id = p_clinic and q.queue_date = (v_end - 6 + g.i)
      and (p_doctor_id is null or q.doctor_id = p_doctor_id)
    group by g.i) x;
  return jsonb_build_object('ok', true, 'days', v_rows);
end $$;

-- One row per OPD per day for a month, for the CSV export.
create function public.get_report_month(p_clinic uuid, p_month date, p_doctor_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_first date := date_trunc('month', p_month)::date; v_rows jsonb;
begin
  if coalesce(private.member_role(p_clinic), '') not in ('owner', 'doctor') then return private.forbidden(); end if;
  select coalesce(jsonb_agg(jsonb_build_object('date', x.day, 'opd', x.opd, 'total', x.total, 'completed', x.completed,
           'no_show', x.no_show, 'cancelled', x.cancelled, 'average_wait_minutes', x.avg_wait) order by x.day, x.created_at, x.doctor_id), '[]'::jsonb) into v_rows
  from (
    select q.queue_date as day, d.id as doctor_id, d.opd_name as opd, d.created_at,
      count(*) filter (where q.status <> 'cancelled') as total,
      count(*) filter (where q.status = 'completed') as completed,
      count(*) filter (where q.status = 'no_show') as no_show,
      count(*) filter (where q.status = 'cancelled') as cancelled,
      round(avg(greatest(0, extract(epoch from (q.started_at - q.arrived_at)) / 60.0)::numeric) filter (
        where q.status <> 'cancelled' and q.arrived_at is not null and q.started_at is not null and q.arrival_source is distinct from 'doctor_call'))::int as avg_wait
    from public.queue_tokens q join public.doctors d on d.id = q.doctor_id
    where q.clinic_id = p_clinic and q.queue_date >= v_first and q.queue_date < (v_first + interval '1 month')::date
      and (p_doctor_id is null or q.doctor_id = p_doctor_id)
    group by q.queue_date, d.id, d.opd_name, d.created_at) x;
  return jsonb_build_object('ok', true, 'rows', v_rows);
end $$;
