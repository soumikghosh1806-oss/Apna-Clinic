-- Cliniq migration 8: customisable doctor schedules.
--
-- Free start and end times, several sessions a day, different timings on each weekday, breaks inside a session,
-- date specific timings, special extra sessions, leave and holidays. All times are wall clock times in the clinic's own
-- time zone (clinics.timezone); "today" and "now" are always read in that zone, never the server's or the device's.
--
-- Booking rules that follow from the schedule:
--   * online booking needs a session on that date, and for today a session that has not ended yet
--   * every token records the session it belongs to, so the queue belongs to a doctor, a date and a session
--   * changing a schedule never cancels anything. If it would leave booked patients outside the new timings, the
--     owner is warned first (code schedule_conflict) and, if they confirm, those bookings are kept as they are.
--
-- Additive: the existing weekly table keeps its rows. Nothing is dropped or reset.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Tables and columns
-- ---------------------------------------------------------------------------------------------------------------
alter table public.doctor_schedules
  add column if not exists break_start time,
  add column if not exists break_end time;
alter table public.doctor_schedules add constraint doctor_schedules_break_ok check (
  (break_start is null and break_end is null)
  or (break_start is not null and break_end is not null and break_start > start_time and break_end < end_time and break_end > break_start));

alter table public.queue_tokens
  add column if not exists session_start time,
  add column if not exists session_end time;
create index if not exists idx_queue_session on public.queue_tokens (doctor_id, queue_date, session_start);

-- Leave, holidays, one-day timings and extra sessions. doctor_id null means the whole clinic.
--   closed    no OPD from start_date to end_date (leave, holiday)
--   override  on that one date, these sessions replace the weekly ones
--   special   on that one date, these sessions are added to the weekly ones
create table public.doctor_schedule_exceptions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  doctor_id uuid references public.doctors (id) on delete cascade,
  kind text not null check (kind in ('closed', 'override', 'special')),
  start_date date not null,
  end_date date not null,
  sessions jsonb not null default '[]'::jsonb,
  reason text check (reason is null or char_length(reason) <= 120),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (end_date >= start_date and end_date - start_date <= 366),
  check (kind = 'closed' or start_date = end_date),
  check (kind = 'closed' or jsonb_array_length(sessions) >= 1),
  check (kind <> 'override' or doctor_id is not null)
);
alter table public.doctor_schedule_exceptions enable row level security;
create index idx_exceptions_clinic_date on public.doctor_schedule_exceptions (clinic_id, start_date);
create index idx_exceptions_doctor on public.doctor_schedule_exceptions (doctor_id);
create index idx_exceptions_created_by on public.doctor_schedule_exceptions (created_by);
create policy "Staff read own clinic schedule exceptions" on public.doctor_schedule_exceptions
  for select to authenticated using (private.is_clinic_member(clinic_id));
grant select on public.doctor_schedule_exceptions to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Validation helpers
-- ---------------------------------------------------------------------------------------------------------------
create function private.minutes(p text) returns integer
language sql immutable strict set search_path = '' as $$
  select (extract(hour from p::time) * 60 + extract(minute from p::time))::int
$$;

-- The first problem in a list of sessions [{start, end, break_start?, break_end?}], or null when it is fine.
create function private.sessions_problem(p jsonb, p_max integer default 6, p_min integer default 1) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_el jsonb; v_s text; v_e text; v_bs text; v_be text; v_prev_end time; r record; n integer;
  re constant text := '^([01]?[0-9]|2[0-3]):[0-5][0-9]$';
begin
  if jsonb_typeof(coalesce(p, 'null'::jsonb)) <> 'array' then return 'Add the OPD timings.'; end if;
  n := jsonb_array_length(p);
  if n < p_min then return 'Add at least one OPD timing.'; end if;
  if n > p_max then return format('Use at most %s timings in one day.', p_max); end if;
  for v_el in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(v_el) <> 'object' then return 'Each timing needs a start and an end time.'; end if;
    v_s := v_el ->> 'start'; v_e := v_el ->> 'end';
    v_bs := nullif(v_el ->> 'break_start', ''); v_be := nullif(v_el ->> 'break_end', '');
    if v_s is null or v_e is null or v_s !~ re or v_e !~ re then return 'Enter every OPD time as hours and minutes.'; end if;
    if v_e::time <= v_s::time then return 'Each OPD timing must end after it starts.'; end if;
    if (v_bs is null) <> (v_be is null) then return 'Enter both the break start and the break end, or neither.'; end if;
    if v_bs is not null then
      if v_bs !~ re or v_be !~ re then return 'Enter break times as hours and minutes.'; end if;
      if v_be::time <= v_bs::time then return 'A break must end after it starts.'; end if;
      if v_bs::time <= v_s::time or v_be::time >= v_e::time then return 'A break must fall inside the OPD timing.'; end if;
    end if;
  end loop;
  for r in select (x.el ->> 'start')::time as s_t, (x.el ->> 'end')::time as e_t
           from jsonb_array_elements(p) as x(el) order by 1 loop
    if v_prev_end is not null and r.s_t < v_prev_end then return 'OPD timings must not overlap.'; end if;
    v_prev_end := r.e_t;
  end loop;
  return null;
end $$;

