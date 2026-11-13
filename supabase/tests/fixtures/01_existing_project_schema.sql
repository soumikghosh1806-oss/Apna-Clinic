-- The schema that the connected project already had before any Cliniq migration, rebuilt from its catalog
-- (columns, constraints, indexes, policies, helper functions). Test fixture only. It is never applied to a real project.

create table public.profiles (
  id uuid primary key,
  full_name text,
  phone text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint profiles_id_fkey foreign key (id) references auth.users (id) on delete cascade
);

create table public.clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text, email text, address text, city text, state text, pincode text,
  created_by uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint clinics_created_by_fkey foreign key (created_by) references auth.users (id)
);

create table public.clinic_memberships (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  user_id uuid not null,
  role text not null,
  created_at timestamptz default now(),
  constraint clinic_memberships_role_check check (role = any (array['owner','receptionist','doctor'])),
  constraint clinic_memberships_clinic_id_fkey foreign key (clinic_id) references public.clinics (id) on delete cascade,
  constraint clinic_memberships_user_id_fkey foreign key (user_id) references public.profiles (id) on delete cascade,
  constraint clinic_memberships_clinic_id_user_id_key unique (clinic_id, user_id)
);
create index idx_memberships_user on public.clinic_memberships (user_id);

create table public.clinic_settings (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  online_booking_enabled boolean default true,
  daily_token_limit integer default 100,
  average_consultation_minutes integer default 10,
  clinic_open_time time, clinic_close_time time,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint clinic_settings_average_consultation_minutes_check check (average_consultation_minutes > 0),
  constraint clinic_settings_daily_token_limit_check check (daily_token_limit > 0),
  constraint clinic_settings_clinic_id_fkey foreign key (clinic_id) references public.clinics (id) on delete cascade,
  constraint clinic_settings_clinic_id_key unique (clinic_id)
);

create table public.doctors (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  profile_id uuid,
  name text not null,
  specialization text, qualification text, phone text,
  consultation_fee numeric(10,2) default 0,
  is_active boolean default true,
  created_at timestamptz default now(),
  constraint doctors_clinic_id_fkey foreign key (clinic_id) references public.clinics (id) on delete cascade,
  constraint doctors_profile_id_fkey foreign key (profile_id) references public.profiles (id)
);
create index idx_doctors_clinic on public.doctors (clinic_id);

create table public.doctor_schedules (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  doctor_id uuid not null,
  day_of_week integer not null,
  start_time time not null,
  end_time time not null,
  is_available boolean default true,
  created_at timestamptz default now(),
  constraint doctor_schedules_check check (end_time > start_time),
  constraint doctor_schedules_day_of_week_check check (day_of_week >= 0 and day_of_week <= 6),
  constraint doctor_schedules_clinic_id_fkey foreign key (clinic_id) references public.clinics (id) on delete cascade,
  constraint doctor_schedules_doctor_id_fkey foreign key (doctor_id) references public.doctors (id) on delete cascade
);
create index idx_schedule_doctor on public.doctor_schedules (doctor_id, day_of_week);

create table public.patients (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  name text not null,
  phone text, age integer, gender text, address text, date_of_birth date,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint patients_age_check check (age is null or age >= 0),
  constraint patients_clinic_id_fkey foreign key (clinic_id) references public.clinics (id) on delete cascade
);
create index idx_patients_clinic_phone on public.patients (clinic_id, phone);

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  patient_id uuid not null,
  doctor_id uuid not null,
  appointment_date date not null,
  appointment_time time,
  booking_source text default 'online',
  status text default 'booked',
  notes text,
  created_at timestamptz default now(),
  constraint appointments_booking_source_check check (booking_source = any (array['online','walk_in','staff'])),
  constraint appointments_status_check check (status = any (array['booked','confirmed','cancelled','completed','no_show'])),
  constraint appointments_clinic_id_fkey foreign key (clinic_id) references public.clinics (id) on delete cascade,
  constraint appointments_doctor_id_fkey foreign key (doctor_id) references public.doctors (id),
  constraint appointments_patient_id_fkey foreign key (patient_id) references public.patients (id)
);
create index idx_appointments_date on public.appointments (clinic_id, appointment_date);

