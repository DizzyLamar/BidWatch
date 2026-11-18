# Phase 2: shared procurement intelligence and organisation-specific pursuits

**Status:** Architecture proposal only  
**Baseline:** Phase 1 tenant foundation deployed to production on 18 November 2026  
**Scope:** Design and test the canonical opportunity model; no production schema or data changes are authorised by this document.

## 1. Why Phase 2 exists

Phase 1 established an organisation boundary around the existing BidWatch workspace. It deliberately kept discovery records in the legacy organisation so tenant isolation could be proven before introducing shared procurement intelligence.

The current discovery implementation stores one `opportunity_updates` record per source identity. It preserves source provenance and change history, then collapses corroborating records for display. That is useful for one workspace, but it conflates three different concepts:

1. A procurement notice published by an external source.
2. A canonical opportunity assembled from one or more source observations.
3. An organisation's decision to monitor, qualify, pursue, dismiss or convert that opportunity into a bid.

Phase 2 separates those concepts. A source scan should not create a separate opportunity for every organisation, and one organisation's decision must never change another organisation's pipeline.

## 2. Product invariants

- Source observations are shared platform intelligence; tenant-owned decisions are not.
- Every canonical opportunity must retain links to its original source observations.
- A source observation is immutable evidence of what a connector saw at a particular time. Corrections create a new observation/version or a linked change event; they do not erase provenance.
- Canonicalisation is a reversible grouping decision, not destructive deduplication.
- A canonical opportunity may have several observations from the same or different sources.
- An organisation may independently watch, qualify, pursue, dismiss or convert the same canonical opportunity.
- One organisation's status, notes, owner, tasks, documents, qualification, or bid conversion is never visible to another organisation.
- The platform must not infer that two notices are identical solely because their titles are similar.
- Uncertain matches remain separate until reviewed or stronger identifiers become available.
- Discovery scans continue to run once at platform scope; organisation-specific matching is computed against each organisation's own configuration.
- Existing bids, bid history, attachments and audit trails remain organisation-owned and are not rewritten into shared discovery records.

## 3. Proposed logical model

Use relational tables for stable identity, joins, uniqueness and query-critical fields. JSONB may hold connector-specific raw payloads and evolving extracted attributes, but must not replace foreign keys or tenant ownership.

### 3.1 `procurement_sources` (platform-global)

Registry of approved source adapters.

Suggested fields:
- `id uuid primary key`
- `key text unique not null` (for example `maneps`, `ppda`)
- `name text not null`
- `base_url text`
- `adapter_key text not null`
- `status text not null` (active, paused, retired)
- `created_at`, `updated_at`

Connector configuration and secrets must remain server-side. Do not store credentials in source metadata or expose them to browser clients.

### 3.2 `procurement_source_runs` (platform-global)

One row per connector execution.

Suggested fields:
- `id uuid primary key`
- `source_id uuid references procurement_sources(id)`
- `scan_type text not null` (scheduled, manual, backfill)
- `status text not null` (ok, partial, authentication_required, error)
- `started_at timestamptz not null`, `completed_at timestamptz`
- `fetched_count integer not null default 0`
- `parsed_count integer not null default 0`
- `relevant_count integer not null default 0`
- `failed_count integer not null default 0`
- `error_code text`, `safe_message text`
- `metadata jsonb not null default '{}'`

A valid zero-result scan must be distinguishable from fetch, authentication, parser and relevance failures.

### 3.3 `procurement_source_observations` (platform-global)

Immutable source evidence. A row represents a notice as extracted from a source at a particular observation time.

Suggested fields:
- `id uuid primary key`
- `source_id uuid not null references procurement_sources(id)`
- `source_run_id uuid references procurement_source_runs(id)`
- `source_key text not null` (stable identity within the source)
- `external_id text`
- `reference text`
- `source_url text not null`
- `title text not null`
- `buyer_name text`
- `published_at timestamptz`
- `deadline_at timestamptz`
- `notice_type text`
- `procurement_method text`
- `description text`
- `document_links jsonb not null default '[]'`
- `raw_payload jsonb not null default '{}'`
- `content_hash text not null`
- `observed_at timestamptz not null`
- `first_seen_at timestamptz not null`
- `last_seen_at timestamptz not null`
- `source_status text not null` (active, not_seen, withdrawn, unknown)
- Unique identity should be based on `(source_id, source_key)`, with a deliberate version/history strategy for changed content.