-- The same sessions, tidied: sorted, times as HH:MM, empty break fields removed.
create function private.norm_sessions(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'start', to_char((x.el ->> 'start')::time, 'HH24:MI'), 'end', to_char((x.el ->> 'end')::time, 'HH24:MI'),
    'break_start', case when nullif(x.el ->> 'break_start', '') is null then null else to_char((x.el ->> 'break_start')::time, 'HH24:MI') end,
    'break_end', case when nullif(x.el ->> 'break_end', '') is null then null else to_char((x.el ->> 'break_end')::time, 'HH24:MI') end))
    order by (x.el ->> 'start')::time), '[]'::jsonb)
  from jsonb_array_elements(p) as x(el)
$$;

-- A week: an object with keys "0" (Sunday) to "6" (Saturday), each a list of sessions. A missing or empty day is closed.
create function private.weekly_problem(p jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare k text; v_err text;
  names constant text[] := array['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
begin
  if jsonb_typeof(coalesce(p, 'null'::jsonb)) <> 'object' then return 'Send the week as one list of timings for each day.'; end if;
  for k in select jsonb_object_keys(p) loop
    if k !~ '^[0-6]$' then return 'Days are numbered 0 (Sunday) to 6 (Saturday).'; end if;
    v_err := private.sessions_problem(p -> k, 6, 0);
    if v_err is not null then return names[k::int + 1] || ': ' || v_err; end if;
  end loop;
  return null;
end $$;

create function private.write_weekly(p_clinic uuid, p_doctor uuid, p_weekly jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.doctor_schedules where doctor_id = p_doctor;
  insert into public.doctor_schedules (clinic_id, doctor_id, day_of_week, start_time, end_time, break_start, break_end, is_available)
  select p_clinic, p_doctor, k.key::int, (s.el ->> 'start')::time, (s.el ->> 'end')::time,
         nullif(s.el ->> 'break_start', '')::time, nullif(s.el ->> 'break_end', '')::time, true
  from jsonb_each(p_weekly) as k(key, value), jsonb_array_elements(k.value) as s(el);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. What a doctor's day looks like: the one place the rules above are applied
-- ---------------------------------------------------------------------------------------------------------------
-- { open, reason (weekly_off | holiday | leave | doctor_unavailable), note, sessions: [{start, end, break_start?, break_end?}] }
create function private.effective_day(p_doctor uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare d public.doctors; v_closed public.doctor_schedule_exceptions; v_sessions jsonb; v_extra jsonb;
begin
  select * into d from public.doctors where id = p_doctor;
  if not found or not d.is_active then
    return jsonb_build_object('open', false, 'reason', 'doctor_unavailable', 'sessions', '[]'::jsonb);
  end if;

  select * into v_closed from public.doctor_schedule_exceptions e
    where e.clinic_id = d.clinic_id and e.kind = 'closed' and p_date between e.start_date and e.end_date
      and (e.doctor_id = d.id or e.doctor_id is null)
    order by (e.doctor_id is null), e.created_at desc limit 1;
  if found then
    return jsonb_strip_nulls(jsonb_build_object('open', false, 'reason', case when v_closed.doctor_id is null then 'holiday' else 'leave' end,
                                                'note', v_closed.reason, 'sessions', '[]'::jsonb));
  end if;

  select e.sessions into v_sessions from public.doctor_schedule_exceptions e
    where e.doctor_id = d.id and e.kind = 'override' and e.start_date = p_date order by e.created_at desc limit 1;
  if v_sessions is null then
    select coalesce(jsonb_agg(jsonb_build_object('start', s.start_time, 'end', s.end_time, 'break_start', s.break_start, 'break_end', s.break_end)), '[]'::jsonb)
      into v_sessions
    from public.doctor_schedules s
    where s.doctor_id = d.id and s.day_of_week = extract(dow from p_date)::int and s.is_available;
  end if;
  select coalesce(jsonb_agg(x.el), '[]'::jsonb) into v_extra
  from public.doctor_schedule_exceptions e, jsonb_array_elements(e.sessions) as x(el)
  where e.clinic_id = d.clinic_id and e.kind = 'special' and p_date between e.start_date and e.end_date
    and (e.doctor_id = d.id or e.doctor_id is null);

  v_sessions := private.norm_sessions(v_sessions || v_extra);
  if jsonb_array_length(v_sessions) = 0 then
    return jsonb_build_object('open', false, 'reason', 'weekly_off', 'sessions', '[]'::jsonb);
  end if;
  return jsonb_build_object('open', true, 'sessions', v_sessions);
end $$;

-- Same name and shape as before, now following the full schedule.
create or replace function private.sessions_json(p_doctor uuid, p_date date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select private.effective_day(p_doctor, p_date) -> 'sessions'
$$;

-- Public wording. The owner's free-text reason is for staff only and never appears here.
create function private.closed_message(p_doctor text, p_date date, p_day jsonb) returns text
language sql immutable set search_path = '' as $$
  select case p_day ->> 'reason'
    when 'leave' then format('%s is not available on %s.', p_doctor, to_char(p_date, 'FMDay, FMDD Mon'))
    when 'holiday' then format('The clinic is closed on %s.', to_char(p_date, 'FMDay, FMDD Mon'))
    when 'weekly_off' then format('%s has no OPD on %s.', p_doctor, to_char(p_date, 'FMDay, FMDD Mon'))
    else 'This doctor or OPD is not available.' end
$$;

-- Clock time after p_offset minutes of consulting, counting only OPD hours and skipping breaks.
create or replace function private.estimate_clock_time(p_doctor uuid, p_tz text, p_date date, p_offset integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  w record;
  v_sessions jsonb := private.sessions_json(p_doctor, p_date);
  v_local timestamp := private.clock() at time zone p_tz;
  v_cursor integer;
  v_remaining integer := greatest(0, coalesce(p_offset, 0));
  v_available integer;
begin
  v_cursor := case when p_date = v_local::date then (extract(hour from v_local) * 60 + extract(minute from v_local))::int else 0 end;
  for w in
    select win.s_min, win.e_min from (
      select private.minutes(el ->> 'start') as s_min, coalesce(private.minutes(el ->> 'break_start'), private.minutes(el ->> 'end')) as e_min
        from jsonb_array_elements(v_sessions) as el
      union all
      select private.minutes(el ->> 'break_end'), private.minutes(el ->> 'end')
        from jsonb_array_elements(v_sessions) as el where el ->> 'break_start' is not null
    ) win order by win.s_min
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

-- Whether a patient can book online with this doctor on this day, and which sessions are still bookable.
create or replace function private.availability_json(p_doctor uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  d public.doctors; s public.clinic_settings; c public.clinics; v_limit int; v_issued int;
  v_day jsonb; v_today date; v_local time; v_sessions jsonb; v_open_sessions int;
begin
  select * into d from public.doctors where id = p_doctor;
  if not found or not d.is_active then
    return jsonb_build_object('open', false, 'reason', 'doctor_unavailable', 'issued', 0, 'limit', 0, 'sessions', '[]'::jsonb);
  end if;
  select * into s from public.clinic_settings where clinic_id = d.clinic_id;
  select * into c from public.clinics where id = d.clinic_id;
  v_limit := coalesce(d.daily_token_limit, s.daily_token_limit, 100);
  select count(*) into v_issued from public.queue_tokens q
    where q.doctor_id = d.id and q.queue_date = p_date and q.status <> 'cancelled';
  v_today := private.today(d.clinic_id);
  v_local := (private.clock() at time zone c.timezone)::time;
  v_day := private.effective_day(d.id, p_date);

  select coalesce(jsonb_agg(x.el || jsonb_build_object(
      'open', (p_date > v_today or (x.el ->> 'end')::time > v_local),
      'issued', (select count(*) from public.queue_tokens q where q.doctor_id = d.id and q.queue_date = p_date
                   and q.status <> 'cancelled' and q.session_start = (x.el ->> 'start')::time)
    ) order by (x.el ->> 'start')::time), '[]'::jsonb)
    into v_sessions from jsonb_array_elements(v_day -> 'sessions') as x(el);
  select count(*) into v_open_sessions from jsonb_array_elements(v_sessions) e where (e ->> 'open')::boolean;

  if not coalesce(s.online_booking_enabled, true) then
    return jsonb_build_object('open', false, 'reason', 'online_disabled', 'issued', v_issued, 'limit', v_limit, 'sessions', v_sessions);
  end if;
  if not (v_day ->> 'open')::boolean then
    return jsonb_strip_nulls(jsonb_build_object('open', false, 'reason', 'closed', 'closed_reason', v_day ->> 'reason',
      'issued', v_issued, 'limit', v_limit, 'sessions', '[]'::jsonb));
  end if;
  if v_open_sessions = 0 then
    return jsonb_build_object('open', false, 'reason', 'ended', 'issued', v_issued, 'limit', v_limit, 'sessions', v_sessions);
  end if;
  if v_issued >= v_limit then
    return jsonb_build_object('open', false, 'reason', 'full', 'issued', v_issued, 'limit', v_limit, 'sessions', v_sessions);
  end if;
  return jsonb_build_object('open', true, 'issued', v_issued, 'limit', v_limit, 'sessions', v_sessions);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Queue boards and token views now know about sessions, breaks and closed days
-- ---------------------------------------------------------------------------------------------------------------
create or replace function private.token_json(t public.queue_tokens) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', t.id, 'number', t.token_number, 'order_key', t.order_key, 'doctor_id', t.doctor_id,
    'patient_id', t.patient_id, 'date', t.queue_date, 'source', t.source, 'status', t.status,
    'created_at', t.created_at, 'arrived_at', t.arrived_at, 'arrival_source', t.arrival_source,
    'started_at', t.started_at, 'completed_at', t.completed_at,
    'session_start', to_char(t.session_start, 'HH24:MI'), 'session_end', to_char(t.session_end, 'HH24:MI')))
$$;

create or replace function private.board_json(p_doctor uuid, p_date date, p_today date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_current int; v_total int; v_waiting int; v_done int; v_pending int; v_upcoming jsonb;
  v_code text; v_label text; v_day jsonb; v_tz text; v_local time; v_now_session jsonb; v_on_break boolean := false;
  v_name text;
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

  select c.timezone, d.name into v_tz, v_name from public.doctors d join public.clinics c on c.id = d.clinic_id where d.id = p_doctor;
  v_day := private.effective_day(p_doctor, p_date);
  v_local := (private.clock() at time zone v_tz)::time;
  if p_date = p_today then
    select s into v_now_session from jsonb_array_elements(v_day -> 'sessions') as s
      where (s ->> 'start')::time <= v_local and (s ->> 'end')::time > v_local limit 1;
    v_on_break := v_now_session is not null and v_now_session ->> 'break_start' is not null
      and (v_now_session ->> 'break_start')::time <= v_local and (v_now_session ->> 'break_end')::time > v_local;
  end if;

  if v_total = 0 and not (v_day ->> 'open')::boolean then
    v_code := 'closed'; v_label := private.closed_message(v_name, p_date, v_day);
  elsif p_date > p_today then
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
  if v_on_break and v_current is null then v_label := v_label || ' (doctor is on a short break)'; end if;

  return jsonb_build_object('status', jsonb_build_object('code', v_code, 'label', v_label),
    'current_number', v_current, 'upcoming', v_upcoming, 'waiting_count', v_waiting,
    'sessions', coalesce(v_day -> 'sessions', '[]'::jsonb), 'on_break', v_on_break, 'consulting', v_current is not null);
end $$;

create or replace function private.token_view_json(t public.queue_tokens) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  d public.doctors; s public.clinic_settings; c public.clinics;
  v_minutes int; v_serving boolean; v_before int; v_ahead int; v_wait int; v_est jsonb;
  v_front int; v_finished int; v_progress numeric; v_floor timestamptz;
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
    -- Nobody is seen before their own session starts.
    if t.session_start is not null then
      v_floor := (t.queue_date + t.session_start) at time zone c.timezone;
      if (v_est ->> 'at')::timestamptz < v_floor then v_est := jsonb_set(v_est, '{at}', to_jsonb(v_floor)); end if;
    end if;
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
-- 5. Creating a token: the schedule decides when and where
-- ---------------------------------------------------------------------------------------------------------------
drop function private.create_token(uuid, uuid, text, text, date, text, boolean);
create function private.create_token(p_clinic uuid, p_doctor uuid, p_name text, p_phone text, p_date date,
                                     p_source text, p_allow_over boolean, p_session_start text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := private.today(p_clinic);
  v_errors jsonb := private.contact_errors(p_name, p_phone);
  v_name text; v_phone text; v_tz text;
  d public.doctors; s public.clinic_settings;
  v_limit int; v_issued int; v_patient uuid; v_dup public.queue_tokens; v_count int;
  v_number int; v_order int; v_appt uuid; t public.queue_tokens; v_now timestamptz := private.clock();
  v_day jsonb; v_local time; v_sess jsonb; v_sess_start time; v_sess_end time;
begin
  if v_errors <> '{}'::jsonb then
    return private.fail('invalid_input', 'Please fix the highlighted fields.', jsonb_build_object('field_errors', v_errors));
  end if;
  if p_session_start is not null and p_session_start !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
    return private.fail('invalid_input', 'Choose one of the doctor''s sessions.', jsonb_build_object('field_errors', jsonb_build_object('session', 'Choose a session.')));
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

  -- The schedule: is there OPD that day, and which session does this token belong to?
  v_day := private.effective_day(d.id, p_date);
  v_local := (v_now at time zone v_tz)::time;
  if not (v_day ->> 'open')::boolean then
    return private.fail('doctor_unavailable', private.closed_message(d.name, p_date, v_day));
  end if;
  if p_session_start is not null then
    select x into v_sess from jsonb_array_elements(v_day -> 'sessions') as x
      where (x ->> 'start')::time = p_session_start::time limit 1;
    if v_sess is null then
      return private.fail('invalid_input', 'Choose one of the doctor''s sessions for this day.',
        jsonb_build_object('field_errors', jsonb_build_object('session', 'That session is not on this doctor''s timetable for this day.')));
    end if;
    if p_source = 'online' and p_date = v_today and (v_sess ->> 'end')::time <= v_local then
      return private.fail('doctor_unavailable', 'That session has already ended. Choose a later session.');
    end if;
  elsif p_source = 'online' then
    select x into v_sess from jsonb_array_elements(v_day -> 'sessions') as x
      where p_date > v_today or (x ->> 'end')::time > v_local order by (x ->> 'start')::time limit 1;
    if v_sess is null then
      return private.fail('doctor_unavailable', format('OPD for today is over for %s. You can book for tomorrow.', d.name));
    end if;
  else
    -- A walk-in joins the session in progress, or the next one, or the last one of the day.
    select x into v_sess from jsonb_array_elements(v_day -> 'sessions') as x
      order by case when (x ->> 'start')::time <= v_local and (x ->> 'end')::time > v_local then 0
                    when (x ->> 'start')::time > v_local then 1 else 2 end,
               case when (x ->> 'start')::time > v_local then (x ->> 'start')::time end asc nulls last,
               (x ->> 'end')::time desc limit 1;
  end if;
  v_sess_start := (v_sess ->> 'start')::time;
  v_sess_end := (v_sess ->> 'end')::time;

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

  -- Token numbers run through the whole day and are never reused, even after a cancellation. Calling order follows the
  -- session first (earlier sessions are called before later ones), then the order of booking.
  select coalesce(max(q.token_number), 0) + 1 into v_number
    from public.queue_tokens q where q.doctor_id = d.id and q.queue_date = p_date;
  select coalesce(max(q.order_key), private.minutes(to_char(v_sess_start, 'HH24:MI')) * 1000) + 1 into v_order
    from public.queue_tokens q where q.doctor_id = d.id and q.queue_date = p_date and q.session_start = v_sess_start;

  insert into public.appointments (clinic_id, patient_id, doctor_id, appointment_date, appointment_time, booking_source, status, created_at)
  values (p_clinic, v_patient, d.id, p_date, v_sess_start, p_source, 'booked', v_now)
  returning id into v_appt;

  insert into public.queue_tokens (clinic_id, patient_id, doctor_id, appointment_id, token_number, queue_date, status,
                                   order_key, source, arrived_at, arrival_source, created_at, session_start, session_end)
  values (p_clinic, v_patient, d.id, v_appt, v_number, p_date, 'waiting', v_order, p_source,
          case when p_source = 'walk_in' then v_now end, case when p_source = 'walk_in' then 'walk_in' end, v_now,
          v_sess_start, v_sess_end)
  returning * into t;

  return jsonb_build_object('ok', true, 'token', private.token_json(t), 'access_key', t.access_key);
end $$;

-- The booking functions keep working with their old arguments. The new session argument is optional.
drop function public.book_token(text, text, text, uuid, date);
create function public.book_token(p_slug text, p_name text, p_phone text, p_doctor_id uuid, p_date date,
                                  p_session_start text default null) returns jsonb
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

  v_result := private.create_token(c.id, p_doctor_id, p_name, p_phone, p_date, 'online', false, p_session_start);
  -- The public never sees internal token ids.
  return (v_result - 'existing_token_id') #- '{token,id}' #- '{token,patient_id}';
end $$;

create or replace function public.add_walk_in(p_clinic uuid, p_name text, p_phone text, p_doctor_id uuid,
                                              p_allow_over_limit boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(private.member_role(p_clinic), '') not in ('owner', 'receptionist') then return private.forbidden(); end if;
  perform private.lock_doctor(p_doctor_id);
  return private.create_token(p_clinic, p_doctor_id, p_name, p_phone, private.today(p_clinic), 'walk_in', p_allow_over_limit, null);
end $$;

-- Booking page: the clinic, its doctors, and for today and tomorrow which sessions can be booked.
create or replace function public.get_public_clinic(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.clinics; s public.clinic_settings; v_today date; v_doctors jsonb;
begin
  select * into c from public.clinics where slug = lower(btrim(coalesce(p_slug, '')));
  if not found then return private.fail('not_found', 'This clinic could not be found.'); end if;
  select * into s from public.clinic_settings where clinic_id = c.id;
  v_today := private.today(c.id);

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'id', d.id, 'name', d.name, 'opd', d.opd_name, 'specialization', d.specialization,
      'sessions', private.sessions_json(d.id, v_today),
      'daily_limit', coalesce(d.daily_token_limit, s.daily_token_limit, 100),
      'minutes_per_patient', coalesce(d.minutes_per_patient, s.average_consultation_minutes, 10),
      'availability', jsonb_build_object('today', private.availability_json(d.id, v_today),
                                         'tomorrow', private.availability_json(d.id, v_today + 1))))
    order by d.created_at, d.id), '[]'::jsonb) into v_doctors
  from public.doctors d where d.clinic_id = c.id and d.is_active;

  return jsonb_build_object('ok', true,
    'clinic', jsonb_build_object('name', c.name, 'slug', c.slug, 'timezone', c.timezone),
    'now', private.clock(), 'today', v_today, 'tomorrow', v_today + 1,
    'online_booking_enabled', coalesce(s.online_booking_enabled, true), 'doctors', v_doctors);
end $$;

create or replace function public.get_my_token(p_access_key uuid) returns jsonb
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
    'token', jsonb_strip_nulls(jsonb_build_object('number', t.token_number, 'status', t.status, 'date', t.queue_date, 'source', t.source,
                                'arrived_at', t.arrived_at, 'session_start', to_char(t.session_start, 'HH24:MI'),
                                'session_end', to_char(t.session_end, 'HH24:MI'))),
    'first_name', split_part(p.name, ' ', 1),
    'doctor', jsonb_strip_nulls(jsonb_build_object('id', d.id, 'name', d.name, 'opd', d.opd_name, 'specialization', d.specialization)),
    'view', private.token_view_json(t),
    'board', private.board_json(t.doctor_id, t.queue_date, v_today));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Queue order within a session (requeue and resume stay inside their own session)
-- ---------------------------------------------------------------------------------------------------------------
create or replace function private.act_on_token(p_token uuid, p_action text) returns jsonb
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
      where q.doctor_id = t.doctor_id and q.queue_date = t.queue_date and q.session_start is not distinct from t.session_start;
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
      where q.doctor_id = t.doctor_id and q.queue_date = t.queue_date and q.session_start is not distinct from t.session_start;
    update public.queue_tokens set status = 'waiting', order_key = v_key - 1 where id = t.id returning * into t;
  end if;

  perform private.sync_appointment(t);
  return jsonb_build_object('ok', true, 'token', private.token_json(t));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 7. Changing a schedule: warn first, never cancel
-- ---------------------------------------------------------------------------------------------------------------
-- Open tokens (today onwards) that the doctor's CURRENT schedule no longer covers. A token is covered when its session
-- fits inside one of the day's sessions, so extending or shifting a session never triggers a warning.
create function private.schedule_conflicts(p_doctor uuid, p_from date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r record; v_day jsonb; v_out jsonb := '[]'::jsonb; v_name text;
begin
  select name into v_name from public.doctors where id = p_doctor;
  for r in
    select q.queue_date, q.session_start, q.session_end, count(*)::int as n
    from public.queue_tokens q
    where q.doctor_id = p_doctor and q.queue_date >= p_from and q.status in ('waiting', 'arrived', 'serving', 'on_hold', 'skipped')
    group by 1, 2, 3 order by 1, 2
  loop
    v_day := private.effective_day(p_doctor, r.queue_date);
    if not (v_day ->> 'open')::boolean then
      v_out := v_out || jsonb_strip_nulls(jsonb_build_object('doctor_id', p_doctor, 'doctor', v_name, 'date', r.queue_date, 'tokens', r.n,
        'reason', 'closed', 'closed_reason', v_day ->> 'reason',
        'session', case when r.session_start is null then null else jsonb_build_object('start', to_char(r.session_start, 'HH24:MI'), 'end', to_char(r.session_end, 'HH24:MI')) end));
    elsif r.session_start is not null and not exists (
        select 1 from jsonb_array_elements(v_day -> 'sessions') as s
        where (s ->> 'start')::time <= r.session_start and (s ->> 'end')::time >= r.session_end) then
      v_out := v_out || jsonb_build_object('doctor_id', p_doctor, 'doctor', v_name, 'date', r.queue_date, 'tokens', r.n,
        'reason', 'session_changed', 'session', jsonb_build_object('start', to_char(r.session_start, 'HH24:MI'), 'end', to_char(r.session_end, 'HH24:MI')));
    end if;
  end loop;
  return v_out;
end $$;

create function private.conflict_message(p_conflicts jsonb) returns text
language sql immutable set search_path = '' as $$
  select format('This change affects %s booked patient%s. Their bookings will NOT be cancelled: they stay in the queue exactly as booked. Continue only if that is what you want.',
    coalesce(sum((c ->> 'tokens')::int), 0), case when coalesce(sum((c ->> 'tokens')::int), 0) = 1 then '' else 's' end)
  from jsonb_array_elements(p_conflicts) c
$$;

-- Only the bookings THIS change strands are reported. A booking an earlier, confirmed change already left outside the
-- timetable does not warn again every time the owner edits something else.
create function private.new_conflicts(p_before jsonb, p_after jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(a.el), '[]'::jsonb)
  from jsonb_array_elements(p_after) as a(el)
  where not exists (
    select 1 from jsonb_array_elements(p_before) as b(el)
    where b.el ->> 'doctor_id' = a.el ->> 'doctor_id' and b.el ->> 'date' = a.el ->> 'date'
      and coalesce(b.el #>> '{session,start}', '') = coalesce(a.el #>> '{session,start}', ''))
$$;

create function public.get_doctor_schedule(p_clinic uuid, p_doctor_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare d public.doctors; c public.clinics; v_today date; v_weekly jsonb := '{}'::jsonb; v_exceptions jsonb; k int;
begin
  if private.member_role(p_clinic) is null then return private.forbidden('You do not have access to this clinic.'); end if;
  select * into d from public.doctors where id = p_doctor_id and clinic_id = p_clinic;
  if not found then return private.fail('not_found', 'This doctor could not be found.'); end if;
  select * into c from public.clinics where id = p_clinic;
  v_today := private.today(p_clinic);
  for k in 0..6 loop
    v_weekly := v_weekly || jsonb_build_object(k::text, coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'),
        'break_start', to_char(s.break_start, 'HH24:MI'), 'break_end', to_char(s.break_end, 'HH24:MI'))) order by s.start_time)
      from public.doctor_schedules s where s.doctor_id = d.id and s.day_of_week = k and s.is_available), '[]'::jsonb));
  end loop;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', e.id, 'kind', e.kind, 'start_date', e.start_date, 'end_date', e.end_date,
           'sessions', e.sessions, 'reason', e.reason, 'clinic_wide', e.doctor_id is null)) order by e.start_date, e.created_at), '[]'::jsonb)
    into v_exceptions
  from public.doctor_schedule_exceptions e
  where e.clinic_id = p_clinic and (e.doctor_id = d.id or e.doctor_id is null) and e.end_date >= v_today;
  return jsonb_build_object('ok', true, 'doctor', jsonb_build_object('id', d.id, 'name', d.name, 'opd', d.opd_name),
    'timezone', c.timezone, 'today', v_today, 'weekly', v_weekly, 'exceptions', v_exceptions);
