-- Preserve the immutable owner-role identity during ordinary edits, but
-- permit PostgreSQL to cascade-delete that role when its organisation is
-- intentionally deleted.

begin;

create or replace function public.protect_owner_role_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.key = 'owner' then
    if tg_op = 'DELETE' then
      if not exists (
        select 1 from public.organisations o
        where o.id = old.organisation_id
      ) then
        return old;
      end if;

      raise exception using
        errcode = '23514',
        message = 'The organisation owner role identity cannot be deleted or reassigned.',
        constraint = 'organisation_owner_role_identity';
    end if;

    if new.key <> old.key or new.organisation_id <> old.organisation_id then
      raise exception using
        errcode = '23514',
        message = 'The organisation owner role identity cannot be deleted or reassigned.',
        constraint = 'organisation_owner_role_identity';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.protect_owner_role_identity()
  from public, anon, authenticated;

commit;
