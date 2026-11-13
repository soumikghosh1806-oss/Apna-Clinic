-- Cliniq migration 9: public clinic directory, phone verification (OTP) and live queue by clinic and doctor.
--
-- Additive. Nothing is dropped except the previous signature of book_token, which is replaced by one that takes the same
-- arguments plus optional ones (a verification and an email), so every existing call keeps working.
--
-- Privacy rules this migration keeps:
--   * A clinic appears in the directory only when its owner switched "list my clinic publicly" on, and only its name,
--     location, a public phone number the owner chose, its doctors and their queue numbers are shown.
--   * Nothing public carries a patient name, phone number, email, medical detail or access key.
--   * One time codes are never stored. Only a keyed hash is, and it is compared by the database.
--   * Signed in staff can no longer read the secret access key of a token (it is the patient's private link).

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------------------------------------------
alter table public.clinics
  add column if not exists public_listing boolean not null default false,
  add column if not exists public_phone text;
alter table public.clinics add constraint clinics_public_phone_format
  check (public_phone is null or public_phone ~ '^\+?[0-9][0-9 ()-]{6,18}[0-9]$');
-- NOT VALID: applies to new and changed rows only, so rows that exist already are never rejected.
alter table public.clinics add constraint clinics_public_text_length
  check ((address is null or char_length(address) <= 160) and (city is null or char_length(city) <= 60)) not valid;
create index if not exists idx_clinics_public on public.clinics (name) where public_listing;

alter table public.clinic_settings add column if not exists require_phone_otp boolean not null default false;

alter table public.patients add column if not exists email text;
alter table public.patients add constraint patients_email_format
  check (email is null or (char_length(email) <= 254 and email ~ '^[^[:space:]@]{1,64}@[^[:space:]@]{1,190}\.[^[:space:]@]{2,}$'));

-- ---------------------------------------------------------------------------------------------------------------
-- 2. One time codes
-- ---------------------------------------------------------------------------------------------------------------
create table public.booking_verifications (
  id uuid primary key default gen_random_uuid(),
  phone text not null check (phone ~ '^[6-9][0-9]{9}$'),
  channel text not null check (channel in ('sms', 'email')),
  code_hash text,
  ip_hash text,
  target_hash text,
  attempts integer not null default 0,
  uses integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  verified_at timestamptz
);
alter table public.booking_verifications enable row level security;   -- no policies and no grants: only the functions below touch it
create index idx_verifications_phone on public.booking_verifications (phone, created_at);
create index idx_verifications_ip on public.booking_verifications (ip_hash, created_at) where ip_hash is not null;
create index idx_verifications_target on public.booking_verifications (target_hash, created_at) where target_hash is not null;

create function private.email_error(p text) returns text
language sql immutable set search_path = '' as $$
  select case when p is null or btrim(p) = '' then null
              when char_length(btrim(p)) > 254 or btrim(p) !~ '^[^[:space:]@]{1,64}@[^[:space:]@]{1,190}\.[^[:space:]@]{2,}$'
                then 'Enter a valid email address, or leave it empty.'
              else null end
$$;

-- Starts a challenge for a phone number. The Edge Function makes the code, hashes it, and sends it.
create function public.otp_begin(p_phone text, p_channel text, p_ip_hash text default null, p_target_hash text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_phone text := private.normalize_phone(p_phone); v_now timestamptz := private.clock(); v_id uuid;
begin
  if v_phone is null then
    return private.fail('invalid_input', 'Enter a valid 10 digit mobile number that starts with 6, 7, 8 or 9.',
      jsonb_build_object('field_errors', jsonb_build_object('phone', 'Enter a valid 10 digit mobile number.')));
  end if;
  if p_channel not in ('sms', 'email') then return private.fail('invalid_input', 'Choose how to receive the code.'); end if;

  delete from public.booking_verifications where created_at < v_now - interval '2 days';

  if (select count(*) from public.booking_verifications where phone = v_phone and created_at > v_now - interval '10 minutes') >= 3
     or (select count(*) from public.booking_verifications where phone = v_phone and created_at > v_now - interval '1 day') >= 10 then
    return private.fail('rate_limited', 'Too many codes were requested for this number. Please wait about 10 minutes and try again.');
  end if;
  if p_ip_hash is not null and (select count(*) from public.booking_verifications where ip_hash = p_ip_hash and created_at > v_now - interval '1 hour') >= 20 then
    return private.fail('rate_limited', 'Too many codes were requested from this connection. Please try again later.');
  end if;

  -- The address a code is sent to (hashed by the caller) is limited too, so nobody's inbox can be flooded with codes.
  if p_target_hash is not null and (select count(*) from public.booking_verifications where target_hash = p_target_hash and created_at > v_now - interval '1 hour') >= 5 then
    return private.fail('rate_limited', 'Too many codes were sent to this address. Please try again in about an hour.');
  end if;

  -- created_at comes from the same clock as every check above, never from a column default.
  insert into public.booking_verifications (phone, channel, ip_hash, target_hash, created_at, expires_at)
  values (v_phone, p_channel, p_ip_hash, p_target_hash, v_now, v_now + interval '10 minutes') returning id into v_id;
  return jsonb_build_object('ok', true, 'challenge_id', v_id, 'phone', v_phone);
end $$;

create function public.otp_set_hash(p_challenge uuid, p_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  update public.booking_verifications set code_hash = p_hash where id = p_challenge and code_hash is null and verified_at is null;
  if not found then return private.fail('not_found', 'This verification could not be found.'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- A code that could not be sent must not count against the person's limit or stay valid.
create function public.otp_cancel(p_challenge uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.booking_verifications where id = p_challenge and verified_at is null;
  return jsonb_build_object('ok', true);
end $$;

-- Compares the hash of what the person typed with the stored one. At most 5 tries per code.
create function public.otp_check(p_challenge uuid, p_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.booking_verifications; v_now timestamptz := private.clock();
begin
  select * into v from public.booking_verifications where id = p_challenge for update;
  if not found or v.code_hash is null or v.expires_at < v_now or v.attempts >= 5 then
    return private.fail('otp_expired', 'This code has expired or was used too many times. Request a new code.');
  end if;
  if v.verified_at is not null then return jsonb_build_object('ok', true, 'challenge_id', v.id, 'phone', v.phone, 'channel', v.channel); end if;
  update public.booking_verifications set attempts = attempts + 1 where id = v.id;
  if v.code_hash <> p_hash then
    return private.fail('otp_invalid', format('That code is not correct. You have %s %s left.', 4 - v.attempts, case when 4 - v.attempts = 1 then 'try' else 'tries' end),
      jsonb_build_object('field_errors', jsonb_build_object('code', 'That code is not correct.'), 'attempts_left', 4 - v.attempts));
  end if;
  update public.booking_verifications set verified_at = v_now, expires_at = v_now + interval '30 minutes' where id = v.id;
  return jsonb_build_object('ok', true, 'challenge_id', v.id, 'phone', v.phone, 'channel', v.channel);
end $$;

-- A verification is good for 30 minutes after the code was entered, for the same phone number only.
create function private.verified_phone(p_verification uuid, p_sms_only boolean default false) returns text
language sql stable security definer set search_path = '' as $$
  select v.phone from public.booking_verifications v
  where v.id = p_verification and v.verified_at is not null and v.expires_at >= private.clock()
    and (not p_sms_only or v.channel = 'sms')
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Booking: optional phone verification, optional email
-- ---------------------------------------------------------------------------------------------------------------
drop function public.book_token(text, text, text, uuid, date, text);
create function public.book_token(p_slug text, p_name text, p_phone text, p_doctor_id uuid, p_date date,
                                  p_session_start text default null, p_verification uuid default null,
                                  p_email text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.clinics; s public.clinic_settings; v_phone text; v_result jsonb; v_verified text; v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_use int;
begin
  select * into c from public.clinics where slug = lower(btrim(coalesce(p_slug, '')));
  if not found then return private.fail('not_found', 'This clinic could not be found.'); end if;
  select * into s from public.clinic_settings where clinic_id = c.id;

  if private.email_error(v_email) is not null then
    return private.fail('invalid_input', 'Please fix the highlighted fields.', jsonb_build_object('field_errors', jsonb_build_object('email', private.email_error(v_email))));
  end if;

  v_phone := private.normalize_phone(p_phone);
  -- Phone verification: required when the clinic asks for it, and checked whenever one is supplied.
  if coalesce(s.require_phone_otp, false) or p_verification is not null then
    v_verified := private.verified_phone(p_verification);
    if v_verified is null then
      return private.fail(case when p_verification is null then 'otp_required' else 'otp_expired' end,
        case when p_verification is null then 'Please verify your mobile number with the code we send you before booking.'
             else 'Your phone verification has expired. Please verify your number again.' end);
    end if;
    if v_phone is distinct from v_verified then
      return private.fail('otp_invalid', 'This verification was for a different mobile number.',
        jsonb_build_object('field_errors', jsonb_build_object('phone', 'Verify this number, or use the number you verified.')));
    end if;
  end if;

  -- Same mobile number, one booking at a time, so the per number daily cap holds even across doctors.
  if v_phone is not null then
    perform pg_advisory_xact_lock(hashtextextended(c.id::text || ':' || v_phone, 0));
  end if;
  perform private.lock_doctor(p_doctor_id);

  if p_verification is not null then
    -- A verification covers a family's bookings from one phone, but not an unlimited number of them.
    select uses into v_use from public.booking_verifications where id = p_verification for update;
    if v_use >= 4 then
      return private.fail('otp_expired', 'This verification has been used for the most bookings it allows. Please verify your number again.');
    end if;
  end if;

  v_result := private.create_token(c.id, p_doctor_id, p_name, p_phone, p_date, 'online', false, p_session_start);

  if coalesce((v_result ->> 'ok')::boolean, false) then
    if p_verification is not null then update public.booking_verifications set uses = uses + 1 where id = p_verification; end if;
    if v_email is not null then
      update public.patients set email = v_email, updated_at = private.clock() where id = (v_result #>> '{token,patient_id}')::uuid;
    end if;
  end if;
  -- The public never sees internal token ids.
  return (v_result - 'existing_token_id') #- '{token,id}' #- '{token,patient_id}';
end $$;

-- What an email about a booking may say, looked up by the patient's own secret key. Service only.
create function public.booking_email_context(p_access_key uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.queue_tokens; p public.patients; d public.doctors; c public.clinics;
begin
  select * into t from public.queue_tokens where access_key = p_access_key;
  if not found then return private.fail('not_found', 'This token could not be found.'); end if;
  select * into p from public.patients where id = t.patient_id;
  select * into d from public.doctors where id = t.doctor_id;
  select * into c from public.clinics where id = t.clinic_id;
  return jsonb_build_object('ok', true, 'email', p.email, 'first_name', split_part(p.name, ' ', 1), 'clinic_id', c.id, 'clinic_name', c.name,
    'clinic_slug', c.slug, 'doctor', d.name, 'opd', d.opd_name, 'date', t.queue_date, 'today', private.today(c.id), 'number', t.token_number, 'status', t.status,
    'session_start', to_char(t.session_start, 'HH24:MI'), 'session_end', to_char(t.session_end, 'HH24:MI'));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Public queue by clinic and doctor, and a patient's own place after phone verification
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.get_public_queue(p_slug text, p_doctor_id uuid default null, p_date date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c public.clinics; s public.clinic_settings; v_today date; v_date date; v_doctors jsonb; d public.doctors;
  v_board jsonb; v_av jsonb; v_mpp int; v_wait int;
begin
  select * into c from public.clinics where slug = lower(btrim(coalesce(p_slug, '')));
  if not found then return private.fail('not_found', 'This clinic could not be found.'); end if;
  select * into s from public.clinic_settings where clinic_id = c.id;
  v_today := private.today(c.id);
  v_date := case when p_date between v_today and v_today + 1 then p_date else v_today end;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', x.id, 'name', x.name, 'opd', x.opd_name, 'specialization', x.specialization))
                            order by x.created_at, x.id), '[]'::jsonb)
    into v_doctors from public.doctors x where x.clinic_id = c.id and x.is_active;

  select * into d from public.doctors x where x.clinic_id = c.id and x.is_active and x.id = p_doctor_id;
  if not found then
    select * into d from public.doctors x where x.clinic_id = c.id and x.is_active order by x.created_at, x.id limit 1;
  end if;

  if d.id is not null then
    v_board := private.board_json(d.id, v_date, v_today);
    v_av := private.availability_json(d.id, v_date);
    v_mpp := coalesce(d.minutes_per_patient, s.average_consultation_minutes, 10);
    -- What a new patient can expect: everyone waiting, plus the one being seen, at the usual minutes each. An estimate.
    v_wait := ((v_board ->> 'waiting_count')::int + case when (v_board ->> 'consulting')::boolean then 1 else 0 end) * v_mpp;
  end if;

  return jsonb_build_object('ok', true,
    'clinic', jsonb_build_object('name', c.name, 'slug', c.slug, 'timezone', c.timezone),
    'now', private.clock(), 'today', v_today, 'date', v_date, 'doctors', v_doctors,
    'doctor', case when d.id is null then null else jsonb_strip_nulls(jsonb_build_object('id', d.id, 'name', d.name, 'opd', d.opd_name, 'specialization', d.specialization)) end,
    'board', v_board,
    'estimate', case when d.id is null then null else jsonb_build_object(
      'minutes_per_patient', v_mpp, 'wait_for_new_booking_minutes', v_wait,
      'queue_open', coalesce(v_av ->> 'reason', '') not in ('closed', 'ended', 'doctor_unavailable')) end);
end $$;

-- A patient who proved their phone number sees where their own tokens stand today. No names, no access keys.
create function public.get_my_position(p_slug text, p_doctor_id uuid, p_verification uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.clinics; v_phone text; v_today date; v_tokens jsonb;
begin
  select * into c from public.clinics where slug = lower(btrim(coalesce(p_slug, '')));
  if not found then return private.fail('not_found', 'This clinic could not be found.'); end if;
  -- Only a code sent to the phone itself proves the phone. An emailed code does not.
  v_phone := private.verified_phone(p_verification, true);
  if v_phone is null then
    return private.fail(case when p_verification is null then 'otp_required' else 'otp_expired' end,
      'Verify your mobile number with the code we send you to see your place in the queue.');
  end if;
  v_today := private.today(c.id);

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'number', t.token_number, 'status', t.status, 'session_start', to_char(t.session_start, 'HH24:MI'), 'session_end', to_char(t.session_end, 'HH24:MI'),
      'view', case when t.status in ('waiting', 'serving') then private.token_view_json(t) end)) order by t.token_number), '[]'::jsonb)
    into v_tokens
  from public.queue_tokens t join public.patients p on p.id = t.patient_id
  where t.clinic_id = c.id and t.doctor_id = p_doctor_id and t.queue_date = v_today and p.phone = v_phone and t.status <> 'cancelled';

  return jsonb_build_object('ok', true, 'today', v_today, 'now', private.clock(), 'timezone', c.timezone, 'tokens', v_tokens);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. The public directory
-- ---------------------------------------------------------------------------------------------------------------
create function public.directory_filters() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ok', true, 'specializations', coalesce((
    select jsonb_agg(x.sp order by x.sp) from (
      select distinct initcap(btrim(d.specialization)) as sp
      from public.doctors d join public.clinics c on c.id = d.clinic_id
      where c.public_listing and d.is_active and nullif(btrim(d.specialization), '') is not null limit 60) x), '[]'::jsonb))
$$;

create function public.directory_search(p_query text default null, p_specialization text default null, p_doctor text default null,
                                        p_limit integer default 12, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_q text := nullif(btrim(coalesce(p_query, '')), ''); v_sp text := nullif(btrim(coalesce(p_specialization, '')), '');
  v_dn text := nullif(btrim(coalesce(p_doctor, '')), '');
  v_like text; v_dlike text; v_limit int := least(greatest(coalesce(p_limit, 12), 1), 20); v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_total int; v_out jsonb;
begin
  if v_q is not null and (char_length(v_q) < 2 or char_length(v_q) > 60) then
    return private.fail('invalid_input', 'Type between 2 and 60 letters to search.');
  end if;
  if v_dn is not null and (char_length(v_dn) < 2 or char_length(v_dn) > 60) then
    return private.fail('invalid_input', 'Type between 2 and 60 letters for the doctor name.');
  end if;
  v_like := case when v_q is null then null else '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  v_dlike := case when v_dn is null then null else '%' || replace(replace(replace(v_dn, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  select max(h.total), coalesce(jsonb_agg(h.row_json order by h.any_open desc, h.ord_name), '[]'::jsonb)
    into v_total, v_out
  from (
    with hits as (
      select c.id, c.slug, c.name, c.city, c.address, c.state, c.public_phone,
             exists (select 1 from public.doctors d where d.clinic_id = c.id and d.is_active
                       and (private.availability_json(d.id, private.today(c.id)) ->> 'open')::boolean) as any_open,
             count(*) over () as total
      from public.clinics c
      where c.public_listing
        and (v_like is null or c.name ilike v_like escape '\' or coalesce(c.city, '') ilike v_like escape '\' or coalesce(c.address, '') ilike v_like escape '\'
             or coalesce(c.state, '') ilike v_like escape '\' or coalesce(c.pincode, '') ilike v_like escape '\')
        and exists (select 1 from public.doctors d where d.clinic_id = c.id and d.is_active
                      and (v_sp is null or lower(btrim(coalesce(d.specialization, ''))) = lower(v_sp))
                      and (v_dlike is null or d.name ilike v_dlike escape '\'))
    )
    select hp.total, hp.any_open, lower(hp.name) as ord_name, jsonb_strip_nulls(jsonb_build_object(
      'slug', hp.slug, 'name', hp.name, 'city', hp.city, 'address', hp.address, 'state', hp.state, 'phone', hp.public_phone, 'any_open', hp.any_open,
      'doctors', (
        select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'id', d.id, 'name', d.name, 'opd', d.opd_name, 'specialization', d.specialization,
            'today', private.availability_json(d.id, private.today(hp.id)),
            'queue', (select jsonb_build_object('status', b -> 'status', 'waiting_count', b -> 'waiting_count', 'current_number', b -> 'current_number', 'consulting', b -> 'consulting')
                      from (select private.board_json(d.id, private.today(hp.id), private.today(hp.id)) as b) q)
          )) order by d.created_at, d.id), '[]'::jsonb)
        from public.doctors d where d.clinic_id = hp.id and d.is_active
          and (v_sp is null or lower(btrim(coalesce(d.specialization, ''))) = lower(v_sp))
          and (v_dlike is null or d.name ilike v_dlike escape '\'))
    )) as row_json
    from (select * from hits order by any_open desc, lower(name) limit v_limit offset v_offset) hp
  ) h;
  v_total := coalesce(v_total, 0);

  return jsonb_build_object('ok', true, 'total', v_total, 'clinics', v_out, 'offset', v_offset, 'limit', v_limit);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. The owner's public profile and booking security
-- ---------------------------------------------------------------------------------------------------------------
create function public.get_public_settings(p_clinic uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.clinics; s public.clinic_settings;
begin
  if private.member_role(p_clinic) is null then return private.forbidden('You do not have access to this clinic.'); end if;
  select * into c from public.clinics where id = p_clinic;
  select * into s from public.clinic_settings where clinic_id = p_clinic;
  return jsonb_build_object('ok', true, 'listed', c.public_listing, 'city', c.city, 'address', c.address, 'phone', c.public_phone,
    'require_phone_otp', coalesce(s.require_phone_otp, false));
end $$;

create function public.update_public_settings(p_clinic uuid, p_listed boolean, p_city text, p_address text, p_phone text,
                                              p_require_otp boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_city text := nullif(btrim(coalesce(p_city, '')), ''); v_addr text := nullif(btrim(coalesce(p_address, '')), '');
        v_phone text := nullif(btrim(coalesce(p_phone, '')), ''); e jsonb := '{}'::jsonb; v_active int;
begin
  if private.member_role(p_clinic) is distinct from 'owner' then return private.forbidden(); end if;
  if v_city is not null and char_length(v_city) > 60 then e := e || jsonb_build_object('city', 'At most 60 characters.'); end if;
  if v_addr is not null and char_length(v_addr) > 160 then e := e || jsonb_build_object('address', 'At most 160 characters.'); end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9][0-9 ()-]{6,18}[0-9]$' then e := e || jsonb_build_object('phone', 'Enter a phone number with digits only (spaces and a leading + are fine).'); end if;
  if coalesce(p_listed, false) and v_city is null and v_addr is null then
    e := e || jsonb_build_object('city', 'Add a city or an address so patients can find you.');
  end if;
  if e <> '{}'::jsonb then return private.fail('invalid_input', 'Please fix the highlighted fields.', jsonb_build_object('field_errors', e)); end if;
  select count(*) into v_active from public.doctors where clinic_id = p_clinic and is_active;
  if coalesce(p_listed, false) and v_active = 0 then
    return private.fail('invalid_input', 'Add at least one doctor before listing the clinic.');
  end if;

  update public.clinics set public_listing = coalesce(p_listed, false), city = v_city, address = v_addr, public_phone = v_phone, updated_at = private.clock()
    where id = p_clinic;
  update public.clinic_settings set require_phone_otp = coalesce(p_require_otp, false) where clinic_id = p_clinic;
  perform private.audit(p_clinic, 'clinic.public_settings', 'clinic', p_clinic,
    jsonb_build_object('listed', coalesce(p_listed, false), 'require_phone_otp', coalesce(p_require_otp, false)));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 7. A token's secret key is the patient's private link. Staff screens never need it.
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_cols
  from information_schema.columns where table_schema = 'public' and table_name = 'queue_tokens' and column_name <> 'access_key';
  revoke select on public.queue_tokens from authenticated;
  execute format('grant select (%s) on public.queue_tokens to authenticated', v_cols);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 8. Who may call what
-- ---------------------------------------------------------------------------------------------------------------
revoke execute on function private.email_error(text), private.verified_phone(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.otp_begin(text, text, text, text), public.otp_set_hash(uuid, text), public.otp_cancel(uuid), public.otp_check(uuid, text),
  public.booking_email_context(uuid) from public, anon, authenticated;
grant execute on function public.otp_begin(text, text, text, text), public.otp_set_hash(uuid, text), public.otp_cancel(uuid), public.otp_check(uuid, text),
  public.booking_email_context(uuid) to service_role;

revoke execute on function public.book_token(text, text, text, uuid, date, text, uuid, text), public.get_my_position(text, uuid, uuid),
  public.directory_filters(), public.directory_search(text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.book_token(text, text, text, uuid, date, text, uuid, text), public.get_my_position(text, uuid, uuid),
  public.directory_filters(), public.directory_search(text, text, text, integer, integer) to anon, authenticated;

revoke execute on function public.get_public_settings(uuid), public.update_public_settings(uuid, boolean, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.get_public_settings(uuid), public.update_public_settings(uuid, boolean, text, text, text, boolean) to authenticated;

-- Nothing else may be callable by the public. This fails the migration, loudly, if it ever is.
do $$
declare f record;
begin
  for f in select p.proname from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prokind = 'f'
             and has_function_privilege('anon', p.oid, 'execute')
             and p.proname not in ('get_public_clinic', 'book_token', 'get_my_token', 'cancel_my_token', 'get_public_queue',
                                   'get_my_position', 'directory_search', 'directory_filters') loop
    raise exception 'The public can execute %, which it must not.', f.proname;
  end loop;
end $$;
