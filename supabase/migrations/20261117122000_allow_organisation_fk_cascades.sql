-- Permit FK-driven cleanup of a whole organisation while retaining
-- protection for direct membership and owner-role changes.
--
-- PostgreSQL executes referential-action triggers at a nested trigger depth.
-- The guards may be bypassed only for those nested cascade operations; direct
-- DELETE/UPDATE statements still execute at depth 1 and remain protected.

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
  -- A whole-organisation delete cascades into memberships. This is not an
  -- administrator removing the final owner while keeping the organisation.
  if pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  select exists (
    select 1
    from public.organisation_roles r
    where r.organisation_id = old.organisation_id
      and r.id = old.role_id
      and r.key = 'owner'
  ) into owner_role;

  if not owner_role or old.status <> 'active' then
    if tg_op = 'DELETE' then return old; end if;
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

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.protect_owner_role_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- Allow only nested FK cascades (e.g. deleting the organisation itself).
  if pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if old.key = 'owner' then
    if tg_op = 'DELETE'
      or new.key <> old.key
      or new.organisation_id <> old.organisation_id
    then
      raise exception using
        errcode = '23514',
        message = 'The organisation owner role identity cannot be deleted or reassigned.',
        constraint = 'organisation_owner_role_identity';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.prevent_last_active_owner_removal()
  from public, anon, authenticated;
revoke all on function public.protect_owner_role_identity()
  from public, anon, authenticated;

commit;
