-- Cliniq migration 2 of 4: who can read what.
--
-- Replaces the project's policies. The old ones let every member read diagnoses and prescriptions and let
-- managers write queue rows directly. After this migration:
--   * the public (anon) role touches no table at all
--   * signed in staff can only READ, and only what their role allows
--   * every change goes through the checked functions in migration 3
--
-- Role rules (approved):
--   owner         clinic details, staff, settings, reports. No diagnosis, notes, prescriptions or report files.
--   receptionist  patient details, the queue, visit dates and visit titles. No diagnosis, notes, prescriptions.
--   doctor        everything clinical for patients of their own clinic.

-- ---------------------------------------------------------------------------------------------------------------
-- Role helpers. They live in the private schema, which the API does not expose.
-- ---------------------------------------------------------------------------------------------------------------
create function private.member_role(p_clinic uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role
  from public.clinic_memberships m
  where m.clinic_id = p_clinic and m.user_id = (select auth.uid()) and m.is_active
  limit 1
$$;

create function private.is_clinic_member(p_clinic uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.member_role(p_clinic) is not null
$$;

create function private.is_clinic_manager(p_clinic uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.member_role(p_clinic) in ('owner', 'receptionist'), false)
$$;

create function private.is_clinic_owner(p_clinic uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.member_role(p_clinic) = 'owner', false)
$$;

create function private.is_clinic_doctor(p_clinic uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.member_role(p_clinic) = 'doctor', false)
$$;

grant execute on function private.member_role(uuid), private.is_clinic_member(uuid), private.is_clinic_manager(uuid),
  private.is_clinic_owner(uuid), private.is_clinic_doctor(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- Remove every existing policy, then the old helpers they used
-- ---------------------------------------------------------------------------------------------------------------
drop policy if exists "Managers can manage appointments" on public.appointments;
drop policy if exists "Members can view appointments" on public.appointments;
drop policy if exists "Members can view clinic memberships" on public.clinic_memberships;
drop policy if exists "Owners can add memberships" on public.clinic_memberships;
drop policy if exists "Owners can remove memberships" on public.clinic_memberships;
drop policy if exists "Owners can update memberships" on public.clinic_memberships;
drop policy if exists "Members can view clinic settings" on public.clinic_settings;
drop policy if exists "Owners can manage clinic settings" on public.clinic_settings;
drop policy if exists "Members can view their clinics" on public.clinics;
drop policy if exists "Owners can update their clinics" on public.clinics;
drop policy if exists "Managers can manage doctor schedules" on public.doctor_schedules;
drop policy if exists "Members can view doctor schedules" on public.doctor_schedules;
drop policy if exists "Managers can manage doctors" on public.doctors;
drop policy if exists "Members can view doctors" on public.doctors;
drop policy if exists "Managers can manage patient reports" on public.patient_reports;
drop policy if exists "Members can view patient reports" on public.patient_reports;
drop policy if exists "Managers can manage patients" on public.patients;
drop policy if exists "Members can view patients" on public.patients;
drop policy if exists "Doctors can manage prescriptions" on public.prescriptions;
drop policy if exists "Members can view prescriptions" on public.prescriptions;
drop policy if exists "Users can insert own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;
drop policy if exists "Users can view own profile" on public.profiles;
drop policy if exists "Managers can manage queue" on public.queue_tokens;
drop policy if exists "Members can view queue" on public.queue_tokens;
drop policy if exists "Doctors can create visits" on public.visits;
drop policy if exists "Doctors can update their visits" on public.visits;
drop policy if exists "Members can view visits" on public.visits;

-- These three are replaced by the private versions above. Without CASCADE this fails, and the whole migration
-- rolls back, if anything else still depends on them.
drop function public.is_clinic_manager(uuid);
drop function public.is_clinic_member(uuid);
drop function public.is_clinic_owner(uuid);

-- ---------------------------------------------------------------------------------------------------------------
-- Read policies
-- ---------------------------------------------------------------------------------------------------------------
create policy "Staff read own clinic" on public.clinics
  for select to authenticated using (private.is_clinic_member(id));

create policy "Staff read own clinic settings" on public.clinic_settings
  for select to authenticated using (private.is_clinic_member(clinic_id));

create policy "Staff read own clinic doctors" on public.doctors
  for select to authenticated using (private.is_clinic_member(clinic_id));

create policy "Staff read own clinic schedules" on public.doctor_schedules
  for select to authenticated using (private.is_clinic_member(clinic_id));

create policy "Staff read own clinic patients" on public.patients
  for select to authenticated using (private.is_clinic_member(clinic_id));

create policy "Staff read own clinic appointments" on public.appointments
  for select to authenticated using (private.is_clinic_member(clinic_id));

create policy "Staff read own clinic queue" on public.queue_tokens
  for select to authenticated using (private.is_clinic_member(clinic_id));

-- A member sees their own membership. The owner sees everyone's in that clinic.
create policy "Read own membership or owned clinic" on public.clinic_memberships
  for select to authenticated using (user_id = (select auth.uid()) or private.is_clinic_owner(clinic_id));

-- Clinical data: doctors only.
create policy "Doctors read clinic visits" on public.visits
  for select to authenticated using (private.is_clinic_doctor(clinic_id));

create policy "Doctors read clinic prescriptions" on public.prescriptions
  for select to authenticated using (private.is_clinic_doctor(clinic_id));

create policy "Doctors read clinic reports" on public.patient_reports
  for select to authenticated using (private.is_clinic_doctor(clinic_id));

create policy "Owner reads audit log" on public.audit_log
  for select to authenticated using (private.is_clinic_owner(clinic_id));

create policy "Read own profile" on public.profiles
  for select to authenticated using (id = (select auth.uid()));

create policy "Update own profile" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------------------------------
-- Table privileges. The policies above are the second lock; this is the first.
-- ---------------------------------------------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.clinics, public.clinic_settings, public.doctors, public.doctor_schedules, public.patients,
  public.appointments, public.queue_tokens, public.clinic_memberships, public.visits, public.prescriptions,
  public.patient_reports, public.audit_log, public.profiles to authenticated;
-- A user may change only their own name and phone number.
grant update (full_name, phone) on public.profiles to authenticated;

-- New objects in public start with no access for the API roles. Each one must be granted on purpose.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- The project's own event trigger function does not need to be callable through the API.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
