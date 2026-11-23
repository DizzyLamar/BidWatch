-- Phase 2B: durable, resumable backfill run and per-record checkpoint ledger.
-- The ledger stores identifiers and sanitized findings only, never raw legacy payloads.
begin;

create table public.legacy_opportunity_backfill_runs (
  id uuid primary key,
  organisation_id uuid not null references public.organisations(id) on delete restrict,
  status text not null default 'running',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  summary jsonb not null default '{}'::jsonb,
  constraint legacy_opportunity_backfill_runs_status_check
    check (status in ('running', 'completed', 'failed')),
  constraint legacy_opportunity_backfill_runs_summary_object
    check (jsonb_typeof(summary) = 'object'),
  constraint legacy_opportunity_backfill_runs_completion_check
    check (completed_at is null or completed_at >= started_at)
);

create unique index legacy_opportunity_backfill_one_active_run_per_org_uidx
  on public.legacy_opportunity_backfill_runs (organisation_id)
  where status = 'running';

create table public.legacy_opportunity_backfill_records (
  legacy_collection text not null,
  legacy_record_id uuid not null,
  run_id uuid not null references public.legacy_opportunity_backfill_runs(id) on delete restrict,
  organisation_id uuid not null references public.organisations(id) on delete restrict,
  status text not null,
  target_ids jsonb not null default '{}'::jsonb,
  findings jsonb not null default '[]'::jsonb,
  processed_at timestamptz not null default now(),
  constraint legacy_opportunity_backfill_records_pk
    primary key (legacy_collection, legacy_record_id),
  constraint legacy_opportunity_backfill_records_collection_check
    check (legacy_collection in ('opportunity_updates', 'opportunity_source_runs', 'opportunity_changes')),
  constraint legacy_opportunity_backfill_records_status_check
    check (status in ('migrated', 'quarantined')),
  constraint legacy_opportunity_backfill_records_targets_object
    check (jsonb_typeof(target_ids) = 'object'),
  constraint legacy_opportunity_backfill_records_findings_array
    check (jsonb_typeof(findings) = 'array')
);

create index legacy_opportunity_backfill_records_run_status_idx
  on public.legacy_opportunity_backfill_records (run_id, status);

alter table public.legacy_opportunity_backfill_runs enable row level security;
alter table public.legacy_opportunity_backfill_records enable row level security;

revoke all on table
  public.legacy_opportunity_backfill_runs,
  public.legacy_opportunity_backfill_records
from public, anon, authenticated;

grant select, insert, update on table
  public.legacy_opportunity_backfill_runs,
  public.legacy_opportunity_backfill_records
to service_role;

commit;
