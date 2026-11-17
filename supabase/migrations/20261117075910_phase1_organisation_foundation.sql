-- Phase 1: establish the relational organisation boundary.
--
-- This migration is additive. The existing application continues to use
-- app_records while the tenant-aware repository and request context are built.
-- scope_type and organisation_id intentionally remain nullable during this
-- expand-and-contract transition so the currently deployed backend keeps
-- working until it is replaced by code that always supplies an explicit scope.

begin;

-- Fail before changing anything if the live legacy identity/role mapping is
-- not in the shape this migration has been designed and audited against.
do $$
declare
  legacy_user_count integer;
  invalid_user_count integer;
  ambiguous_system_role_count integer;
begin
  select count(*)
    into legacy_user_count
  from public.app_records
  where table_name = 'users';

  if legacy_user_count = 0 then
    raise exception 'Phase 1 migration aborted: no legacy users were found.';
  end if;

  select count(*)
    into invalid_user_count
  from public.app_records u
  where u.table_name = 'users'
    and (
      nullif(u.record->>'userId', '') is null
      or not exists (
        select 1
        from auth.users au
        where au.id::text = u.record->>'userId'
      )
      or nullif(u.record->>'roleId', '') is null
      or not exists (
        select 1
        from public.app_records r
        where r.table_name = 'roles'
          and r.id::text = u.record->>'roleId'
      )
    );

  if invalid_user_count > 0 then
    raise exception
      'Phase 1 migration aborted: % legacy user profile(s) have no valid Auth identity or role mapping.',
      invalid_user_count;
  end if;

  if exists (
    select 1
    from public.app_records r
    where r.table_name = 'roles'
      and (
        nullif(r.record->>'name', '') is null
        or jsonb_typeof(coalesce(r.record->'permissions', '[]'::jsonb)) <> 'array'
        or (
          r.record ? 'system'
          and lower(r.record->>'system') not in ('true', 'false')
        )
      )
  ) then
    raise exception
      'Phase 1 migration aborted: a legacy role has an invalid name, permissions array, or system flag.';
  end if;

  select count(*)
    into ambiguous_system_role_count
  from (
    select r.record->>'name'
    from public.app_records r
    where r.table_name = 'roles'
      and r.record->>'name' in ('Super Admin', 'Bid Manager', 'Member')
    group by r.record->>'name'
    having count(distinct coalesce(r.record->'permissions', '[]'::jsonb)) > 1
  ) conflicting_roles;

  if ambiguous_system_role_count > 0 then
    raise exception
      'Phase 1 migration aborted: a built-in legacy role has conflicting permission definitions.';
  end if;

  if not exists (
    select 1
    from public.app_records u
    join public.app_records r
      on r.table_name = 'roles'
     and r.id::text = u.record->>'roleId'
    where u.table_name = 'users'
      and r.record->>'name' = 'Super Admin'
  ) then
    raise exception
      'Phase 1 migration aborted: no protected Super Admin identity is available to bootstrap platform administration.';
  end if;
end;
$$;

create table public.organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  status text not null default 'active',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organisations_name_nonempty check (length(btrim(name)) > 0),
  constraint organisations_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint organisations_status_check check (status in ('active', 'suspended'))
);

create table public.organisation_roles (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  key text not null,
  name text not null,
  description text,
  permissions jsonb not null default '[]'::jsonb,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organisation_roles_key_nonempty check (length(btrim(key)) > 0),
  constraint organisation_roles_name_nonempty check (length(btrim(name)) > 0),
  constraint organisation_roles_permissions_array check (jsonb_typeof(permissions) = 'array'),
  constraint organisation_roles_org_key_unique unique (organisation_id, key),
  constraint organisation_roles_org_id_unique unique (organisation_id, id)
);

create table public.organisation_members (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role_id uuid not null,
  status text not null default 'invited',
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organisation_members_status_check
    check (status in ('invited', 'active', 'suspended', 'removed')),
  constraint organisation_members_org_user_unique unique (organisation_id, user_id),
  constraint organisation_members_org_role_fk
    foreign key (organisation_id, role_id)
    references public.organisation_roles (organisation_id, id)
    on delete restrict
);