create table public.queue_tokens (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  patient_id uuid not null,
  doctor_id uuid not null,
  appointment_id uuid,
  token_number integer not null,
  queue_date date not null default current_date,
  status text not null default 'waiting',
  estimated_time timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint queue_tokens_status_check check (status = any (array['waiting','arrived','serving','completed','skipped','cancelled','no_show','on_hold'])),
  constraint queue_tokens_appointment_id_fkey foreign key (appointment_id) references public.appointments (id),
  constraint queue_tokens_clinic_id_fkey foreign key (clinic_id) references public.clinics (id) on delete cascade,
  constraint queue_tokens_doctor_id_fkey foreign key (doctor_id) references public.doctors (id),
  constraint queue_tokens_patient_id_fkey foreign key (patient_id) references public.patients (id),
  constraint queue_tokens_clinic_id_doctor_id_queue_date_token_number_key unique (clinic_id, doctor_id, queue_date, token_number)
);
create index idx_queue_date_status on public.queue_tokens (clinic_id, queue_date, status);
create index idx_queue_doctor_date on public.queue_tokens (doctor_id, queue_date, token_number);

create table public.visits (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  patient_id uuid not null,
  doctor_id uuid not null,
  queue_token_id uuid,
  visit_date timestamptz default now(),
  symptoms text, diagnosis text, doctor_notes text, advice text,
  created_at timestamptz default now(),
  constraint visits_clinic_id_fkey foreign key (clinic_id) references public.clinics (id) on delete cascade,
  constraint visits_doctor_id_fkey foreign key (doctor_id) references public.doctors (id),
  constraint visits_patient_id_fkey foreign key (patient_id) references public.patients (id),
  constraint visits_queue_token_id_fkey foreign key (queue_token_id) references public.queue_tokens (id)
);
create index idx_visits_patient on public.visits (patient_id, visit_date desc);

create table public.prescriptions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  visit_id uuid not null,
  patient_id uuid not null,
  doctor_id uuid not null,
  medicines jsonb not null default '[]'::jsonb,
  instructions text,
  created_at timestamptz default now(),
  constraint prescriptions_clinic_id_fkey foreign key (clinic_id) references public.clinics (id) on delete cascade,
  constraint prescriptions_doctor_id_fkey foreign key (doctor_id) references public.doctors (id),
  constraint prescriptions_patient_id_fkey foreign key (patient_id) references public.patients (id),
  constraint prescriptions_visit_id_fkey foreign key (visit_id) references public.visits (id) on delete cascade
);

create table public.patient_reports (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  patient_id uuid not null,
  visit_id uuid,
  report_name text not null,
  file_path text not null,
  uploaded_at timestamptz default now(),
  constraint patient_reports_clinic_id_fkey foreign key (clinic_id) references public.clinics (id) on delete cascade,
  constraint patient_reports_patient_id_fkey foreign key (patient_id) references public.patients (id),
  constraint patient_reports_visit_id_fkey foreign key (visit_id) references public.visits (id)
);
create index idx_reports_patient on public.patient_reports (patient_id);

-- The helper functions the existing policies call.
create function public.is_clinic_manager(target_clinic uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.clinic_memberships m
    where m.clinic_id = target_clinic and m.user_id = (select auth.uid()) and m.role in ('owner', 'receptionist'));
$$;
create function public.is_clinic_member(target_clinic uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.clinic_memberships m
    where m.clinic_id = target_clinic and m.user_id = (select auth.uid()));
$$;
create function public.is_clinic_owner(target_clinic uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.clinic_memberships m
    where m.clinic_id = target_clinic and m.user_id = (select auth.uid()) and m.role = 'owner');
$$;

-- The project's own event trigger that switches RLS on for new public tables.
create function public.rls_auto_enable() returns event_trigger language plpgsql security definer set search_path to 'pg_catalog' as $$
declare cmd record; tbl name;
begin
  for cmd in select * from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') and object_type in ('table', 'partitioned table')
  loop
    if cmd.schema_name is not null and cmd.schema_name in ('public') then
      begin
        select c.relname into tbl from pg_catalog.pg_class c where c.oid = cmd.objid;
        execute format('alter table if exists %I.%I enable row level security', cmd.schema_name, tbl);
      exception when others then raise log 'rls_auto_enable: failed on %', cmd.object_identity;
      end;
    end if;
  end loop;
end $$;
create event trigger ensure_rls on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') execute function public.rls_auto_enable();

alter table public.appointments enable row level security;
alter table public.clinic_memberships enable row level security;
alter table public.clinic_settings enable row level security;
alter table public.clinics enable row level security;
alter table public.doctor_schedules enable row level security;
alter table public.doctors enable row level security;
alter table public.patient_reports enable row level security;
alter table public.patients enable row level security;
alter table public.prescriptions enable row level security;
alter table public.profiles enable row level security;
alter table public.queue_tokens enable row level security;
alter table public.visits enable row level security;

