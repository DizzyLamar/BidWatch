-- Serialize organisation ownership changes in the database.
--
-- The API performs a friendly preflight check, but that check alone races when
-- two administrators concurrently demote/suspend/remove different owners.
-- Locking the parent organisation row makes every owner-removal transaction
-- for one organisation run in a single order before checking the remaining
-- active owners.

begin;

create or replace function public.prevent_last_active_owner_removal()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  owner_role boolean;
  remaining_owner_count bigint;
begin
  select exists (
    select 1
    from public.organisation_roles r
    where r.organisation_id = old.organisation_id
      and r.id = old.role_id
      and r.key = 'owner'
  ) into owner_role;

  if not owner_role or old.status <> 'active' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE'
    and new.organisation_id = old.organisation_id
    and new.status = 'active'
    and exists (
      select 1
      from public.organisation_roles r
      where r.organisation_id = new.organisation_id
        and r.id = new.role_id
        and r.key = 'owner'
    )
  then
    return new;
  end if;

  -- All owner exits for an organisation serialize on this stable parent row.
  perform 1
  from public.organisations o
  where o.id = old.organisation_id
  for update;

  select count(*)
    into remaining_owner_count
  from public.organisation_members m
  join public.organisation_roles r
    on r.organisation_id = m.organisation_id
   and r.id = m.role_id
  where m.organisation_id = old.organisation_id
    and m.status = 'active'
    and r.key = 'owner'
    and m.id <> old.id;

  if remaining_owner_count = 0 then
    raise exception using
      errcode = '23514',
      message = 'The last active organisation owner cannot be demoted, suspended, or removed.',
      constraint = 'organisation_members_last_active_owner';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists organisation_members_last_active_owner
  on public.organisation_members;

create trigger organisation_members_last_active_owner
before update of organisation_id, role_id, status or delete
on public.organisation_members
for each row
execute function public.prevent_last_active_owner_removal();

create or replace function public.protect_owner_role_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.key = 'owner' and (
    tg_op = 'DELETE'
    or new.key <> old.key
    or new.organisation_id <> old.organisation_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'The organisation owner role identity cannot be deleted or reassigned.',
      constraint = 'organisation_owner_role_identity';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists organisation_roles_protect_owner_identity
  on public.organisation_roles;

create trigger organisation_roles_protect_owner_identity
before update of key, organisation_id or delete
on public.organisation_roles
for each row
execute function public.protect_owner_role_identity();

revoke all on function public.prevent_last_active_owner_removal() from public, anon, authenticated;
revoke all on function public.protect_owner_role_identity() from public, anon, authenticated;

commit;