create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create index organisation_members_user_status_idx
  on public.organisation_members (user_id, status, organisation_id);

create index organisation_roles_organisation_idx
  on public.organisation_roles (organisation_id);

-- The first workspace preserves the existing single-workspace installation.
-- Its owner is resolved from the audited Auth/profile relationship, not from
-- a hard-coded email address or user-editable Auth metadata.
insert into public.organisations (name, slug, status, created_by)
values (
  'Legacy BidWatch Workspace',
  'legacy-bidwatch-workspace',
  'active',
  (
    select au.id
    from public.app_records u
    join auth.users au on au.id::text = u.record->>'userId'
    where u.table_name = 'users'
    order by au.created_at nulls last, au.id
    limit 1
  )
);

-- Preserve every distinct legacy role definition. The protected legacy
-- Super Admin role becomes the workspace Owner role; platform-wide authority
-- is represented separately in platform_admins.
with role_candidates as (
  select
    o.id as organisation_id,
    case r.record->>'name'
      when 'Super Admin' then 'owner'
      when 'Bid Manager' then 'bid_manager'
      when 'Member' then 'member'
      else
        'legacy_' || substr(
          md5(
            coalesce(r.record->>'name', '') || '|' ||
            coalesce(r.record->'permissions', '[]'::jsonb)::text
          ),
          1,
          12
        )
    end as role_key,
    case r.record->>'name'
      when 'Super Admin' then 'Owner'
      else r.record->>'name'
    end as role_name,
    case r.record->>'name'
      when 'Super Admin' then 'Full administrative access within this organisation.'
      else nullif(r.record->>'description', '')
    end as role_description,
    coalesce(r.record->'permissions', '[]'::jsonb) as role_permissions,
    coalesce((r.record->>'system')::boolean, false) as role_is_system,
    r.id as legacy_role_id
  from public.app_records r
  cross join public.organisations o
  where r.table_name = 'roles'
    and o.slug = 'legacy-bidwatch-workspace'
),
deduplicated_roles as (
  select distinct on (organisation_id, role_key)
    organisation_id,
    role_key,
    role_name,
    role_description,
    role_permissions,
    role_is_system
  from role_candidates
  order by organisation_id, role_key, legacy_role_id
)
insert into public.organisation_roles (
  organisation_id,
  key,
  name,
  description,
  permissions,
  is_system
)
select
  organisation_id,
  role_key,
  role_name,
  role_description,
  role_permissions,
  role_is_system
from deduplicated_roles
on conflict (organisation_id, key) do nothing;

-- Map each existing provisioned profile to its Auth identity and its
-- organisation-specific role. Membership status, not the legacy global
-- profile flags, becomes the future source of tenant access status.
insert into public.organisation_members (
  organisation_id,
  user_id,
  role_id,
  status,
  joined_at
)
select
  o.id,
  au.id,
  org_role.id,
  case
    when lower(coalesce(u.record->>'status', '')) = 'suspended'
      or lower(coalesce(u.record->>'active', 'true')) in ('false', 'f', '0')
      then 'suspended'
    when lower(coalesce(u.record->>'status', '')) in ('provisioned', 'invited')
      then 'invited'
    else 'active'
  end,
  case
    when lower(coalesce(u.record->>'status', '')) = 'suspended'
      or lower(coalesce(u.record->>'active', 'true')) in ('false', 'f', '0')
      or lower(coalesce(u.record->>'status', '')) in ('provisioned', 'invited')
      then null
    else now()
  end
from public.app_records u
join auth.users au
  on au.id::text = u.record->>'userId'
join public.app_records legacy_role
  on legacy_role.table_name = 'roles'
 and legacy_role.id::text = u.record->>'roleId'
join public.organisations o
  on o.slug = 'legacy-bidwatch-workspace'
join public.organisation_roles org_role
  on org_role.organisation_id = o.id
 and org_role.key = case legacy_role.record->>'name'
   when 'Super Admin' then 'owner'
   when 'Bid Manager' then 'bid_manager'
   when 'Member' then 'member'
   else
     'legacy_' || substr(
       md5(
         coalesce(legacy_role.record->>'name', '') || '|' ||
         coalesce(legacy_role.record->'permissions', '[]'::jsonb)::text
       ),
       1,
       12
     )
 end
