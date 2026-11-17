-- Allow organisation deletion to cascade through memberships while preserving
-- the last-owner invariant for direct membership changes.
--
-- PostgreSQL executes ON DELETE CASCADE after the parent organisation row has
-- been removed. In that case there is no longer a tenant to protect, so the
-- membership trigger must allow the cascade. Direct member deletion still sees
-- the parent row and remains protected.

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

  -- Serialize owner exits only while the organisation still exists. During
  -- an ON DELETE CASCADE the parent row is already gone, and blocking that
  -- cascade would make organisation deletion impossible.
  perform 1
  from public.organisations o
  where o.id = old.organisation_id
  for update;

  if not exists (
    select 1 from public.organisations o
    where o.id = old.organisation_id
  ) then
    return old;
  end if;

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

revoke all on function public.prevent_last_active_owner_removal()
  from public, anon, authenticated;

commit;
