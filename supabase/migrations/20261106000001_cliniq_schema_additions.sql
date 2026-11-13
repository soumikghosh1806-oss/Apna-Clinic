-- Cliniq migration 1 of 4: schema additions.
--
-- Additive only. No table is dropped and no data is removed. Every new column is nullable or has a default,
-- so the 12 tables the project already has keep working. Adds the 13th table, audit_log.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------
-- clinics: public address (slug) and time zone
-- ---------------------------------------------------------------------------------------------------------------
alter table public.clinics
  add column if not exists slug text,
  add column if not exists timezone text not null default 'Asia/Kolkata';

update public.clinics set slug = 'clinic-' || substr(replace(id::text, '-', ''), 1, 8) where slug is null;
alter table public.clinics alter column slug set not null;

alter table public.clinics
  add constraint clinics_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 40),
  add constraint clinics_name_length check (char_length(btrim(name)) between 2 and 60);
create unique index clinics_slug_key on public.clinics (slug);
create index if not exists idx_clinics_created_by on public.clinics (created_by);

-- ---------------------------------------------------------------------------------------------------------------
-- profiles: email, shown to the clinic owner in the staff list
-- ---------------------------------------------------------------------------------------------------------------
alter table public.profiles add column if not exists email text;

-- ---------------------------------------------------------------------------------------------------------------
-- clinic_memberships: staff can be switched off without being deleted
-- ---------------------------------------------------------------------------------------------------------------
alter table public.clinic_memberships
  add column if not exists is_active boolean not null default true,
  add column if not exists invited_by uuid references auth.users (id) on delete set null;
create index if not exists idx_memberships_clinic_role on public.clinic_memberships (clinic_id, role) where is_active;

-- ---------------------------------------------------------------------------------------------------------------
-- clinic_settings: tidy nullable columns, add limits
-- ---------------------------------------------------------------------------------------------------------------
update public.clinic_settings set online_booking_enabled = true where online_booking_enabled is null;
update public.clinic_settings set daily_token_limit = 100 where daily_token_limit is null;
update public.clinic_settings set average_consultation_minutes = 10 where average_consultation_minutes is null;
alter table public.clinic_settings
  alter column online_booking_enabled set not null,
  alter column daily_token_limit set not null,
  alter column average_consultation_minutes set not null,
  add column if not exists max_online_bookings_per_phone_per_day integer not null default 4,
  add constraint clinic_settings_daily_limit_max check (daily_token_limit <= 500),
  add constraint clinic_settings_minutes_max check (average_consultation_minutes <= 60),
  add constraint clinic_settings_phone_cap_range check (max_online_bookings_per_phone_per_day between 1 and 20);

-- ---------------------------------------------------------------------------------------------------------------
-- doctors: the OPD each doctor runs and the per doctor overrides the screens already have
-- ---------------------------------------------------------------------------------------------------------------
update public.doctors set is_active = true where is_active is null;
alter table public.doctors
  alter column is_active set not null,
  add column if not exists opd_name text not null default 'General OPD',
  add column if not exists daily_token_limit integer,
  add column if not exists minutes_per_patient integer,
  add column if not exists updated_at timestamptz not null default now(),
  add constraint doctors_name_length check (char_length(btrim(name)) between 2 and 60),
  add constraint doctors_opd_name_length check (char_length(btrim(opd_name)) between 2 and 40),
  add constraint doctors_daily_limit_range check (daily_token_limit is null or daily_token_limit between 1 and 500),
  add constraint doctors_minutes_range check (minutes_per_patient is null or minutes_per_patient between 1 and 60);
create unique index doctors_clinic_profile_key on public.doctors (clinic_id, profile_id) where profile_id is not null;
create index if not exists idx_doctors_profile on public.doctors (profile_id);

-- doctor_schedules: OPD timings. One row per doctor, weekday and session.
create index if not exists idx_schedule_clinic on public.doctor_schedules (clinic_id);
update public.doctor_schedules set is_available = true where is_available is null;
alter table public.doctor_schedules alter column is_available set not null;

-- ---------------------------------------------------------------------------------------------------------------
-- patients
-- ---------------------------------------------------------------------------------------------------------------
alter table public.patients
  add constraint patients_name_length check (char_length(btrim(name)) between 2 and 60),
  add constraint patients_phone_format check (phone is null or phone ~ '^[6-9][0-9]{9}$'),
  add constraint patients_gender_values check (gender is null or gender in ('male', 'female', 'other')),
  add constraint patients_age_max check (age is null or age <= 130);
-- The same person (name and mobile number) is one patient record per clinic. Booking relies on this.
create unique index patients_clinic_phone_name_key on public.patients (clinic_id, phone, lower(name));

-- ---------------------------------------------------------------------------------------------------------------
-- appointments
-- ---------------------------------------------------------------------------------------------------------------
update public.appointments set booking_source = 'online' where booking_source is null;
update public.appointments set status = 'booked' where status is null;
alter table public.appointments
  alter column booking_source set not null,
  alter column status set not null,
  add column if not exists updated_at timestamptz not null default now();
create index if not exists idx_appointments_patient on public.appointments (patient_id, created_at);
create index if not exists idx_appointments_doctor on public.appointments (doctor_id);