end $$;

-- Applies a new week. With bookings that no longer fit, answers schedule_conflict and changes nothing, unless confirmed.
create function private.apply_weekly(p_clinic uuid, p_doctor uuid, p_weekly jsonb, p_confirm boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_conf jsonb := '[]'::jsonb; v_week jsonb; v_before jsonb; v_today date := private.today(p_clinic);
begin
  select coalesce(jsonb_object_agg(k.key, private.norm_sessions(k.value)), '{}'::jsonb) into v_week from jsonb_each(p_weekly) k;
  v_before := private.schedule_conflicts(p_doctor, v_today);
  begin
    perform private.write_weekly(p_clinic, p_doctor, v_week);
    v_conf := private.new_conflicts(v_before, private.schedule_conflicts(p_doctor, v_today));
    if jsonb_array_length(v_conf) > 0 and not coalesce(p_confirm, false) then
      raise exception 'schedule_conflict' using errcode = 'P0900';
    end if;
  exception when sqlstate 'P0900' then
    -- everything written inside this block is undone
    return private.fail('schedule_conflict', private.conflict_message(v_conf), jsonb_build_object('conflicts', v_conf));
  end;
  return jsonb_build_object('ok', true, 'kept', v_conf);
end $$;

create function public.set_weekly_schedule(p_clinic uuid, p_doctor_id uuid, p_weekly jsonb, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.doctors; v_err text; v_result jsonb;
begin
  if private.member_role(p_clinic) is distinct from 'owner' then return private.forbidden(); end if;
  select * into d from public.doctors where id = p_doctor_id and clinic_id = p_clinic and is_active;
  if not found then return private.fail('not_found', 'This doctor could not be found.'); end if;
  v_err := private.weekly_problem(p_weekly);
  if v_err is not null then
    return private.fail('invalid_input', v_err, jsonb_build_object('field_errors', jsonb_build_object('weekly', v_err)));
  end if;
  perform private.lock_doctor(d.id);
  v_result := private.apply_weekly(p_clinic, d.id, p_weekly, p_confirm);
  if (v_result ->> 'ok')::boolean then
    perform private.audit(p_clinic, 'schedule.update', 'doctor', d.id, jsonb_build_object('bookings_kept', jsonb_array_length(v_result -> 'kept')));
  end if;
  return v_result;
end $$;

-- Leave, a clinic holiday, one day's different timings, or an extra session. p_doctor_id null means the whole clinic.
create function public.add_schedule_exception(p_clinic uuid, p_doctor_id uuid, p_kind text, p_start date, p_end date,
                                              p_sessions jsonb default '[]'::jsonb, p_reason text default null,
                                              p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date; v_err text; v_end date; v_id uuid; v_conf jsonb := '[]'::jsonb; dr record; v_sessions jsonb := '[]'::jsonb;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_problem text; v_before jsonb := '[]'::jsonb; v_after jsonb := '[]'::jsonb;
begin
  if private.member_role(p_clinic) is distinct from 'owner' then return private.forbidden(); end if;
  v_today := private.today(p_clinic);
  if p_kind not in ('closed', 'override', 'special') then return private.fail('invalid_input', 'Choose leave, one day timings or an extra session.'); end if;
  if p_start is null then return private.fail('invalid_input', 'Choose a date.', jsonb_build_object('field_errors', jsonb_build_object('date', 'Choose a date.'))); end if;
  v_end := case when p_kind = 'closed' then coalesce(p_end, p_start) else p_start end;
  if v_end < p_start then
    return private.fail('invalid_input', 'The last day cannot be before the first day.', jsonb_build_object('field_errors', jsonb_build_object('date', 'The last day cannot be before the first day.')));
  end if;
  if v_end < v_today then
    return private.fail('invalid_input', 'Choose today or a later date.', jsonb_build_object('field_errors', jsonb_build_object('date', 'Choose today or a later date.')));
  end if;
  if v_end - p_start > 366 then return private.fail('invalid_input', 'Leave can last at most one year.'); end if;
  if v_reason is not null and char_length(v_reason) > 120 then
    return private.fail('invalid_input', 'The note can have at most 120 characters.', jsonb_build_object('field_errors', jsonb_build_object('reason', 'At most 120 characters.')));
  end if;
  if p_kind = 'override' and p_doctor_id is null then return private.fail('invalid_input', 'Choose a doctor for one day timings.'); end if;
  if p_doctor_id is not null and not exists (select 1 from public.doctors where id = p_doctor_id and clinic_id = p_clinic and is_active) then
    return private.fail('not_found', 'This doctor could not be found.');
  end if;
  if p_kind <> 'closed' then
    v_err := private.sessions_problem(p_sessions, 6, 1);
    if v_err is not null then
      return private.fail('invalid_input', v_err, jsonb_build_object('field_errors', jsonb_build_object('sessions', v_err)));
    end if;
    v_sessions := private.norm_sessions(p_sessions);
  end if;

  for dr in select id from public.doctors where clinic_id = p_clinic and is_active and (p_doctor_id is null or id = p_doctor_id) order by id loop
    perform private.lock_doctor(dr.id);
  end loop;

  for dr in select id from public.doctors where clinic_id = p_clinic and is_active and (p_doctor_id is null or id = p_doctor_id) loop
    v_before := v_before || private.schedule_conflicts(dr.id, v_today);
  end loop;

  begin
    insert into public.doctor_schedule_exceptions (clinic_id, doctor_id, kind, start_date, end_date, sessions, reason, created_by)
      values (p_clinic, p_doctor_id, p_kind, p_start, v_end, v_sessions, v_reason, (select auth.uid())) returning id into v_id;
    -- An extra session must not overlap the timings it is added to.
    if p_kind in ('special', 'override') then
      for dr in select id from public.doctors where clinic_id = p_clinic and is_active and (p_doctor_id is null or id = p_doctor_id) loop
        v_problem := private.sessions_problem(private.effective_day(dr.id, p_start) -> 'sessions', 12, 0);
        if v_problem is not null then
          raise exception 'overlap' using errcode = 'P0901';
        end if;
      end loop;
    end if;
    for dr in select id from public.doctors where clinic_id = p_clinic and is_active and (p_doctor_id is null or id = p_doctor_id) loop
      v_after := v_after || private.schedule_conflicts(dr.id, v_today);
    end loop;
    v_conf := private.new_conflicts(v_before, v_after);
    if jsonb_array_length(v_conf) > 0 and not coalesce(p_confirm, false) then
      raise exception 'schedule_conflict' using errcode = 'P0900';
    end if;
  exception
    when sqlstate 'P0901' then
      return private.fail('invalid_input', 'These timings overlap the regular timings of that day. Change the times so they do not overlap.',
        jsonb_build_object('field_errors', jsonb_build_object('sessions', 'These timings overlap the regular timings of that day.')));
    when sqlstate 'P0900' then
      return private.fail('schedule_conflict', private.conflict_message(v_conf), jsonb_build_object('conflicts', v_conf));
  end;
  perform private.audit(p_clinic, 'schedule.exception_add', 'doctor', p_doctor_id,
    jsonb_build_object('kind', p_kind, 'from', p_start, 'to', v_end, 'bookings_kept', jsonb_array_length(v_conf)));
  return jsonb_build_object('ok', true, 'id', v_id, 'kept', v_conf);
end $$;

create function public.remove_schedule_exception(p_clinic uuid, p_exception uuid, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e public.doctor_schedule_exceptions; v_conf jsonb := '[]'::jsonb; v_before jsonb := '[]'::jsonb; v_after jsonb := '[]'::jsonb;
  dr record; v_today date;
begin
  if private.member_role(p_clinic) is distinct from 'owner' then return private.forbidden(); end if;
  select * into e from public.doctor_schedule_exceptions where id = p_exception and clinic_id = p_clinic;
  if not found then return private.fail('not_found', 'This entry could not be found.'); end if;
  v_today := private.today(p_clinic);
  for dr in select id from public.doctors where clinic_id = p_clinic and is_active and (e.doctor_id is null or id = e.doctor_id) order by id loop
    perform private.lock_doctor(dr.id);
    v_before := v_before || private.schedule_conflicts(dr.id, v_today);
  end loop;
  begin
    delete from public.doctor_schedule_exceptions where id = e.id;
    for dr in select id from public.doctors where clinic_id = p_clinic and is_active and (e.doctor_id is null or id = e.doctor_id) loop
      v_after := v_after || private.schedule_conflicts(dr.id, v_today);
    end loop;
    v_conf := private.new_conflicts(v_before, v_after);
    if jsonb_array_length(v_conf) > 0 and not coalesce(p_confirm, false) then raise exception 'schedule_conflict' using errcode = 'P0900'; end if;
  exception when sqlstate 'P0900' then
    return private.fail('schedule_conflict', private.conflict_message(v_conf), jsonb_build_object('conflicts', v_conf));
  end;
  perform private.audit(p_clinic, 'schedule.exception_remove', 'doctor', e.doctor_id, jsonb_build_object('kind', e.kind, 'from', e.start_date));
  return jsonb_build_object('ok', true, 'kept', v_conf);
end $$;

-- Editing a doctor no longer has to touch the schedule. A null p_sessions leaves the weekly timings exactly as they are;
-- a list still sets the same timings on every day, but now with the same warning before it affects booked patients.
create or replace function public.update_doctor(p_clinic uuid, p_doctor_id uuid, p_name text, p_opd text, p_sessions jsonb,
                                                p_daily_limit integer default null, p_minutes_per_patient integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_errors jsonb; d public.doctors; v_apply jsonb;
begin
  if private.member_role(p_clinic) is distinct from 'owner' then return private.forbidden(); end if;
  select * into d from public.doctors where id = p_doctor_id and clinic_id = p_clinic and is_active for update;
  if not found then return private.fail('not_found', 'This doctor could not be found.'); end if;
  v_errors := private.doctor_errors(p_name, p_opd, coalesce(p_sessions, '[{"start":"09:00","end":"10:00"}]'::jsonb), p_daily_limit, p_minutes_per_patient);
  if v_errors <> '{}'::jsonb then
    return private.fail('invalid_input', 'Please fix the highlighted fields.', jsonb_build_object('field_errors', v_errors));
  end if;
  if p_sessions is not null then
    perform private.lock_doctor(d.id);
    v_apply := private.apply_weekly(p_clinic, d.id,
      (select jsonb_object_agg(g.dow::text, p_sessions) from generate_series(0, 6) as g(dow)), false);
    if not (v_apply ->> 'ok')::boolean then return v_apply; end if;
  end if;
  update public.doctors set name = private.clean_name(p_name), opd_name = btrim(p_opd), daily_token_limit = p_daily_limit,
    minutes_per_patient = p_minutes_per_patient where id = d.id returning * into d;
  perform private.audit(p_clinic, 'doctor.update', 'doctor', d.id);
  return jsonb_build_object('ok', true, 'doctor', private.doctor_json(d, private.today(p_clinic)));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 8. Who may call what
-- ---------------------------------------------------------------------------------------------------------------
revoke execute on function private.minutes(text), private.sessions_problem(jsonb, integer, integer), private.norm_sessions(jsonb),
  private.weekly_problem(jsonb), private.write_weekly(uuid, uuid, jsonb), private.effective_day(uuid, date),
  private.closed_message(text, date, jsonb), private.schedule_conflicts(uuid, date), private.conflict_message(jsonb),
  private.apply_weekly(uuid, uuid, jsonb, boolean), private.new_conflicts(jsonb, jsonb), private.create_token(uuid, uuid, text, text, date, text, boolean, text)
  from public, anon, authenticated;
revoke execute on function public.get_doctor_schedule(uuid, uuid), public.set_weekly_schedule(uuid, uuid, jsonb, boolean),
  public.add_schedule_exception(uuid, uuid, text, date, date, jsonb, text, boolean),
  public.remove_schedule_exception(uuid, uuid, boolean), public.book_token(text, text, text, uuid, date, text) from public, anon, authenticated;
grant execute on function public.get_doctor_schedule(uuid, uuid), public.set_weekly_schedule(uuid, uuid, jsonb, boolean),
  public.add_schedule_exception(uuid, uuid, text, date, date, jsonb, text, boolean),
  public.remove_schedule_exception(uuid, uuid, boolean) to authenticated;
grant execute on function public.book_token(text, text, text, uuid, date, text) to anon, authenticated;
