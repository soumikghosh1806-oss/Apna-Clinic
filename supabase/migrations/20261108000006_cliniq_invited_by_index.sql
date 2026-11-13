-- Cliniq migration 6: covers the one foreign key the performance check found without an index.
create index if not exists idx_memberships_invited_by on public.clinic_memberships (invited_by);
