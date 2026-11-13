-- Cliniq migration 3 of 5: shared queue rules and the functions the public (patient) screens call.
--
-- These are the same rules the demo keeps in src/domain/queue.ts, moved to the database so that no screen and no
-- browser decides a token number. Every function:
--   * is SECURITY DEFINER with an empty search_path, and uses fully qualified names
--   * returns jsonb: { ok: true, ... } or { ok: false, code, message, field_errors? }, like the demo's Result type
--   * gives the public only what a patient's own screen shows: token numbers, never names, phones or notes
-- Who may call what is set in migration 5.

-- ---------------------------------------------------------------------------------------------------------------
-- Small shared helpers (private schema, not reachable through the API)
-- ---------------------------------------------------------------------------------------------------------------

-- Every rule that depends on the time reads it here, so tests can move the clock.
create function private.clock() returns timestamptz
language sql stable set search_path = '' as $$ select now() $$;

create function private.fail(p_code text, p_message text, p_extra jsonb default '{}'::jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('ok', false, 'code', p_code, 'message', p_message) || coalesce(p_extra, '{}'::jsonb)
$$;

-- "Today" in the clinic's own time zone, never the device's or the server's.
create function private.today(p_clinic uuid) returns date
language sql stable security definer set search_path = '' as $$
  select (private.clock() at time zone c.timezone)::date from public.clinics c where c.id = p_clinic
$$;

create function private.normalize_phone(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
begin
  if length(d) = 12 and left(d, 2) = '91' then d := substr(d, 3);
  elsif length(d) = 11 and left(d, 1) = '0' then d := substr(d, 2);
  end if;
  if d ~ '^[6-9][0-9]{9}$' then return d; end if;
  return null;
end $$;

create function private.clean_name(p text) returns text
language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'))
$$;

create function private.name_error(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare n text := private.clean_name(p);
begin
  if n = '' then return 'Enter the patient name.'; end if;
  if char_length(n) < 2 then return 'The name must have at least 2 letters.'; end if;
  if char_length(n) > 60 then return 'The name can have at most 60 characters.'; end if;
  -- Letters of any script are allowed. Digits and ASCII symbols other than . ' - are not.
  if n ~ '^[.''-]' or n ~ '[0-9\x01-\x1f\x7f!"#$%&()*+,/:;<=>?@\[\\\]^_`{|}~]' then
    return 'Use letters, spaces, dots, apostrophes or hyphens only.';
  end if;
  return null;
end $$;

create function private.contact_errors(p_name text, p_phone text) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare e jsonb := '{}'::jsonb;
begin
  if private.name_error(p_name) is not null then e := e || jsonb_build_object('name', private.name_error(p_name)); end if;
  if btrim(coalesce(p_phone, '')) = '' then
    e := e || jsonb_build_object('phone', 'Enter a mobile number.');
  elsif private.normalize_phone(p_phone) is null then
    e := e || jsonb_build_object('phone', 'Enter a valid 10 digit mobile number that starts with 6, 7, 8 or 9.');
  end if;
  return e;
end $$;

create function private.status_label(p text) returns text
language sql immutable set search_path = '' as $$
  select case p when 'waiting' then 'waiting' when 'serving' then 'in progress' when 'completed' then 'completed'
    when 'no_show' then 'no-show' when 'skipped' then 'skipped' when 'on_hold' then 'on hold'
    when 'cancelled' then 'cancelled' else p end
$$;

create function private.bad_transition(t public.queue_tokens, p_wanted text) returns jsonb
language sql immutable set search_path = '' as $$
  select private.fail('invalid_transition',
    format('Token #%s cannot be %s while it is %s.', t.token_number, p_wanted, private.status_label(t.status)))
$$;

create function private.token_json(t public.queue_tokens) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', t.id, 'number', t.token_number, 'order_key', t.order_key, 'doctor_id', t.doctor_id,
    'patient_id', t.patient_id, 'date', t.queue_date, 'source', t.source, 'status', t.status,
    'created_at', t.created_at, 'arrived_at', t.arrived_at, 'arrival_source', t.arrival_source,
    'started_at', t.started_at, 'completed_at', t.completed_at)
$$;

-- Serialises everything that changes one doctor's queue. Always taken before any token row lock.
create function private.lock_doctor(p_doctor uuid) returns void
language sql security definer set search_path = '' as $$
  select 1 from public.doctors d where d.id = p_doctor for update
$$;

-- Keeps the appointment row in step with its token.
create function private.sync_appointment(t public.queue_tokens) returns void
language sql security definer set search_path = '' as $$
  update public.appointments a
  set status = case t.status when 'completed' then 'completed' when 'cancelled' then 'cancelled'
                 when 'no_show' then 'no_show' when 'waiting' then 'booked' else 'confirmed' end
  where a.id = t.appointment_id
$$;

create function private.audit(p_clinic uuid, p_action text, p_entity_type text default null, p_entity_id uuid default null,
                              p_details jsonb default '{}'::jsonb, p_actor uuid default null) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_log (clinic_id, actor_id, actor_role, action, entity_type, entity_id, details, created_at)
  values (p_clinic, coalesce((select auth.uid()), p_actor), private.member_role(p_clinic), p_action, p_entity_type,
          p_entity_id, coalesce(p_details, '{}'::jsonb), private.clock())
$$;

-- OPD timings for one doctor on one date, as [{start, end}].
create function private.sessions_json(p_doctor uuid, p_date date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'))
                            order by s.start_time), '[]'::jsonb)
  from public.doctor_schedules s
  where s.doctor_id = p_doctor and s.day_of_week = extract(dow from p_date)::int and s.is_available
$$;

-- Clock time after p_offset minutes of consulting, counting only OPD hours. Same walk as estimateClockTime.
create function private.estimate_clock_time(p_doctor uuid, p_tz text, p_date date, p_offset integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  w record;
  v_local timestamp := private.clock() at time zone p_tz;
  v_cursor integer;
  v_remaining integer := greatest(0, coalesce(p_offset, 0));
  v_available integer;
begin
  v_cursor := case when p_date = v_local::date then (extract(hour from v_local) * 60 + extract(minute from v_local))::int else 0 end;
  for w in
    select (extract(hour from s.start_time) * 60 + extract(minute from s.start_time))::int as s_min,
           (extract(hour from s.end_time) * 60 + extract(minute from s.end_time))::int as e_min
    from public.doctor_schedules s
    where s.doctor_id = p_doctor and s.day_of_week = extract(dow from p_date)::int and s.is_available
    order by s.start_time
  loop
    if v_cursor >= w.e_min then continue; end if;
    v_cursor := greatest(v_cursor, w.s_min);
    v_available := w.e_min - v_cursor;
    if v_remaining <= v_available then
      return jsonb_build_object('at', (p_date + make_interval(mins => v_cursor + v_remaining)) at time zone p_tz, 'outside_hours', false);
    end if;
    v_remaining := v_remaining - v_available;
    v_cursor := w.e_min;
  end loop;
  return jsonb_build_object('at', (p_date + make_interval(mins => v_cursor + v_remaining)) at time zone p_tz, 'outside_hours', true);
end $$;

-- Whether a patient can book online with this doctor on this day (bookingAvailability).
create function private.availability_json(p_doctor uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare d public.doctors; s public.clinic_settings; v_limit int; v_issued int;
begin
  select * into d from public.doctors where id = p_doctor;
  if not found or not d.is_active then
    return jsonb_build_object('open', false, 'reason', 'doctor_unavailable', 'issued', 0, 'limit', 0);
  end if;
  select * into s from public.clinic_settings where clinic_id = d.clinic_id;
  v_limit := coalesce(d.daily_token_limit, s.daily_token_limit, 100);
  select count(*) into v_issued from public.queue_tokens q
    where q.doctor_id = d.id and q.queue_date = p_date and q.status <> 'cancelled';
  if not coalesce(s.online_booking_enabled, true) then
    return jsonb_build_object('open', false, 'reason', 'online_disabled', 'issued', v_issued, 'limit', v_limit);
  end if;
  if v_issued >= v_limit then
    return jsonb_build_object('open', false, 'reason', 'full', 'issued', v_issued, 'limit', v_limit);
  end if;
  return jsonb_build_object('open', true, 'issued', v_issued, 'limit', v_limit);
end $$;

-- Where one doctor's queue stands. Numbers only: no names, phones or notes (queueStatus plus upcomingTokens).
create function private.board_json(p_doctor uuid, p_date date, p_today date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_current int; v_total int; v_waiting int; v_done int; v_pending int; v_upcoming jsonb;
  v_code text; v_label text;
begin
  select count(*) filter (where status <> 'cancelled'), count(*) filter (where status = 'waiting'),
         count(*) filter (where status = 'completed'), count(*) filter (where status in ('on_hold', 'skipped'))
    into v_total, v_waiting, v_done, v_pending
  from public.queue_tokens where doctor_id = p_doctor and queue_date = p_date;

  select token_number into v_current from public.queue_tokens
    where doctor_id = p_doctor and queue_date = p_date and status = 'serving';

  select coalesce(jsonb_agg(q.token_number order by q.order_key, q.token_number), '[]'::jsonb) into v_upcoming
  from (select token_number, order_key from public.queue_tokens
        where doctor_id = p_doctor and queue_date = p_date and status = 'waiting'
        order by order_key, token_number limit 3) q;

  if p_date > p_today then
    v_code := 'scheduled'; v_label := 'Queue opens on the day of the visit';
  elsif v_current is not null then
    v_code := 'running'; v_label := format('Doctor is seeing token #%s', v_current);
  elsif v_waiting > 0 then
    if v_done > 0 then v_code := 'between'; v_label := 'Between patients, the next token will be called soon';
    else v_code := 'not_started'; v_label := 'Not started yet'; end if;
  elsif v_pending > 0 then
    v_code := 'between'; v_label := 'Waiting for held or skipped patients';
  elsif v_total = 0 then
    v_code := 'not_started'; v_label := 'No tokens issued yet';
  else
    v_code := 'finished'; v_label := 'All tokens for today are done';
  end if;

  return jsonb_build_object('status', jsonb_build_object('code', v_code, 'label', v_label),
    'current_number', v_current, 'upcoming', v_upcoming, 'waiting_count', v_waiting);
end $$;

-- Everything a patient screen needs about one token (queueView).
create function private.token_view_json(t public.queue_tokens) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  d public.doctors; s public.clinic_settings; c public.clinics;
  v_minutes int; v_serving boolean; v_before int; v_ahead int; v_wait int; v_est jsonb;
  v_front int; v_finished int; v_progress numeric;
begin
  select * into d from public.doctors where id = t.doctor_id;
  select * into s from public.clinic_settings where clinic_id = t.clinic_id;
  select * into c from public.clinics where id = t.clinic_id;
  v_minutes := coalesce(d.minutes_per_patient, s.average_consultation_minutes, 10);

  select exists (select 1 from public.queue_tokens x
                 where x.doctor_id = t.doctor_id and x.queue_date = t.queue_date and x.status = 'serving') into v_serving;

  if t.status = 'serving' then
    v_ahead := 0;
  elsif t.status = 'waiting' then
    select count(*) into v_before from public.queue_tokens w
      where w.doctor_id = t.doctor_id and w.queue_date = t.queue_date and w.status = 'waiting'
        and (w.order_key < t.order_key or (w.order_key = t.order_key and w.token_number < t.token_number));
    v_ahead := v_before + case when v_serving then 1 else 0 end;
  end if;

  if v_ahead is not null then
    v_wait := v_ahead * v_minutes;
    v_est := private.estimate_clock_time(t.doctor_id, c.timezone, t.queue_date, v_wait);
  end if;

  select count(*), count(*) filter (where x.status in ('completed', 'no_show', 'skipped')) into v_front, v_finished
  from public.queue_tokens x
  where x.doctor_id = t.doctor_id and x.queue_date = t.queue_date and x.status <> 'cancelled'
    and x.id <> t.id and x.order_key < t.order_key;
  v_progress := case when t.status = 'completed' then 1 when v_front = 0 then 1 else v_finished::numeric / v_front end;

  return jsonb_build_object('patients_ahead', v_ahead, 'estimated_wait_minutes', v_wait, 'estimated_time', v_est,
    'progress', round(v_progress, 4), 'minutes_per_patient', v_minutes);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Creating a token. Used by public booking and by reception's walk-in entry. The caller has already taken
-- private.lock_doctor(), so the number below cannot be handed out twice.
-- ---------------------------------------------------------------------------------------------------------------
create function private.create_token(p_clinic uuid, p_doctor uuid, p_name text, p_phone text, p_date date,
                                     p_source text, p_allow_over boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := private.today(p_clinic);
  v_errors jsonb := private.contact_errors(p_name, p_phone);
  v_name text; v_phone text; v_tz text;
  d public.doctors; s public.clinic_settings;
  v_limit int; v_issued int; v_patient uuid; v_dup public.queue_tokens; v_count int;
  v_number int; v_order int; v_appt uuid; t public.queue_tokens; v_now timestamptz := private.clock();
begin
  if v_errors <> '{}'::jsonb then
    return private.fail('invalid_input', 'Please fix the highlighted fields.', jsonb_build_object('field_errors', v_errors));
  end if;
  v_name := private.clean_name(p_name);
  v_phone := private.normalize_phone(p_phone);

  select * into d from public.doctors where id = p_doctor and clinic_id = p_clinic;
  if not found or not d.is_active then
    return private.fail('doctor_unavailable', 'This doctor or OPD is not available.');
  end if;
  select * into s from public.clinic_settings where clinic_id = p_clinic;
  select timezone into v_tz from public.clinics where id = p_clinic;

  if p_source = 'online' then
    if p_date is null or (p_date <> v_today and p_date <> v_today + 1) then
      return private.fail('invalid_date', 'You can book a token for today or tomorrow only.');
    end if;
    if not coalesce(s.online_booking_enabled, true) then
      return private.fail('online_disabled', 'Online booking is switched off. Please visit the clinic reception.');
    end if;
  elsif p_date is distinct from v_today then
    return private.fail('invalid_date', 'Walk-in tokens are for today only.');
  end if;

  v_limit := coalesce(d.daily_token_limit, s.daily_token_limit, 100);
  select count(*) into v_issued from public.queue_tokens q
    where q.doctor_id = d.id and q.queue_date = p_date and q.status <> 'cancelled';
  if v_issued >= v_limit and not (p_source = 'walk_in' and coalesce(p_allow_over, false)) then
    return private.fail('full', format('All %s tokens for %s are booked for this day.', v_limit, d.opd_name));
  end if;

  -- The same name and mobile number is one patient record. One live token per patient, doctor and day.
  select p.id into v_patient from public.patients p
    where p.clinic_id = p_clinic and p.phone = v_phone and lower(p.name) = lower(v_name);
  if v_patient is not null then
    select * into v_dup from public.queue_tokens q
      where q.patient_id = v_patient and q.doctor_id = d.id and q.queue_date = p_date
        and q.status in ('waiting', 'arrived', 'serving', 'on_hold', 'skipped')
      limit 1;
    if found then
      return private.fail('duplicate', format('A token already exists for this patient: #%s.', v_dup.token_number),
        jsonb_build_object('existing_token_id', v_dup.id, 'existing_access_key', v_dup.access_key));
    end if;
  end if;

  -- Per mobile number cap on public bookings in one clinic day. Walk-ins are never counted or blocked.
  if p_source = 'online' then
    select count(*) into v_count
    from public.appointments a join public.patients p on p.id = a.patient_id
    where a.clinic_id = p_clinic and a.booking_source = 'online' and p.phone = v_phone
      and a.created_at >= (v_today::timestamp at time zone v_tz);
    if v_count >= coalesce(s.max_online_bookings_per_phone_per_day, 4) then
      return private.fail('rate_limited',
        'Too many tokens were booked with this mobile number today. Please visit the clinic reception.');
    end if;
  end if;

  if v_patient is null then
    insert into public.patients (clinic_id, name, phone) values (p_clinic, v_name, v_phone)
    on conflict (clinic_id, phone, (lower(name))) do nothing
    returning id into v_patient;
    if v_patient is null then
      select p.id into v_patient from public.patients p
        where p.clinic_id = p_clinic and p.phone = v_phone and lower(p.name) = lower(v_name);
    end if;
  end if;

  -- Token numbers are never reused, even after a cancellation.
  select coalesce(max(q.token_number), 0) + 1, coalesce(max(q.order_key), 0) + 1 into v_number, v_order
  from public.queue_tokens q where q.doctor_id = d.id and q.queue_date = p_date;
  v_order := greatest(v_order, v_number);

  insert into public.appointments (clinic_id, patient_id, doctor_id, appointment_date, booking_source, status, created_at)
  values (p_clinic, v_patient, d.id, p_date, p_source, 'booked', v_now)
  returning id into v_appt;

  insert into public.queue_tokens (clinic_id, patient_id, doctor_id, appointment_id, token_number, queue_date, status,
                                   order_key, source, arrived_at, arrival_source, created_at)
  values (p_clinic, v_patient, d.id, v_appt, v_number, p_date, 'waiting', v_order, p_source,
          case when p_source = 'walk_in' then v_now end, case when p_source = 'walk_in' then 'walk_in' end, v_now)
  returning * into t;

  return jsonb_build_object('ok', true, 'token', private.token_json(t), 'access_key', t.access_key);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- PUBLIC FUNCTIONS (anon and signed in users). Patients are never logged in; their link carries an access key.
-- ---------------------------------------------------------------------------------------------------------------

-- Booking page: clinic name, doctors, OPD timings and whether today and tomorrow are open.
create function public.get_public_clinic(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.clinics; s public.clinic_settings; v_today date; v_doctors jsonb;
begin
  select * into c from public.clinics where slug = lower(btrim(coalesce(p_slug, '')));
  if not found then return private.fail('not_found', 'This clinic could not be found.'); end if;
  select * into s from public.clinic_settings where clinic_id = c.id;
  v_today := private.today(c.id);

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id, 'name', d.name, 'opd', d.opd_name,
      'sessions', private.sessions_json(d.id, v_today),
      'daily_limit', coalesce(d.daily_token_limit, s.daily_token_limit, 100),
      'minutes_per_patient', coalesce(d.minutes_per_patient, s.average_consultation_minutes, 10),
      'availability', jsonb_build_object('today', private.availability_json(d.id, v_today),
                                         'tomorrow', private.availability_json(d.id, v_today + 1)))
    order by d.created_at, d.id), '[]'::jsonb) into v_doctors
  from public.doctors d where d.clinic_id = c.id and d.is_active;

  return jsonb_build_object('ok', true,
    'clinic', jsonb_build_object('name', c.name, 'slug', c.slug, 'timezone', c.timezone),
    'now', private.clock(), 'today', v_today, 'tomorrow', v_today + 1,
    'online_booking_enabled', coalesce(s.online_booking_enabled, true), 'doctors', v_doctors);
end $$;

-- A patient books their own token.
create function public.book_token(p_slug text, p_name text, p_phone text, p_doctor_id uuid, p_date date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.clinics; v_phone text; v_result jsonb;
begin
  select * into c from public.clinics where slug = lower(btrim(coalesce(p_slug, '')));
  if not found then return private.fail('not_found', 'This clinic could not be found.'); end if;

  -- Same mobile number, one booking at a time, so the per number daily cap holds even across doctors.
  v_phone := private.normalize_phone(p_phone);
  if v_phone is not null then
    perform pg_advisory_xact_lock(hashtextextended(c.id::text || ':' || v_phone, 0));
  end if;
  perform private.lock_doctor(p_doctor_id);

  v_result := private.create_token(c.id, p_doctor_id, p_name, p_phone, p_date, 'online', false);
  -- The public never sees internal token ids.
  return (v_result - 'existing_token_id') #- '{token,id}' #- '{token,patient_id}';
end $$;

-- A patient looks at their own token and where it stands.
create function public.get_my_token(p_access_key uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.queue_tokens; d public.doctors; c public.clinics; p public.patients; v_today date;
begin
  select * into t from public.queue_tokens where access_key = p_access_key;
  if not found then return private.fail('not_found', 'This token could not be found.'); end if;
  select * into d from public.doctors where id = t.doctor_id;
  select * into c from public.clinics where id = t.clinic_id;
  select * into p from public.patients where id = t.patient_id;
  v_today := private.today(t.clinic_id);

  return jsonb_build_object('ok', true,
    'clinic', jsonb_build_object('name', c.name, 'slug', c.slug, 'timezone', c.timezone),
    'now', private.clock(), 'today', v_today,
    'token', jsonb_build_object('number', t.token_number, 'status', t.status, 'date', t.queue_date, 'source', t.source,
                                'arrived_at', t.arrived_at),
    'first_name', split_part(p.name, ' ', 1),
    'doctor', jsonb_build_object('id', d.id, 'name', d.name, 'opd', d.opd_name),
    'view', private.token_view_json(t),
    'board', private.board_json(t.doctor_id, t.queue_date, v_today));
end $$;

-- A patient cancels their own token. Only a waiting token can be cancelled.
create function public.cancel_my_token(p_access_key uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.queue_tokens; v_doctor uuid;
begin
  select doctor_id into v_doctor from public.queue_tokens where access_key = p_access_key;
  if v_doctor is null then return private.fail('not_found', 'This token could not be found.'); end if;
  perform private.lock_doctor(v_doctor);
  select * into t from public.queue_tokens where access_key = p_access_key for update;
  if t.status <> 'waiting' then return private.bad_transition(t, 'cancelled'); end if;
  update public.queue_tokens set status = 'cancelled' where id = t.id returning * into t;
  perform private.sync_appointment(t);
  return jsonb_build_object('ok', true, 'token', jsonb_build_object('number', t.token_number, 'status', t.status));
end $$;

-- Live queue and waiting room display: doctors to choose from, and one doctor's queue. Token numbers only.
create function public.get_public_queue(p_slug text, p_doctor_id uuid default null, p_date date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.clinics; v_today date; v_date date; v_doctors jsonb; d public.doctors;
begin
  select * into c from public.clinics where slug = lower(btrim(coalesce(p_slug, '')));
  if not found then return private.fail('not_found', 'This clinic could not be found.'); end if;
  v_today := private.today(c.id);
  v_date := case when p_date between v_today and v_today + 1 then p_date else v_today end;

  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'opd', x.opd_name) order by x.created_at, x.id), '[]'::jsonb)
    into v_doctors from public.doctors x where x.clinic_id = c.id and x.is_active;

  select * into d from public.doctors x
    where x.clinic_id = c.id and x.is_active and x.id = p_doctor_id;
  if not found then
    select * into d from public.doctors x where x.clinic_id = c.id and x.is_active order by x.created_at, x.id limit 1;
  end if;

  return jsonb_build_object('ok', true,
    'clinic', jsonb_build_object('name', c.name, 'slug', c.slug, 'timezone', c.timezone),
    'now', private.clock(), 'today', v_today, 'date', v_date, 'doctors', v_doctors,
    'doctor', case when d.id is null then null else jsonb_build_object('id', d.id, 'name', d.name, 'opd', d.opd_name) end,
    'board', case when d.id is null then null else private.board_json(d.id, v_date, v_today) end);
end $$;