The implementation must decide whether the table stores only the latest observation plus an append-only `procurement_observation_versions` table, or one row per scan. Prefer an append-only version table if the UI and audit requirements need field-level historical comparison. Do not overwrite the only copy of a prior source payload.

### 3.4 `canonical_opportunities` (platform-global)

Represents the best current platform-level understanding of a procurement opportunity.

Suggested fields:
- `id uuid primary key`
- `canonical_key text unique not null`
- `title text not null`
- `buyer_name text`
- `reference text`
- `published_at timestamptz`
- `deadline_at timestamptz`
- `description text`
- `notice_type text`
- `procurement_method text`
- `lifecycle_status text` (open, closed, cancelled, awarded, unknown)
- `canonical_url text`
- `created_at`, `updated_at`

The canonical row is a curated projection. It must not discard source-specific values. When sources disagree, preserve each value in its observation and record which observation/value was selected for the projection.

### 3.5 `canonical_opportunity_sources` (platform-global join)

Links canonical opportunities to their source observations.

Suggested fields:
- `canonical_opportunity_id uuid references canonical_opportunities(id)`
- `observation_id uuid references procurement_source_observations(id)`
- `match_method text not null` (same_source_reference, exact_url, external_identifier, content_hash, reviewed_manual)
- `match_confidence numeric`
- `review_status text not null` (automatic, pending_review, confirmed, rejected)
- `reviewed_by uuid references auth.users(id)`
- `reviewed_at timestamptz`
- Unique `observation_id` while an observation is actively assigned to one canonical opportunity.

Keep merge/split history. A rejected match must be auditable and must not be recreated by the next scan without a new, explainable signal.

### 3.6 `organisation_opportunities` (tenant-owned)

Represents an organisation's relationship with a canonical opportunity.

Suggested fields:
- `id uuid primary key`
- `organisation_id uuid not null references organisations(id)`
- `canonical_opportunity_id uuid not null references canonical_opportunities(id)`
- `state text not null` (new, watching, qualifying, pursuing, dismissed, converted)
- `fit_level text` (direct, partner, peripheral)
- `relevance_score numeric`
- `classification_version text`
- `matched_categories jsonb not null default '[]'`
- `matched_terms jsonb not null default '[]'`
- `classification_reason text`
- `owner_user_id uuid`
- `dismissed_at timestamptz`
- `converted_tender_id uuid` or the existing tender record identifier
- `created_at`, `updated_at`
- Unique `(organisation_id, canonical_opportunity_id)`

All tenant-specific notes, qualification answers, assignments, internal deadlines, tasks, documents and activity must reference this organisation-owned record or another explicitly organisation-scoped entity. Never attach private notes to the global canonical opportunity.

### 3.7 Organisation matching configuration

Add a tenant-owned capability profile/configuration model only after the product requirements are agreed. It should capture organisation capabilities, excluded categories, preferred buyer types, geography and partner preferences. Avoid treating the current hard-coded classifier terms as a per-tenant configuration without versioning and explainability.

The global connector extracts facts. Tenant matching evaluates those facts against each organisation's profile. Keep these two stages separate so changing one organisation's profile does not rewrite source evidence or another organisation's score.

## 4. Matching and canonicalisation policy

Apply deterministic matching in descending confidence:

1. Same source + stable source reference/external identifier.
2. Exact canonicalised source URL within a trusted source.
3. Explicit external procurement identifier with matching issuing authority.
4. Exact normalised reference + buyer/authority agreement.
5. Content hash as supporting evidence, not an unconditional global identity.
6. Fuzzy title/buyer/date similarity only as a candidate for review, never an automatic merge by itself.

