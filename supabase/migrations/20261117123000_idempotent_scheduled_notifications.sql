-- Make scheduled deadline notifications idempotent under concurrent cron runs.
-- The lock key is scoped to one organisation, tender, recipient, reminder kind,
-- and UTC calendar day so separate tenants cannot collide.

begin;

create or replace function public.create_notification_once(
  p_organisation_id uuid,
  p_record jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_tender_id text := nullif(p_record->>'tenderId', '');
  v_user_id uuid := nullif(p_record->>'userId', '')::uuid;
  v_kind text := nullif(p_record->>'kind', '');
  v_created_at text := nullif(p_record->>'createdAt', '');
  v_day text;
  v_org_status text;
begin
  if p_organisation_id is null
    or v_tender_id is null
    or v_user_id is null
    or v_kind is null
    or v_created_at is null
    or jsonb_typeof(p_record) <> 'object'
  then
    raise exception 'A valid organisation and notification record are required.'
      using errcode = '22023';
  end if;

  v_day := left(v_created_at, 10);
  if v_day !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Notification createdAt must be an ISO date.'
      using errcode = '22023';
  end if;

  select o.status into v_org_status
  from public.organisations o
  where o.id = p_organisation_id;

  if v_org_status is distinct from 'active' then
    return false;
  end if;

  if not exists (
    select 1
    from public.organisation_members m
    where m.organisation_id = p_organisation_id
      and m.user_id = v_user_id
      and m.status = 'active'
  ) then
    return false;
  end if;

  if not exists (
    select 1
    from public.app_records t
    where t.id::text = v_tender_id
      and t.table_name = 'tenders'
      and t.scope_type = 'organisation'
      and t.organisation_id = p_organisation_id
  ) then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_organisation_id::text || '|' || v_tender_id || '|' ||
    v_user_id::text || '|' || v_kind || '|' || v_day,
    0
  ));

  if exists (
    select 1
    from public.app_records n
    where n.table_name = 'notifications'
      and n.scope_type = 'organisation'
      and n.organisation_id = p_organisation_id
      and n.record->>'tenderId' = v_tender_id
      and n.record->>'userId' = v_user_id::text
      and n.record->>'kind' = v_kind
      and left(n.record->>'createdAt', 10) = v_day
  ) then
    return false;
  end if;

  insert into public.app_records (table_name, record, scope_type, organisation_id)
  values ('notifications', p_record, 'organisation', p_organisation_id);

  return true;
end;
$$;

revoke all on function public.create_notification_once(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_notification_once(uuid, jsonb)
  to service_role;

commit;
