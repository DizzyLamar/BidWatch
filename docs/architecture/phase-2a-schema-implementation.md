# Phase 2A implementation notes

**Branch:** `phase-2/canonical-opportunity-architecture`  
**Pull request:** [#9](https://github.com/DizzyLamar/BidWatch/pull/9)  
**Scope:** Additive database schema and local integration coverage only.

## Delivered in this branch

Migration `20261118065732_phase2_shared_procurement_intelligence.sql` introduces:

- `procurement_sources` — platform source registry.
- `procurement_source_runs` — source execution status and count telemetry.
- `procurement_source_observations` — current source-level notice projection, unique by source and source key.
- `procurement_observation_versions` — append-only snapshots of changed source evidence.
- `canonical_opportunities` — platform-level opportunity identity and current projection.
- `canonical_opportunity_sources` — provenance links and match-review state.
- `canonical_opportunity_events` — auditable source-link, merge and split review events.
- `organisation_opportunities` — independent organisation-specific lifecycle and classification.

The schema includes foreign keys, check constraints, uniqueness rules and query-oriented indexes. Opportunity owners are constrained to memberships in the same organisation through a composite foreign key.

The read-only backend repository in `backend/procurement-repository.ts` derives the tenant predicate from the verified AsyncLocalStorage request scope. It exposes list/detail reads for the active organisation only, uses a bounded page size, and returns curated source provenance without raw connector payloads. It intentionally provides no platform-global reads or mutation methods in 2A.

## Security model

- RLS is enabled on every new table.
- No browser-facing policies are created.
- `PUBLIC`, `anon` and `authenticated` receive no table privileges.
- `service_role` receives only the operations required by the backend.
- Observation-version rows are selectable and insertable by the application service, but not updateable or directly deleteable. The application must write a new version when evidence changes.
- Tenant-specific state is stored only in `organisation_opportunities`; the global canonical row contains no organisation notes or pursuit state.

The backend must still apply an explicit `organisation_id` predicate to every tenant query. The service role bypasses RLS, so RLS alone is not a tenant-isolation boundary for server-side code.

## Data API exposure prerequisite

Supabase changed the default behaviour for newly created public tables: they are not automatically exposed through the Data API. This migration intentionally does not change project-level API exposure settings.

The local Supabase configuration exposes `public` for CI. Before a later application release accesses these tables through hosted PostgREST, explicitly confirm the project's exposed-schema configuration includes the required schema. Do not broaden exposure to additional schemas or grant browser roles merely to make backend queries work. The service-role-only grants and RLS posture must remain intact.

Reference: [Supabase breaking change — tables are no longer exposed automatically](https://supabase.com/changelog?types=breaking-change).

## Verification

The new integration test runs only when `SUPABASE_URL` resolves to localhost. It verifies:

- service-role inserts across the source, run, observation, canonical and tenant-pursuit relationships;
- two organisations can hold different states for the same canonical opportunity;
- duplicate organisation/canonical pursuit rows are rejected;
- anonymous clients cannot read canonical opportunities or create tenant pursuits;
- the application service cannot update or delete immutable observation-version rows.

The `test:integration` script now runs this suite alongside the existing Phase 1 Auth/PostgREST tenant-isolation suite.

## Explicitly not done

- No migration has been applied to hosted/production Supabase.
- No legacy `opportunity_updates` or `opportunity_changes` records have been copied or modified.
- No discovery connector, canonical matching algorithm, backend route, UI, or dual-write path has been switched to the new schema.
- No Storage object has been moved or deleted.
- No production API exposure setting has been changed.

## Gate before Phase 2B

1. CI must apply the migration to a clean local Supabase database and pass the integration suite.
2. Review the schema and constraints, including the composite owner-membership FK.
3. Confirm hosted Data API exposure requirements for the later backend integration.
4. Rehearse the legacy backfill and reconcile counts in an isolated database.
5. Verify a restorable production recovery path before any hosted migration or production data backfill.
