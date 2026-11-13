-- Cliniq migration 5 of 5: live updates, private file storage, and the final list of who may call what.

-- ---------------------------------------------------------------------------------------------------------------
-- Live updates. Any change to a token sends a small "something changed" signal on the clinic's channel.
-- The signal carries no patient data (only the doctor id). Screens react by asking the functions above for fresh
-- data, which applies the same access rules as everything else. A failed signal never blocks the queue change.
-- ---------------------------------------------------------------------------------------------------------------
create function private.broadcast_queue_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(
    jsonb_build_object('doctor_id', coalesce(new.doctor_id, old.doctor_id)),
    'queue_changed',
    'queue:' || coalesce(new.clinic_id, old.clinic_id)::text,
    false);
  return null;
exception when others then
  return null;
end $$;

create trigger queue_broadcast after insert or update on public.queue_tokens
  for each row execute function private.broadcast_queue_change();

-- ---------------------------------------------------------------------------------------------------------------
-- Private storage for medical report files. Path: <clinic id>/<patient id>/<file>.
-- Only doctors of that clinic can add or open files. Nothing is public. Links are short lived signed links.
-- ---------------------------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('patient-reports', 'patient-reports', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create function private.can_use_report_path(p_name text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_parts text[] := string_to_array(coalesce(p_name, ''), '/');
begin
  if array_length(v_parts, 1) is distinct from 3 or v_parts[3] = '' then return false; end if;
  if v_parts[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_parts[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return private.is_clinic_doctor(v_parts[1]::uuid)
     and exists (select 1 from public.patients p where p.id = v_parts[2]::uuid and p.clinic_id = v_parts[1]::uuid);
end $$;

create policy "Doctors add reports to their clinic" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'patient-reports' and private.can_use_report_path(name));

create policy "Doctors read reports of their clinic" on storage.objects
  for select to authenticated
  using (bucket_id = 'patient-reports' and private.can_use_report_path(name));
-- No update or delete policy: report files cannot be changed or removed from the browser.

-- ---------------------------------------------------------------------------------------------------------------
-- Who may call which function. Nothing is callable unless it is listed here.
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prokind = 'f'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- Needed by row level security policies and storage policies, which run as the signed in user.
grant execute on function private.member_role(uuid), private.is_clinic_member(uuid), private.is_clinic_manager(uuid),
  private.is_clinic_owner(uuid), private.is_clinic_doctor(uuid), private.can_use_report_path(text) to authenticated;

-- Public: patients and the waiting room display.
grant execute on function
  public.get_public_clinic(text),
  public.book_token(text, text, text, uuid, date),
  public.get_my_token(uuid),
  public.cancel_my_token(uuid),
  public.get_public_queue(text, uuid, date)
to anon, authenticated;

-- Signed in staff. Each function checks the caller's role in the clinic itself.
grant execute on function
  public.register_clinic(text, text, text, text, text, text, text),
  public.my_clinics(),
  public.get_staff_snapshot(uuid),
  public.add_walk_in(uuid, text, text, uuid, boolean),
  public.mark_arrived(uuid),
  public.mark_no_show(uuid),
  public.requeue_token(uuid),
  public.complete_token(uuid),
  public.skip_token(uuid),
  public.hold_token(uuid),
  public.resume_token(uuid),
  public.call_next(uuid, uuid),
  public.search_patients(uuid, text),
  public.get_patient_visit_list(uuid, uuid),
  public.get_patient_history(uuid, uuid),
  public.save_visit(uuid, uuid, uuid, text, text, text, date, text, text),
  public.save_prescription(uuid, uuid, jsonb, text),
  public.register_report(uuid, uuid, uuid, text, text, text, bigint),
  public.authorize_report_download(uuid),
  public.update_clinic_settings(uuid, text, boolean, integer, integer, integer),
  public.add_doctor(uuid, text, text, jsonb, integer, integer),
  public.update_doctor(uuid, uuid, text, text, jsonb, integer, integer),
  public.remove_doctor(uuid, uuid),
  public.list_staff(uuid),
  public.set_staff_active(uuid, uuid, boolean),
  public.get_report_series(uuid, date, uuid),
  public.get_report_month(uuid, date, uuid)
to authenticated;

-- Server side only: the invite-staff Edge Function, using the project's secret key.
grant execute on function public.attach_staff(uuid, uuid, text, uuid, uuid, text) to service_role;

-- Safety check. If anything outside the lists above is callable by the public or by signed in users,
-- this migration fails and nothing is applied.
do $$
declare f record; v_bad text := '';
begin
  for f in
    select p.oid, p.oid::regprocedure::text as sig, p.proname, n.nspname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prokind = 'f'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    if has_function_privilege('anon', f.oid, 'execute')
       and f.proname not in ('get_public_clinic', 'book_token', 'get_my_token', 'cancel_my_token', 'get_public_queue') then
      v_bad := v_bad || ' anon:' || f.sig;
    end if;
    if has_function_privilege('authenticated', f.oid, 'execute') and f.nspname = 'public'
       and f.proname in ('attach_staff', 'rls_auto_enable') then
      v_bad := v_bad || ' authenticated:' || f.sig;
    end if;
  end loop;
  if v_bad <> '' then raise exception 'Unexpected function access:%', v_bad; end if;
end $$;
