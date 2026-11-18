-- Phase 2A: shared procurement intelligence and tenant-owned opportunity pursuits.
--
-- Additive schema only. No legacy opportunity rows are migrated and no
-- application read/write paths are switched by this migration.
-- All tables are backend-only; authenticated browser clients receive no grants.

begin;

create table public.procurement_sources (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  name text not null,
  base_url text,
  adapter_key text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint procurement_sources_key_nonempty check (length(btrim(source_key)) > 0),
  constraint procurement_sources_name_nonempty check (length(btrim(name)) > 0),
  constraint procurement_sources_adapter_nonempty check (length(btrim(adapter_key)) > 0),
  constraint procurement_sources_status_check check (status in ('active', 'paused', 'retired'))
);

create table public.procurement_source_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.procurement_sources(id) on delete restrict,
  scan_type text not null default 'manual',
  status text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  fetched_count integer not null default 0,
  parsed_count integer not null default 0,
  relevant_count integer not null default 0,
  failed_count integer not null default 0,
  error_code text,
  safe_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint procurement_source_runs_scan_type_check check (scan_type in ('scheduled', 'manual', 'backfill')),
  constraint procurement_source_runs_status_check check (status in ('running', 'ok', 'partial', 'authentication_required', 'error')),
  constraint procurement_source_runs_counts_nonnegative check (
    fetched_count >= 0 and parsed_count >= 0 and relevant_count >= 0 and failed_count >= 0
  ),
  constraint procurement_source_runs_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint procurement_source_runs_completion_check check (completed_at is null or completed_at >= started_at)
);

create table public.procurement_source_observations (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.procurement_sources(id) on delete restrict,
  source_key text not null,
  external_id text,
  reference text,
  source_url text not null,
  title text not null,
  buyer_name text,
  published_at timestamptz,
  deadline_at timestamptz,
  notice_type text,
  procurement_method text,
  description text,
  document_links jsonb not null default '[]'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  content_hash text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  source_status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint procurement_observations_source_key_unique unique (source_id, source_key),
  constraint procurement_observations_source_key_nonempty check (length(btrim(source_key)) > 0),
  constraint procurement_observations_url_nonempty check (length(btrim(source_url)) > 0),
  constraint procurement_observations_title_nonempty check (length(btrim(title)) > 0),
  constraint procurement_observations_hash_nonempty check (length(btrim(content_hash)) > 0),
  constraint procurement_observations_document_links_array check (jsonb_typeof(document_links) = 'array'),
  constraint procurement_observations_raw_payload_object check (jsonb_typeof(raw_payload) = 'object'),
  constraint procurement_observations_status_check check (source_status in ('active', 'not_seen', 'withdrawn', 'unknown')),
  constraint procurement_observations_seen_order_check check (last_seen_at >= first_seen_at)
);

create table public.procurement_observation_versions (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references public.procurement_source_observations(id) on delete restrict,
  source_run_id uuid references public.procurement_source_runs(id) on delete set null,
  version_no integer not null,
  content_hash text not null,
  snapshot jsonb not null,
  observed_at timestamptz not null default now(),
  constraint procurement_observation_versions_number_check check (version_no > 0),
  constraint procurement_observation_versions_snapshot_object check (jsonb_typeof(snapshot) = 'object'),
  constraint procurement_observation_versions_hash_nonempty check (length(btrim(content_hash)) > 0),
  constraint procurement_observation_versions_number_unique unique (observation_id, version_no),
  constraint procurement_observation_versions_hash_unique unique (observation_id, content_hash)
);

create table public.canonical_opportunities (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  title text not null,
  buyer_name text,
  reference text,
  published_at timestamptz,
  deadline_at timestamptz,
  description text,
  notice_type text,
  procurement_method text,
  lifecycle_status text not null default 'unknown',
  canonical_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint canonical_opportunities_key_nonempty check (length(btrim(canonical_key)) > 0),
  constraint canonical_opportunities_title_nonempty check (length(btrim(title)) > 0),
  constraint canonical_opportunities_status_check check (lifecycle_status in ('open', 'closed', 'cancelled', 'awarded', 'unknown'))
);

create table public.canonical_opportunity_sources (
  id uuid primary key default gen_random_uuid(),
  canonical_opportunity_id uuid not null references public.canonical_opportunities(id) on delete restrict,
  observation_id uuid not null references public.procurement_source_observations(id) on delete restrict,
  match_method text not null,
  match_confidence numeric(5,4),
  review_status text not null default 'automatic',
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint canonical_opportunity_sources_method_check check (
    match_method in ('same_source_reference', 'exact_url', 'external_identifier', 'content_hash', 'reviewed_manual')
  ),
  constraint canonical_opportunity_sources_confidence_check check (
    match_confidence is null or (match_confidence >= 0 and match_confidence <= 1)
  ),
  constraint canonical_opportunity_sources_review_check check (
    review_status in ('automatic', 'pending_review', 'confirmed', 'rejected')
  ),
  constraint canonical_opportunity_sources_reviewed_at_check check (
    (reviewed_at is null and reviewed_by is null)
    or (reviewed_at is not null)
  )
);

