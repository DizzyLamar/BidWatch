create extension if not exists pgcrypto;

create table if not exists public.app_records (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  record jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists app_records_table_created_idx
  on public.app_records (table_name, created_at);

alter table public.app_records enable row level security;

drop policy if exists "deny direct app record access" on public.app_records;
create policy "deny direct app record access"
  on public.app_records
  for all
  to anon, authenticated
  using (false)
  with check (false);

insert into storage.buckets (id, name, public)
values ('bidwatch', 'bidwatch', false)
on conflict (id) do nothing;

drop policy if exists "deny direct bidwatch storage access" on storage.objects;
create policy "deny direct bidwatch storage access"
  on storage.objects
  for all
  to anon, authenticated
  using (false)
  with check (false);