Normalisation must be conservative:
- Preserve the original reference and source URL.
- Normalise whitespace and case for comparison without altering stored source evidence.
- Remove URL tracking fragments/parameters only when safe and source-specific.
- Do not assume reference numbers are globally unique across authorities.
- Do not merge notices with different deadlines or buyers merely because the title matches.
- Store match method, confidence, and review state for every link.

Provide explicit merge and split operations for authorised platform operators. A split must restore the source observations to separate canonical records without deleting observation history or organisation decisions; decisions should be migrated only through an auditable, reviewed mapping.

## 5. Data migration from Phase 1

Phase 1 currently stores source-level discovery records in organisation-scoped `opportunity_updates` and keeps `opportunity_source_runs` platform-global.

Migration must be additive and rehearsed:

1. Snapshot the exact Phase 1 row counts and sample records by collection.
2. Create source registry entries for the current connector set.
3. Create source observations from each legacy `opportunity_updates` record, preserving original IDs in a migration mapping.
4. Create canonical opportunities using conservative matching. Ambiguous cross-source records remain separate.
5. Create source-observation links with match method and review state.
6. Create one `organisation_opportunities` row for the legacy organisation for every migrated legacy opportunity, preserving state, score, fit, categories, matched terms, first/last seen timestamps and dismissal/import references.
7. Preserve `opportunity_changes` and link them to the migrated observation/version identity; do not discard before/after values.
8. Preserve `opportunity_source_runs` history and map source keys where possible.
9. Compare counts, IDs, state distributions, deadlines, source provenance and change history.
10. Run old and new read paths in shadow mode and compare results before switching the UI.
11. Keep the old records read-only for a defined rollback window; do not delete them in the first Phase 2 release.

The migration must be idempotent and resumable. Every migrated row must have a deterministic mapping. A second run must not create duplicates.

## 6. API and application behaviour

Introduce explicit service boundaries:
- Platform discovery service: connector execution, source runs and source observations.
- Canonicalisation service: candidate matching, merge/split review and canonical projections.
- Tenant matching service: organisation-specific classification and opportunity records.
- Pursuit service: qualification, tasks, ownership, internal notes and conversion to a tender/bid.

API access rules:
- Platform-global discovery and canonical data are not automatically public. Serve them only through authenticated, authorised backend routes.
- Organisation opportunity endpoints require verified membership in the active organisation.
- A tenant query must always filter by `organisation_id` on `organisation_opportunities`.
- Tenant detail endpoints must prove the parent opportunity belongs to the active organisation before returning related private data.
- Platform operators may review canonical matches, but their privileges must be separate from organisation-owner permissions.
- Do not expose raw source payloads, internal connector diagnostics or another tenant's matching configuration through ordinary organisation endpoints.

Suggested endpoints (final route names can follow existing conventions):
- `GET /api/opportunities` — active organisation's matched opportunities, with source corroboration metadata.
- `GET /api/opportunities/:id` — tenant-scoped opportunity detail.
- `PATCH /api/opportunities/:id/state` — tenant-specific lifecycle transition.
- `POST /api/opportunities/:id/qualifications` — tenant-specific qualification.
- `POST /api/opportunities/:id/convert` — create/link an organisation-owned tender.
- Platform-only routes for source health, observation review and canonical merge/split.

## 7. Search, filtering and performance

- Index canonical deadline, lifecycle status, buyer and reference fields.
- Index source identity and observed timestamps.
- Index `organisation_opportunities(organisation_id, state, updated_at)`.
- Use server-side pagination with a stable cursor/order, not unbounded reads.
- Search across canonical fields, then join only the active organisation's match/pursuit data.
- Keep relevance and fit scores explainable with classifier version and matched evidence.
- Avoid a single giant JSONB query for common filters.
- Measure query plans and add indexes based on actual access patterns.

## 8. Security and isolation requirements