-- Policies exactly as the project has them today.
create policy "Managers can manage appointments" on public.appointments for all to authenticated using (is_clinic_manager(clinic_id)) with check (is_clinic_manager(clinic_id));
create policy "Members can view appointments" on public.appointments for select to authenticated using (is_clinic_member(clinic_id));
create policy "Members can view clinic memberships" on public.clinic_memberships for select to authenticated using (is_clinic_member(clinic_id));
create policy "Owners can add memberships" on public.clinic_memberships for insert to authenticated with check (is_clinic_owner(clinic_id));
create policy "Owners can remove memberships" on public.clinic_memberships for delete to authenticated using (is_clinic_owner(clinic_id));
create policy "Owners can update memberships" on public.clinic_memberships for update to authenticated using (is_clinic_owner(clinic_id)) with check (is_clinic_owner(clinic_id));
create policy "Members can view clinic settings" on public.clinic_settings for select to authenticated using (is_clinic_member(clinic_id));
create policy "Owners can manage clinic settings" on public.clinic_settings for all to authenticated using (is_clinic_owner(clinic_id)) with check (is_clinic_owner(clinic_id));
create policy "Members can view their clinics" on public.clinics for select to authenticated using (is_clinic_member(id));
create policy "Owners can update their clinics" on public.clinics for update to authenticated using (is_clinic_owner(id)) with check (is_clinic_owner(id));
create policy "Managers can manage doctor schedules" on public.doctor_schedules for all to authenticated using (is_clinic_manager(clinic_id)) with check (is_clinic_manager(clinic_id));
create policy "Members can view doctor schedules" on public.doctor_schedules for select to authenticated using (is_clinic_member(clinic_id));
create policy "Managers can manage doctors" on public.doctors for all to authenticated using (is_clinic_manager(clinic_id)) with check (is_clinic_manager(clinic_id));
create policy "Members can view doctors" on public.doctors for select to authenticated using (is_clinic_member(clinic_id));
create policy "Managers can manage patient reports" on public.patient_reports for all to authenticated using (is_clinic_manager(clinic_id)) with check (is_clinic_manager(clinic_id));
create policy "Members can view patient reports" on public.patient_reports for select to authenticated using (is_clinic_member(clinic_id));
create policy "Managers can manage patients" on public.patients for all to authenticated using (is_clinic_manager(clinic_id)) with check (is_clinic_manager(clinic_id));
create policy "Members can view patients" on public.patients for select to authenticated using (is_clinic_member(clinic_id));
create policy "Doctors can manage prescriptions" on public.prescriptions for all to authenticated
  using (is_clinic_member(clinic_id) and exists (select 1 from public.doctors d where d.id = prescriptions.doctor_id and d.profile_id = (select auth.uid())))
  with check (is_clinic_member(clinic_id) and exists (select 1 from public.doctors d where d.id = prescriptions.doctor_id and d.profile_id = (select auth.uid())));
create policy "Members can view prescriptions" on public.prescriptions for select to authenticated using (is_clinic_member(clinic_id));
create policy "Users can insert own profile" on public.profiles for insert to authenticated with check (id = (select auth.uid()));
create policy "Users can update own profile" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "Users can view own profile" on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "Managers can manage queue" on public.queue_tokens for all to authenticated using (is_clinic_manager(clinic_id)) with check (is_clinic_manager(clinic_id));
create policy "Members can view queue" on public.queue_tokens for select to authenticated using (is_clinic_member(clinic_id));
create policy "Doctors can create visits" on public.visits for insert to authenticated with check (
  is_clinic_member(clinic_id) and exists (select 1 from public.clinic_memberships m join public.doctors d on d.profile_id = m.user_id
    where m.clinic_id = visits.clinic_id and m.user_id = (select auth.uid()) and m.role = 'doctor' and d.id = visits.doctor_id));
create policy "Doctors can update their visits" on public.visits for update to authenticated
  using (is_clinic_member(clinic_id) and exists (select 1 from public.doctors d where d.id = visits.doctor_id and d.profile_id = (select auth.uid())))
  with check (is_clinic_member(clinic_id));
create policy "Members can view visits" on public.visits for select to authenticated using (is_clinic_member(clinic_id));