where u.table_name = 'users'
on conflict (organisation_id, user_id) do nothing;

-- Preserve platform administration independently from organisation roles.
-- Only profiles explicitly assigned the protected legacy Super Admin role
-- are bootstrapped as platform administrators.
insert into public.platform_admins (user_id, created_by)
select distinct au.id, au.id
from public.app_records u
join auth.users au
  on au.id::text = u.record->>'userId'
join public.app_records legacy_role
  on legacy_role.table_name = 'roles'
 and legacy_role.id::text = u.record->>'roleId'
where u.table_name = 'users'
  and legacy_role.record->>'name' = 'Super Admin'
on conflict (user_id) do nothing;

-- Explicit ownership metadata for the transitional JSONB store.
-- User profiles and shared source-run telemetry remain platform-global.
alter table public.app_records
  add column scope_type text,
  add column organisation_id uuid;

update public.app_records
set
  scope_type = case
    when table_name in ('users', 'opportunity_source_runs') then 'global'
    else 'organisation'
  end,
  organisation_id = case
    when table_name in ('users', 'opportunity_source_runs') then null
    else (
      select id
      from public.organisations
      where slug = 'legacy-bidwatch-workspace'
    )
  end;

alter table public.app_records
  add constraint app_records_scope_type_check
  check (
    (scope_type is null and organisation_id is null)
    or (scope_type = 'global' and organisation_id is null)
    or (scope_type = 'organisation' and organisation_id is not null)
  );

alter table public.app_records
  add constraint app_records_organisation_fk
  foreign key (organisation_id)
  references public.organisations(id)
  on delete restrict;

create index app_records_scope_table_created_idx
  on public.app_records (scope_type, organisation_id, table_name, created_at desc);

-- All tenant foundation tables are backend-only. RLS is enabled as defence
-- in depth; the Express server accesses them with its server-only service key.
-- No anon/authenticated grants or permissive policies are created.
alter table public.organisations enable row level security;
alter table public.organisation_roles enable row level security;
alter table public.organisation_members enable row level security;
alter table public.platform_admins enable row level security;

revoke all on table
  public.organisations,
  public.organisation_roles,
  public.organisation_members,
  public.platform_admins
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.organisations,
  public.organisation_roles,
  public.organisation_members,
  public.platform_admins
to service_role;

-- Fail the migration if any legacy profile was not mapped or any existing
-- app_records row was left without a valid scope assignment.
do $$
declare
  unmapped_user_count integer;
  unscoped_record_count integer;
  invalid_scope_count integer;
begin
  select count(*)
    into unmapped_user_count
  from public.app_records u
  where u.table_name = 'users'
    and not exists (
      select 1
      from public.organisation_members m
      where m.user_id::text = u.record->>'userId'
        and m.organisation_id = (
          select id
          from public.organisations
          where slug = 'legacy-bidwatch-workspace'
        )
    );

  if unmapped_user_count > 0 then
    raise exception
      'Phase 1 migration aborted: % legacy user profile(s) were not mapped to an organisation membership.',
      unmapped_user_count;
  end if;

  select count(*)
    into unscoped_record_count
  from public.app_records
  where scope_type is null or (
    scope_type = 'organisation' and organisation_id is null
  );

  if unscoped_record_count > 0 then
    raise exception
      'Phase 1 migration aborted: % existing app_records row(s) have no valid scope.',
      unscoped_record_count;
  end if;

  select count(*)
    into invalid_scope_count
  from public.app_records
  where
    (table_name in ('users', 'opportunity_source_runs')
      and (scope_type <> 'global' or organisation_id is not null))
    or
    (table_name not in ('users', 'opportunity_source_runs')
      and (scope_type <> 'organisation' or organisation_id is null));

  if invalid_scope_count > 0 then
    raise exception
      'Phase 1 migration aborted: % app_records row(s) have an incorrect global/organisation scope.',
      invalid_scope_count;
  end if;
end;
$$;

commit;
