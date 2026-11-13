-- Cliniq migration 7: staff provisioning.
--
-- The clinic owner creates a staff login with a temporary password. The person must change it on first sign in, and
-- until they do, the database treats them as having no role anywhere (so a leaked temporary password opens nothing).
-- Someone who already has a Cliniq account is never attached to a clinic behind their back: they get an invitation
-- that they have to accept themselves.
--
-- Additive only. Nothing is dropped or reset. Passwords are never stored here: Supabase Auth hashes them.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Profile flags
-- ---------------------------------------------------------------------------------------------------------------
alter table public.profiles
  add column if not exists must_change_password boolean not null default false,
  add column if not exists password_changed_at timestamptz;
-- The API role can change only full_name and phone on profiles (migration 2), so neither flag is writable by a browser.

-- While the flag is set the person has no role in any clinic. The checked functions and the row level security
-- policies all ask this function, so the rule cannot be skipped by calling the API directly.
create or replace function private.member_role(p_clinic uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role
  from public.clinic_memberships m
  where m.clinic_id = p_clinic and m.user_id = (select auth.uid()) and m.is_active
    and not exists (select 1 from public.profiles p where p.id = m.user_id and p.must_change_password)
  limit 1
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Invitations for people who already have a Cliniq account (14th table) and an email event log (15th table)
-- ---------------------------------------------------------------------------------------------------------------
create table public.clinic_invitations (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  email text not null,
  role text not null check (role in ('receptionist', 'doctor')),
  doctor_id uuid references public.doctors (id) on delete set null,
  doctor_details jsonb,
  invited_by uuid references auth.users (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now(),
  responded_at timestamptz
);
alter table public.clinic_invitations enable row level security;
create unique index one_pending_invitation on public.clinic_invitations (clinic_id, user_id) where status = 'pending';
create index idx_invitations_user on public.clinic_invitations (user_id);
create index idx_invitations_doctor on public.clinic_invitations (doctor_id);
create index idx_invitations_invited_by on public.clinic_invitations (invited_by);
-- No policies and no grants: invitations are read and answered only through the functions below.

create table public.email_events (
  id bigint generated always as identity primary key,
  clinic_id uuid references public.clinics (id) on delete cascade,
  template text not null,
  recipient_hint text,
  status text not null check (status in ('sent', 'failed', 'skipped')),
  provider_id text,
  error text,
  created_at timestamptz not null default now()
);
alter table public.email_events enable row level security;
create index idx_email_events_clinic on public.email_events (clinic_id, created_at desc);
create policy "Owner reads email events" on public.email_events
  for select to authenticated using (private.is_clinic_owner(clinic_id));
grant select on public.email_events to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------------------------------------------

-- Checks the professional details typed for a new doctor. Keys are the form's field names.
create function private.new_doctor_errors(p jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare e jsonb := '{}'::jsonb; v_fee numeric;
begin
  if char_length(btrim(coalesce(p ->> 'specialization', ''))) not between 2 and 60 then
    e := e || jsonb_build_object('specialization', 'Enter the specialisation, for example General Physician (2 to 60 characters).');
  end if;
  if char_length(btrim(coalesce(p ->> 'qualification', ''))) > 120 then
    e := e || jsonb_build_object('qualification', 'The qualification can have at most 120 characters.');
  end if;
  if btrim(coalesce(p ->> 'phone', '')) <> '' and private.normalize_phone(p ->> 'phone') is null then
    e := e || jsonb_build_object('doctorPhone', 'Enter a valid 10 digit mobile number or leave this empty.');
  end if;
  if btrim(coalesce(p ->> 'opd', '')) <> '' and char_length(btrim(p ->> 'opd')) not between 2 and 40 then
    e := e || jsonb_build_object('opd', 'The OPD name needs 2 to 40 characters.');
  end if;
  if btrim(coalesce(p ->> 'consultation_fee', '')) <> '' then
    begin
      v_fee := (p ->> 'consultation_fee')::numeric;
      if v_fee < 0 or v_fee > 100000 then raise exception 'range'; end if;
    exception when others then
      e := e || jsonb_build_object('consultationFee', 'Enter a fee between 0 and 100000, or leave this empty.');
    end;
  end if;
  return e;
end $$;

-- Creates the doctor record for a new doctor login. It has no weekly timings yet, so patients cannot book it until
-- the owner sets them in the schedule editor.
create function private.insert_login_doctor(p_clinic uuid, p_user uuid, p_name text, p_details jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.doctors (clinic_id, profile_id, name, specialization, qualification, phone, consultation_fee, opd_name)
  values (p_clinic, p_user, private.clean_name(p_name), btrim(p_details ->> 'specialization'),
          nullif(btrim(coalesce(p_details ->> 'qualification', '')), ''),
          private.normalize_phone(p_details ->> 'phone'),
          nullif(btrim(coalesce(p_details ->> 'consultation_fee', '')), '')::numeric,
          coalesce(nullif(btrim(coalesce(p_details ->> 'opd', '')), ''), 'General OPD'))
  returning id into v_id;
  return v_id;
end $$;

create function private.staff_name_error(p text) returns text
language sql immutable set search_path = '' as $$
  select case when private.name_error(p) is null then null
              else 'Enter the full name, 2 to 60 letters (digits and symbols are not allowed).' end
$$;

-- True when this user is the active owner of the clinic. Used by the server side functions, where there is no auth.uid().
create function private.user_is_owner(p_clinic uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.clinic_memberships m
                 where m.clinic_id = p_clinic and m.user_id = p_user and m.role = 'owner' and m.is_active)
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Server side functions. Called only by the staff-account Edge Function with the project's secret key.
-- ---------------------------------------------------------------------------------------------------------------

-- Everything that can be checked before an account is created. Returns what the email address already is.
create function public.staff_precheck(p_clinic uuid, p_email text, p_role text, p_doctor_id uuid, p_inviter uuid,
                                      p_full_name text default null, p_new_doctor jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_errors jsonb := '{}'::jsonb; v_user uuid; v_member public.clinic_memberships; d public.doctors; v_recent int; v_ctx jsonb;
begin
  if not private.user_is_owner(p_clinic, p_inviter) then return private.forbidden('Only the clinic owner can add staff.'); end if;
  if p_role not in ('receptionist', 'doctor') then
    return private.fail('invalid_input', 'Staff can be a receptionist or a doctor.', jsonb_build_object('field_errors', jsonb_build_object('role', 'Choose Receptionist or Doctor.')));
  end if;
  if private.staff_name_error(p_full_name) is not null then v_errors := v_errors || jsonb_build_object('fullName', private.staff_name_error(p_full_name)); end if;
  if p_role = 'doctor' then
    if p_doctor_id is not null then
      select * into d from public.doctors where id = p_doctor_id and clinic_id = p_clinic and is_active;
      if not found then v_errors := v_errors || jsonb_build_object('doctorId', 'This doctor could not be found.');
      elsif d.profile_id is not null then v_errors := v_errors || jsonb_build_object('doctorId', 'This doctor already has a login.'); end if;
    elsif p_new_doctor is not null then
      v_errors := v_errors || private.new_doctor_errors(p_new_doctor);
    else
      v_errors := v_errors || jsonb_build_object('specialization', 'Enter the doctor''s professional details, or choose an existing doctor.');
    end if;
  end if;
  if v_errors <> '{}'::jsonb then
    return private.fail('invalid_input', 'Please fix the highlighted fields.', jsonb_build_object('field_errors', v_errors));
  end if;

  select count(*) into v_recent from public.audit_log
    where clinic_id = p_clinic and action in ('staff.create', 'staff.invitation_sent') and created_at > private.clock() - interval '1 hour';
  if v_recent >= 20 then
    return private.fail('rate_limited', 'You have added many staff in the last hour. Please try again a little later.');
  end if;

  v_ctx := jsonb_build_object('clinic_name', (select c.name from public.clinics c where c.id = p_clinic),
                              'inviter_name', (select p.full_name from public.profiles p where p.id = p_inviter));
  select p.id into v_user from public.profiles p where lower(p.email) = v_email;
  if v_user is null then return jsonb_build_object('ok', true, 'state', 'new') || v_ctx; end if;
  select * into v_member from public.clinic_memberships where clinic_id = p_clinic and user_id = v_user;
  if found then
    return jsonb_build_object('ok', true, 'state', 'already_member', 'role', v_member.role, 'is_active', v_member.is_active) || v_ctx;
  end if;
  return jsonb_build_object('ok', true, 'state', 'existing_user', 'user_id', v_user,
    'full_name', (select p.full_name from public.profiles p where p.id = v_user)) || v_ctx;
end $$;

-- Gives a brand new account its place in the clinic. The Edge Function has just created the account, with a hashed
-- temporary password, and passes p_must_change = true.
create function public.provision_staff(p_clinic uuid, p_user_id uuid, p_role text, p_doctor_id uuid, p_new_doctor jsonb,
                                       p_inviter uuid, p_full_name text, p_must_change boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.doctors; v_doctor uuid;
begin
  if not private.user_is_owner(p_clinic, p_inviter) then return private.forbidden('Only the clinic owner can add staff.'); end if;
  if p_role not in ('receptionist', 'doctor') then return private.fail('invalid_input', 'Staff can be a receptionist or a doctor.'); end if;
  if exists (select 1 from public.clinic_memberships where clinic_id = p_clinic and user_id = p_user_id) then
    return private.fail('duplicate', 'This person already works in the clinic.');
  end if;
  if p_role = 'doctor' then
    if p_doctor_id is not null then
      select * into d from public.doctors where id = p_doctor_id and clinic_id = p_clinic and is_active for update;
      if not found then return private.fail('not_found', 'This doctor could not be found.'); end if;
      if d.profile_id is not null then return private.fail('invalid_transition', 'This doctor already has a login.'); end if;
      v_doctor := d.id;
    elsif p_new_doctor is not null and private.new_doctor_errors(p_new_doctor) = '{}'::jsonb then
      v_doctor := private.insert_login_doctor(p_clinic, p_user_id, p_full_name, p_new_doctor);
    else
      return private.fail('invalid_input', 'Choose an existing doctor or enter the doctor''s professional details.');
    end if;
  end if;

  update public.profiles
    set full_name = coalesce(nullif(btrim(coalesce(p_full_name, '')), ''), full_name),
        must_change_password = coalesce(p_must_change, true)
    where id = p_user_id;
  insert into public.clinic_memberships (clinic_id, user_id, role, is_active, invited_by)
    values (p_clinic, p_user_id, p_role, true, p_inviter);
  if p_role = 'doctor' and p_doctor_id is not null then update public.doctors set profile_id = p_user_id where id = v_doctor; end if;

  perform private.audit(p_clinic, 'staff.create', 'user', p_user_id,
    jsonb_build_object('role', p_role, 'doctor_id', v_doctor, 'temporary_password', true), p_inviter);
  return jsonb_build_object('ok', true, 'doctor_id', v_doctor);
end $$;

-- An invitation for someone who already has a Cliniq account. They are not attached until they accept it.
create function public.create_invitation(p_clinic uuid, p_user_id uuid, p_role text, p_doctor_id uuid, p_new_doctor jsonb,
                                         p_inviter uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.doctors; v_email text; v_id uuid;
begin
  if not private.user_is_owner(p_clinic, p_inviter) then return private.forbidden('Only the clinic owner can add staff.'); end if;
  if p_role not in ('receptionist', 'doctor') then return private.fail('invalid_input', 'Staff can be a receptionist or a doctor.'); end if;
  if exists (select 1 from public.clinic_memberships where clinic_id = p_clinic and user_id = p_user_id) then
    return private.fail('duplicate', 'This person already works in the clinic.');
  end if;
  if p_role = 'doctor' then
    if p_doctor_id is not null then
      select * into d from public.doctors where id = p_doctor_id and clinic_id = p_clinic and is_active;
      if not found then return private.fail('not_found', 'This doctor could not be found.'); end if;
      if d.profile_id is not null then return private.fail('invalid_transition', 'This doctor already has a login.'); end if;
    elsif p_new_doctor is null or private.new_doctor_errors(p_new_doctor) <> '{}'::jsonb then
      return private.fail('invalid_input', 'Choose an existing doctor or enter the doctor''s professional details.');
    end if;
  end if;
  select p.email into v_email from public.profiles p where p.id = p_user_id;
  if v_email is null then return private.fail('not_found', 'This account could not be found.'); end if;

  update public.clinic_invitations set status = 'revoked', responded_at = private.clock()
    where clinic_id = p_clinic and user_id = p_user_id and status = 'pending';
  insert into public.clinic_invitations (clinic_id, user_id, email, role, doctor_id, doctor_details, invited_by, expires_at)
    values (p_clinic, p_user_id, v_email, p_role, p_doctor_id, case when p_doctor_id is null then p_new_doctor end, p_inviter,
            private.clock() + interval '7 days')
    returning id into v_id;
  perform private.audit(p_clinic, 'staff.invitation_sent', 'user', p_user_id, jsonb_build_object('role', p_role), p_inviter);
  return jsonb_build_object('ok', true, 'invitation_id', v_id);
end $$;

-- After the person has chosen their own password.
create function public.finish_first_login(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m record;
begin
  update public.profiles set must_change_password = false, password_changed_at = private.clock() where id = p_user_id;
  for m in select clinic_id from public.clinic_memberships where user_id = p_user_id loop
    perform private.audit(m.clinic_id, 'staff.password_changed', 'user', p_user_id, '{}'::jsonb, p_user_id);
  end loop;
  return jsonb_build_object('ok', true);
end $$;

-- For "resend" and "set a new temporary password": only while the person has not yet chosen their own password.
create function public.staff_first_login_status(p_clinic uuid, p_user_id uuid, p_inviter uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare pr public.profiles;
begin
  if not private.user_is_owner(p_clinic, p_inviter) then return private.forbidden('Only the clinic owner can do this.'); end if;
  if not exists (select 1 from public.clinic_memberships where clinic_id = p_clinic and user_id = p_user_id) then
    return private.fail('not_found', 'This staff member could not be found.');
  end if;
  select * into pr from public.profiles where id = p_user_id;
  return jsonb_build_object('ok', true, 'pending', pr.must_change_password, 'email', pr.email, 'full_name', pr.full_name,
    'clinic_name', (select c.name from public.clinics c where c.id = p_clinic),
    'role', (select m.role from public.clinic_memberships m where m.clinic_id = p_clinic and m.user_id = p_user_id));
end $$;

-- Audit events written by the staff Edge Function for actions that change nothing else in the database.
create function public.log_staff_event(p_clinic uuid, p_user_id uuid, p_action text, p_inviter uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_action not in ('staff.password_reset', 'staff.activation_resent') then raise exception 'unknown staff event'; end if;
  if not private.user_is_owner(p_clinic, p_inviter) then raise exception 'not the owner'; end if;
  perform private.audit(p_clinic, p_action, 'user', p_user_id, '{}'::jsonb, p_inviter);
end $$;

create function public.staff_profile_name(p_user_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select full_name from public.profiles where id = p_user_id
$$;

create function public.log_email_event(p_clinic uuid, p_template text, p_recipient text, p_status text, p_provider_id text,
                                       p_error text) returns void
language sql security definer set search_path = '' as $$
  insert into public.email_events (clinic_id, template, recipient_hint, status, provider_id, error)
  values (p_clinic, left(p_template, 60),
          case when p_recipient ~ '^[^@]+@[^@]+$' then left(split_part(p_recipient, '@', 1), 1) || '***@' || split_part(p_recipient, '@', 2) end,
          p_status, left(p_provider_id, 120), left(p_error, 500))
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Signed in functions
-- ---------------------------------------------------------------------------------------------------------------

-- The profile and clinics now also say whether the person still has to choose a password.
create or replace function public.my_clinics() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_profile jsonb; v_clinics jsonb; v_must boolean;
begin
  if v_uid is null then return private.fail('forbidden', 'Sign in first.'); end if;
  select jsonb_build_object('id', p.id, 'full_name', p.full_name, 'email', p.email), p.must_change_password
    into v_profile, v_must from public.profiles p where p.id = v_uid;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'slug', c.slug, 'timezone', c.timezone, 'role', m.role,
      'doctor_id', (select d.id from public.doctors d where d.clinic_id = c.id and d.profile_id = v_uid and d.is_active limit 1))
    order by c.name), '[]'::jsonb) into v_clinics
  from public.clinic_memberships m join public.clinics c on c.id = m.clinic_id
  where m.user_id = v_uid and m.is_active;
  return jsonb_build_object('ok', true, 'profile', v_profile, 'clinics', v_clinics,
    'must_change_password', coalesce(v_must, false),
    'pending_invitations', (select count(*) from public.clinic_invitations i
                            where i.user_id = v_uid and i.status = 'pending' and i.expires_at > private.clock()));
end $$;

create function public.my_invitations() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then return private.fail('forbidden', 'Sign in first.'); end if;
  return jsonb_build_object('ok', true, 'invitations', coalesce((
    select jsonb_agg(jsonb_build_object('id', i.id, 'clinic_name', c.name, 'role', i.role,
             'invited_by', (select p.full_name from public.profiles p where p.id = i.invited_by),
             'doctor_name', coalesce((select d.name from public.doctors d where d.id = i.doctor_id), i.doctor_details ->> 'specialization'),
             'expires_at', i.expires_at, 'created_at', i.created_at) order by i.created_at desc)
    from public.clinic_invitations i join public.clinics c on c.id = i.clinic_id
    where i.user_id = v_uid and i.status = 'pending' and i.expires_at > private.clock()), '[]'::jsonb));
end $$;

-- The invited person accepts or declines for themselves. This is the consent step.
create function public.respond_invitation(p_invitation uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); i public.clinic_invitations; d public.doctors; v_doctor uuid; v_name text; m public.clinic_memberships;
begin
  if v_uid is null then return private.fail('forbidden', 'Sign in first.'); end if;
  select * into i from public.clinic_invitations where id = p_invitation and user_id = v_uid for update;
  if not found then return private.fail('not_found', 'This invitation could not be found.'); end if;
  if i.status <> 'pending' or i.expires_at <= private.clock() then
    return private.fail('stale', 'This invitation is no longer open. Ask the clinic owner to send a new one.');
  end if;

  if not coalesce(p_accept, false) then
    update public.clinic_invitations set status = 'declined', responded_at = private.clock() where id = i.id;
    perform private.audit(i.clinic_id, 'staff.invitation_declined', 'user', v_uid, '{}'::jsonb, v_uid);
    return jsonb_build_object('ok', true, 'accepted', false);
  end if;

  select * into m from public.clinic_memberships where clinic_id = i.clinic_id and user_id = v_uid;
  if found then
    update public.clinic_invitations set status = 'accepted', responded_at = private.clock() where id = i.id;
    return jsonb_build_object('ok', true, 'accepted', true);
  end if;
  if i.role = 'doctor' then
    if i.doctor_id is not null then
      select * into d from public.doctors where id = i.doctor_id and clinic_id = i.clinic_id and is_active for update;
      if not found then return private.fail('not_found', 'This doctor record is no longer available. Ask the owner to send a new invitation.'); end if;
      if d.profile_id is not null and d.profile_id <> v_uid then
        return private.fail('invalid_transition', 'This doctor already has a login. Ask the owner to send a new invitation.');
      end if;
      v_doctor := d.id;
    else
      select coalesce(p.full_name, 'Doctor') into v_name from public.profiles p where p.id = v_uid;
      v_doctor := private.insert_login_doctor(i.clinic_id, v_uid, v_name, i.doctor_details);
    end if;
  end if;
  insert into public.clinic_memberships (clinic_id, user_id, role, is_active, invited_by)
    values (i.clinic_id, v_uid, i.role, true, i.invited_by);
  if v_doctor is not null then update public.doctors set profile_id = v_uid where id = v_doctor; end if;
  update public.clinic_invitations set status = 'accepted', responded_at = private.clock() where id = i.id;
  perform private.audit(i.clinic_id, 'staff.invitation_accepted', 'user', v_uid, jsonb_build_object('role', i.role), v_uid);
  return jsonb_build_object('ok', true, 'accepted', true, 'clinic_id', i.clinic_id);
end $$;

create function public.revoke_invitation(p_clinic uuid, p_invitation uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if private.member_role(p_clinic) is distinct from 'owner' then return private.forbidden(); end if;
  update public.clinic_invitations set status = 'revoked', responded_at = private.clock()
    where id = p_invitation and clinic_id = p_clinic and status = 'pending';
  if not found then return private.fail('not_found', 'This invitation could not be found.'); end if;
  perform private.audit(p_clinic, 'staff.invitation_revoked', 'invitation', p_invitation);
  return jsonb_build_object('ok', true);
end $$;

-- The owner's staff list now also shows who has not chosen a password yet, and the invitations still waiting.
create or replace function public.list_staff(p_clinic uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_staff jsonb; v_free jsonb; v_invites jsonb;
begin
  if private.member_role(p_clinic) is distinct from 'owner' then return private.forbidden(); end if;
  select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role, 'is_active', m.is_active,
           'full_name', pr.full_name, 'email', pr.email, 'doctor_id', d.id, 'doctor_name', d.name, 'created_at', m.created_at,
           'first_login_pending', pr.must_change_password)
         order by m.role, m.created_at), '[]'::jsonb) into v_staff
  from public.clinic_memberships m join public.profiles pr on pr.id = m.user_id
  left join public.doctors d on d.clinic_id = m.clinic_id and d.profile_id = m.user_id
  where m.clinic_id = p_clinic;
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'opd', d.opd_name) order by d.created_at), '[]'::jsonb) into v_free
  from public.doctors d where d.clinic_id = p_clinic and d.is_active and d.profile_id is null;
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'role', i.role, 'expires_at', i.expires_at,
           'created_at', i.created_at) order by i.created_at desc), '[]'::jsonb) into v_invites
  from public.clinic_invitations i where i.clinic_id = p_clinic and i.status = 'pending' and i.expires_at > private.clock();
  return jsonb_build_object('ok', true, 'staff', v_staff, 'doctors_without_login', v_free, 'pending_invitations', v_invites);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Who may call what
-- ---------------------------------------------------------------------------------------------------------------
grant execute on function public.my_invitations(), public.respond_invitation(uuid, boolean), public.revoke_invitation(uuid, uuid)
  to authenticated;
revoke execute on function public.staff_precheck(uuid, text, text, uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.provision_staff(uuid, uuid, text, uuid, jsonb, uuid, text, boolean) from public, anon, authenticated;
revoke execute on function public.create_invitation(uuid, uuid, text, uuid, jsonb, uuid) from public, anon, authenticated;
revoke execute on function public.finish_first_login(uuid) from public, anon, authenticated;
revoke execute on function public.staff_first_login_status(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.log_email_event(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.log_staff_event(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.staff_profile_name(uuid) from public, anon, authenticated;
grant execute on function public.staff_precheck(uuid, text, text, uuid, uuid, text, jsonb),
  public.provision_staff(uuid, uuid, text, uuid, jsonb, uuid, text, boolean),
  public.create_invitation(uuid, uuid, text, uuid, jsonb, uuid),
  public.finish_first_login(uuid), public.staff_first_login_status(uuid, uuid, uuid),
  public.log_email_event(uuid, text, text, text, text, text), public.log_staff_event(uuid, uuid, text, uuid), public.staff_profile_name(uuid) to service_role;
revoke execute on function public.my_invitations(), public.respond_invitation(uuid, boolean), public.revoke_invitation(uuid, uuid) from public, anon;

-- The private helpers are only ever called from the functions above, which run as their owner.
revoke execute on function private.new_doctor_errors(jsonb), private.insert_login_doctor(uuid, uuid, text, jsonb),
  private.staff_name_error(text), private.user_is_owner(uuid, uuid) from public, anon, authenticated;

-- Note: public.attach_staff (migration 4) stays callable by the server key because the test harness builds its clinics
-- with it. The deployed Edge Functions no longer call it, and the old invite-staff function is replaced by a stub, so
-- no browser or deployed function can attach an existing account to a clinic without that person accepting.