-- An observation can belong to at most one active/accepted canonical grouping.
-- Rejected candidate links remain in the audit trail but do not block a later,
-- separately reviewed assignment.
create unique index canonical_opportunity_sources_active_observation_uidx
  on public.canonical_opportunity_sources (observation_id)
  where review_status in ('automatic', 'pending_review', 'confirmed');

create table public.organisation_opportunities (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  canonical_opportunity_id uuid not null references public.canonical_opportunities(id) on delete restrict,
  state text not null default 'new',
  fit_level text,
  relevance_score numeric(5,2),
  classification_version text,
  matched_categories jsonb not null default '[]'::jsonb,
  matched_terms jsonb not null default '[]'::jsonb,
  classification_reason text,
  owner_user_id uuid,
  dismissed_at timestamptz,
  converted_tender_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organisation_opportunities_org_canonical_unique unique (organisation_id, canonical_opportunity_id),
  constraint organisation_opportunities_owner_membership_fk
    foreign key (organisation_id, owner_user_id)
    references public.organisation_members (organisation_id, user_id)
    on delete set null (owner_user_id),
  constraint organisation_opportunities_state_check check (
    state in ('new', 'watching', 'qualifying', 'pursuing', 'dismissed', 'converted')
  ),
  constraint organisation_opportunities_fit_check check (
    fit_level is null or fit_level in ('direct', 'partner', 'peripheral')
  ),
  constraint organisation_opportunities_score_check check (
    relevance_score is null or (relevance_score >= 0 and relevance_score <= 100)
  ),
  constraint organisation_opportunities_categories_array check (jsonb_typeof(matched_categories) = 'array'),
  constraint organisation_opportunities_terms_array check (jsonb_typeof(matched_terms) = 'array'),
  constraint organisation_opportunities_dismissed_check check (
    (state = 'dismissed' and dismissed_at is not null)
    or (state <> 'dismissed')
  )
);

create index procurement_source_runs_source_started_idx
  on public.procurement_source_runs (source_id, started_at desc);

create index procurement_observations_source_seen_idx
  on public.procurement_source_observations (source_id, last_seen_at desc);

create index procurement_observations_deadline_idx
  on public.procurement_source_observations (deadline_at)
  where deadline_at is not null;

create index procurement_observation_versions_observed_idx
  on public.procurement_observation_versions (observation_id, observed_at desc);

create index canonical_opportunities_deadline_idx
  on public.canonical_opportunities (deadline_at)
  where deadline_at is not null;

create index canonical_opportunities_buyer_reference_idx
  on public.canonical_opportunities (buyer_name, reference);

create index canonical_opportunity_sources_canonical_idx
  on public.canonical_opportunity_sources (canonical_opportunity_id);

create index organisation_opportunities_org_state_updated_idx
  on public.organisation_opportunities (organisation_id, state, updated_at desc);

create index organisation_opportunities_org_deadline_lookup_idx
  on public.organisation_opportunities (organisation_id, canonical_opportunity_id);

-- These are backend-only tables. RLS remains enabled as defence in depth;
-- no browser-facing policies or anon/authenticated grants are introduced.
alter table public.procurement_sources enable row level security;
alter table public.procurement_source_runs enable row level security;
alter table public.procurement_source_observations enable row level security;
alter table public.procurement_observation_versions enable row level security;
alter table public.canonical_opportunities enable row level security;
alter table public.canonical_opportunity_sources enable row level security;
alter table public.organisation_opportunities enable row level security;

revoke all on table
  public.procurement_sources,
  public.procurement_source_runs,
  public.procurement_source_observations,
  public.procurement_observation_versions,
  public.canonical_opportunities,
  public.canonical_opportunity_sources,
  public.organisation_opportunities
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.procurement_sources,
  public.procurement_source_runs,
  public.procurement_source_observations,
  public.canonical_opportunities,
  public.canonical_opportunity_sources,
  public.organisation_opportunities
to service_role;

-- Source observation versions are append-only for the application service.
revoke all on table public.procurement_observation_versions from public, anon, authenticated, service_role;
grant select, insert on table public.procurement_observation_versions to service_role;

commit;