-- ---------------------------------------------------------------------------------------------------------------
-- queue_tokens
--   status 'arrived' stays allowed by the existing check but is not used: arrival is the arrived_at time,
--   as in the screens. 'serving' is what the screens call in progress.
-- ---------------------------------------------------------------------------------------------------------------
alter table public.queue_tokens
  add column if not exists order_key integer not null default 0,
  add column if not exists source text not null default 'online',
  add column if not exists arrived_at timestamptz,
  add column if not exists arrival_source text,
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists access_key uuid not null default gen_random_uuid(),
  add constraint queue_tokens_source_check check (source in ('online', 'walk_in')),
  add constraint queue_tokens_arrival_source_check check (arrival_source is null or arrival_source in ('reception', 'walk_in', 'doctor_call')),
  add constraint queue_tokens_number_positive check (token_number > 0);
-- The unguessable part of a patient's own link. Nothing else identifies a token to the public.
create unique index queue_tokens_access_key_key on public.queue_tokens (access_key);
-- A second line of defence behind the booking function: one live token per patient, doctor and day.
create unique index queue_tokens_one_live_per_patient on public.queue_tokens (clinic_id, patient_id, doctor_id, queue_date)
  where status in ('waiting', 'arrived', 'serving', 'on_hold', 'skipped');
-- And one patient with the doctor at a time.
create unique index queue_tokens_one_serving on public.queue_tokens (doctor_id, queue_date) where status = 'serving';
create index if not exists idx_queue_patient on public.queue_tokens (patient_id);
create index if not exists idx_queue_appointment on public.queue_tokens (appointment_id);
create index if not exists idx_queue_calling_order on public.queue_tokens (doctor_id, queue_date, status, order_key, token_number);

-- ---------------------------------------------------------------------------------------------------------------
-- visits: a title that receptionists may see, and the clinical fields they may not
-- ---------------------------------------------------------------------------------------------------------------
alter table public.visits
  add column if not exists title text,
  add column if not exists updated_at timestamptz not null default now(),
  add constraint visits_title_length check (title is null or char_length(title) <= 120),
  add constraint visits_text_length check (
    coalesce(char_length(symptoms), 0) <= 2000 and coalesce(char_length(diagnosis), 0) <= 2000
    and coalesce(char_length(doctor_notes), 0) <= 2000 and coalesce(char_length(advice), 0) <= 2000);
create unique index visits_queue_token_key on public.visits (queue_token_id) where queue_token_id is not null;
create index if not exists idx_visits_doctor on public.visits (doctor_id);
create index if not exists idx_visits_clinic on public.visits (clinic_id);

-- ---------------------------------------------------------------------------------------------------------------
-- prescriptions: one per visit
-- ---------------------------------------------------------------------------------------------------------------
alter table public.prescriptions
  add column if not exists updated_at timestamptz not null default now(),
  add constraint prescriptions_medicines_array check (jsonb_typeof(medicines) = 'array' and jsonb_array_length(medicines) <= 30),
  add constraint prescriptions_instructions_length check (instructions is null or char_length(instructions) <= 2000);
create unique index prescriptions_visit_key on public.prescriptions (visit_id);
create index if not exists idx_prescriptions_patient on public.prescriptions (patient_id);
create index if not exists idx_prescriptions_doctor on public.prescriptions (doctor_id);
create index if not exists idx_prescriptions_clinic on public.prescriptions (clinic_id);

-- ---------------------------------------------------------------------------------------------------------------
-- patient_reports: files live in the private storage bucket; this table holds only the path
-- ---------------------------------------------------------------------------------------------------------------
alter table public.patient_reports
  add column if not exists uploaded_by uuid references auth.users (id) on delete set null,
  add column if not exists content_type text,
  add column if not exists size_bytes bigint,
  add constraint patient_reports_name_length check (char_length(btrim(report_name)) between 1 and 120),
  add constraint patient_reports_size_range check (size_bytes is null or size_bytes between 1 and 15728640),
  add constraint patient_reports_path_in_clinic check (file_path like clinic_id::text || '/%');
create unique index patient_reports_file_path_key on public.patient_reports (file_path);
create index if not exists idx_reports_visit on public.patient_reports (visit_id);
create index if not exists idx_reports_clinic on public.patient_reports (clinic_id);
create index if not exists idx_reports_uploaded_by on public.patient_reports (uploaded_by);

-- ---------------------------------------------------------------------------------------------------------------
-- audit_log: the 13th table. Written only by private.audit(), read only by the clinic owner.
-- ---------------------------------------------------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  clinic_id uuid references public.clinics (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  actor_role text,
  action text not null check (char_length(action) between 3 and 60),
  entity_type text,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.audit_log enable row level security;
create index idx_audit_clinic_time on public.audit_log (clinic_id, created_at desc);
create index idx_audit_actor on public.audit_log (actor_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Keep updated_at honest
-- ---------------------------------------------------------------------------------------------------------------
create function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['clinics', 'clinic_settings', 'doctors', 'patients', 'appointments', 'queue_tokens', 'visits',
                           'prescriptions', 'profiles']
  loop
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- A profile row is created for every new sign in
-- ---------------------------------------------------------------------------------------------------------------
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''), new.email)
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();