- Enable RLS on every new table.
- Keep direct browser access denied unless a separate user-scoped RLS design is reviewed.
- Service-role operations must use explicit platform or organisation repository methods; RLS is not a substitute for tenant predicates.
- Enforce organisation ownership on every mutation and relationship traversal.
- Do not trust `organisation_id`, owner IDs, state or score supplied in request bodies.
- Validate source URLs against the existing allowlist before server-side verification/fetch to prevent SSRF.
- Bound source payload size, document-link count and extraction lengths.
- Treat source HTML, documents and external identifiers as untrusted data.
- Keep raw payloads out of logs and user-facing error messages.
- Audit canonical merge/split decisions and platform configuration changes.
- Test two-tenant access with the same Auth user and different memberships, including known-ID attempts and nested related resources.

## 9. Required test matrix

### Connector and provenance
- Successful scan with results.
- Successful scan with zero results.
- Fetch failure, authentication failure and parser failure are distinct.
- Repeated scan updates current observation state without losing historical versions.
- Source omission marks not-seen; it does not delete the observation.
- Source values and document URLs retain provenance.

### Canonicalisation
- Same source reference links to one canonical opportunity.
- Exact trusted URL links when appropriate.
- Same reference from different authorities does not merge blindly.
- Similar titles with different buyers/deadlines remain separate.
- Fuzzy candidate is review-pending, not auto-merged.
- Rejected links remain rejected across future scans.
- Merge/split preserves source and audit history.

### Tenant behaviour
- Same canonical opportunity can have independent records in organisations A and B.
- Dismissing in A does not dismiss in B.
- Changing score/profile in A does not change B.
- A cannot list, read, mutate or infer B's private pursuit metadata.
- Cross-tenant known-ID attempts fail.
- Converting in A creates a tender owned by A only.
- Platform canonical review is inaccessible to ordinary tenant admins.

### Migration and regression
- Every legacy opportunity has a deterministic mapping.
- Re-running migration creates no duplicates.
- Legacy state, timestamps, classification evidence and change history reconcile.
- Existing bid workflows and attachments remain unchanged.
- Existing source-run health remains visible.
- Typecheck, repository tests, local Supabase integration, browser tests and production build pass.

## 10. Rollout gates

Phase 2 must be delivered in separate, reviewable increments:

**2A — Schema and read-only model**
- Add source registry, observation/version, canonical and organisation-opportunity tables.
- Add constraints, indexes and RLS.
- Add repository interfaces and local integration tests.
- No production migration until an isolated rehearsal and restoration plan are verified.

**2B — Dual-write/shadow migration**
- Write new discovery observations alongside the legacy model in a controlled environment.
- Backfill legacy records idempotently.
- Compare counts and user-visible output; do not switch reads yet.

**2C — Tenant matching and UI cutover**
- Enable organisation-specific matching and lifecycle.
- Switch reads only after shadow comparison passes.
- Preserve rollback to the legacy read path during the agreed observation window.

**2D — Legacy retirement**
- Only after reconciliation, retention review and explicit approval, stop legacy writes and later retire old discovery collections.
- No destructive cleanup in 2A–2C.

## 11. Operational prerequisites and exclusions

- Phase 1's tenant-isolation CI and deployed health check are passing.
- The production backup/restore verification was skipped because the current Supabase plan does not provide project backups. This is an acknowledged recovery gap. Phase 2 may proceed through design, local tests and isolated staging, but production data migrations and destructive changes remain blocked until a restorable backup/export and recovery procedure are verified.
- The pre-existing Supabase security-advisor findings (`rls_auto_enable()` execute grants and disabled leaked-password protection) remain separate security work; review and remediate them before widening platform access.
- Do not move or delete Storage objects as part of the canonical opportunity migration.
- Do not add AI-based extraction or fuzzy auto-merging in the first release.
- Do not add external organisation onboarding until tenant matching, platform operations and support boundaries are tested.

## 12. Definition of done

- The relational model and ownership boundaries are reviewed.
- Source provenance is complete and durable.
- Canonicalisation is deterministic, explainable and reversible.
- Tenant opportunity state is independent across organisations.
- Existing legacy workspace behaviour is preserved.
- Migration is idempotent, resumable and fully reconciled in local/isolated environments.
- Cross-tenant API and database integration tests pass.
- Operational metrics distinguish valid empty scans from source failures.
- No production migration or legacy-data deletion occurs without verified recovery capability and explicit release approval.
