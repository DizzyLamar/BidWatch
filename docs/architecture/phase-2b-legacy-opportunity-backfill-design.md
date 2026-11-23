# Phase 2B: Legacy Opportunity Backfill Design

**Status:** implementation staged in the Phase 2B pull request; production execution remains gated  
**Design baseline:** Phase 2A head `991ec334f9ee3cd97ebe22c29915ea2ee3e034e9`  
**Implementation branch:** `phase-2b/dry-run-tooling`

## 1. Purpose and non-goals

Phase 2B will migrate the existing JSONB discovery history into the Phase 2 relational model without changing current application reads or writes during the backfill.

The migration must be deterministic, resumable, auditable and idempotent. It must preserve source provenance, organisation-specific workflow state, and the historical changes that can be reconstructed from the legacy records.

This design does **not** authorise or implement:
- a hosted/production schema migration or data backfill;
- a switch of application reads or writes to the Phase 2 tables;
- changes to Storage, hosted Data API exposure, or production settings;
- automatic merging of records based only on title similarity or an ambiguous reference;
- fabricated source snapshots, dismissal times, conversion links or missing tender fields.

Phase 2B implementation must run first against an isolated local/branch database. Production remains gated on a verified restorable export and recovery rehearsal.

## 2. Verified legacy inputs

The current discovery adapter declares five source keys in `OPPORTUNITY_SOURCES`:

| Stable source key | Display name | Current adapter |
|---|---|---|
| `maneps` | MANePS procurement notices | public OCDS API |
| `ppda` | PPDA procurement notices | public page |
| `malawi-gov` | Malawi Government tenders | public page |
| `careersmw` | Careers Malawi tenders & bids | public page / WordPress REST detail retrieval |
| `careersmw-consultancies` | Careers Malawi consultancies | public page / WordPress REST detail retrieval |

These keys must be seeded exactly as declared by the adapter. Do not derive keys from display names or URLs. The source registry's `adapter_key` should initially equal the stable source key unless implementation introduces an explicitly versioned adapter registry.

Legacy data resides in `public.app_records`:
- `opportunity_updates`: organisation-scoped in Phase 1.
- `opportunity_changes`: organisation-scoped in Phase 1.
- `opportunity_source_runs`: platform-global in Phase 1.

The discovery update identity is currently per-source. Its key prefers source + normalized reference + buyer; then source + reference; then source + canonical URL; then source + content hash. The legacy UI separately groups cross-source notices by reference/buyer, reference, URL or content/title. That UI grouping is a presentation heuristic, not proof that two notices represent the same procurement event.

A successful source scan marks previously observed but absent notices as `sourceStatus: not-seen`; it does not delete or dismiss them. A source failure must never be interpreted as a zero-result successful scan.

## 3. Target mapping

### 3.1 Source registry

Upsert one `procurement_sources` row for each of the five stable source keys. Preserve the source name and base URL from the adapter declaration. Retain the source key as a stable external identifier; generated target UUIDs are internal identifiers.

No additional source (institutional pages, World Bank, UNGM or other aggregators) should be introduced by the legacy backfill. Those require separate adapter and operational design.

### 3.2 Legacy source runs → `procurement_source_runs`

Map each legacy `opportunity_source_runs` record to one target run:
- `id`: derive a deterministic target UUID from the legacy collection and `app_records.id`; retain the original legacy ID in metadata. This avoids collision with unrelated target runs while remaining stable across retries.
- `source_id`: resolve through the exact legacy `sourceId` key.
- `scan_type`: map `scheduled` / `manual`; quarantine unknown values rather than silently coercing them.
- `status`: map `ok`, `error`, and `authentication_required` directly. Any future or unknown status requires an explicit mapping.
- `completed_at`: use the legacy `checkedAt` when valid.
- `started_at`: derive from valid `checkedAt - durationMs` only when both values are valid and duration is non-negative. Record the derivation in metadata. If not derivable, use a documented fallback only after implementation review; do not pretend the legacy timestamp was an observed start time.
- counts: preserve `fetchedCount`, `parsedCount`, `relevantCount`, and `failedCount` after integer/non-negative validation.
- `safe_message`: retain the legacy message only after confirming it contains no credentials, personal data or raw upstream response.
- `metadata`: retain `accessMethod`, `durationMs`, `legacy_record_id`, and any other explicitly allow-listed operational fields.

Do not copy the embedded notice collection into a run's metadata. Notices are migrated as observations. A legacy run that references an unknown source key or has invalid counts/timestamps goes to the quarantine report.

### 3.3 Legacy updates → observations + tenant pursuit

Each legacy `opportunity_updates` row becomes exactly one `procurement_source_observations` row, preserving the fact that the same procurement notice may have separate source observations.

Identity and provenance:
- `source_id`: exact source registry mapping.
- `source_key`: stable string `legacy-app-record:<app_records.id>`. This makes reruns idempotent and avoids changing historical identity when the adapter's current identity algorithm changes.
- `external_id`: legacy `externalId`, when present.
- `reference`, `source_url`, `title`, `buyer_name`, `deadline_at`, `description`, `notice_type`: map from the corresponding legacy normalized fields.
- `published_at`: map from `details.publishedAt` only when parseable.
- `procurement_method`: map from `details.procurementMethod` only when present.
- `document_links`: map from `details.documents` after URL validation and retain only title/URL pairs.
- `first_seen_at`, `last_seen_at`: preserve valid legacy timestamps.
- `source_status`: map active/absent state to `active` or `not_seen`; preserve an explicit withdrawn state only if legacy data actually records one. Do not infer withdrawal from absence.

The target observation table does not contain organisation classification or pursuit state. Those belong in `organisation_opportunities`:
- `organisation_id`: the verified legacy organisation created by Phase 1, resolved from the database, never supplied from a JSON record.
- `canonical_opportunity_id`: initially one canonical record per source observation (see §4).
- `fit_level`, `relevance_score`, `classification_version`, `matched_categories`, `matched_terms`, `classification_reason`: map from the legacy classifier fields. Validate score range, known fit values and JSON array shapes.
- `state`: map legacy `new` → `new`; `dismissed` → `dismissed`; `imported` → `converted` only when the referenced tender is verified (see §5).
- `dismissed_at`: required by the target schema for dismissed state. Use a genuine legacy dismissal timestamp if one exists. If it does not, quarantine the row for an explicit policy decision; do not substitute migration time or an unrelated `updatedAt` value without proving its semantics.
- `converted_tender_id`: set only after validating the referenced tender exists in the same legacy organisation.

Legacy `rawText` may contain scraped page text and is not automatically safe to copy wholesale. The migration must construct an allow-listed `raw_payload` from source facts required for provenance. Keep the normalized source fields and document links; do not copy secrets, request headers, cookies, authentication material, or unrelated runtime data. Any retention of full raw text requires a separate size, privacy and retention decision.

### 3.4 Legacy changes → observation versions

Each `opportunity_changes` record is linked through `opportunityUpdateId`. Group changes by the legacy update ID and order by `detectedAt`, with legacy record ID as a deterministic tie-breaker.

A version snapshot is a complete normalized observation snapshot, not merely the sparse `before` or `after` object from one change event. Reconstruct only when the initial state and all required changes can be established without guessing:
1. Start from a verified baseline snapshot when available.
2. Apply each change's `after` values in chronological order.
3. Validate each `changedFields` list and the corresponding `before` / `after` keys.
4. Where possible, cross-check a transition's `before` values against the preceding reconstructed state.
5. Canonicalize JSON deterministically and compute SHA-256 over that canonical representation.
6. Insert monotonically increasing `version_no` values and preserve each source detection timestamp.

If the earliest baseline is unavailable, a transition is inconsistent, or a full snapshot cannot be reconstructed, do not fabricate a version. Record the change IDs and reason in the quarantine/reconciliation report. Preserve the legacy `opportunity_changes` records untouched.

The original legacy content hash is a short FNV-style hash and must not be reused as the target cryptographic snapshot hash.

## 4. Canonical identity and linking

Start conservatively: create one canonical opportunity per migrated source observation, with a deterministic `canonical_key` based on the source key and legacy update ID. Link it using a new explicit match method such as `source_observation_seed`.

Phase 2A currently permits only:
- `same_source_reference`
- `exact_url`
- `external_identifier`
- `content_hash`
- `reviewed_manual`

None accurately describes the initial one-observation seed operation. Before implementing the backfill, add an additive constraint migration that allows `source_observation_seed`. Do not misuse `reviewed_manual` or claim a match between multiple records when none occurred.

Cross-source consolidation is a separate matching pass:
1. Exact validated external procurement identifier with compatible buyer/source context.
2. Exact normalized reference + buyer, with explicit handling of known source-specific reference formats.
3. Exact canonical URL after safe URL normalization.
4. Content hash only when the hash is computed over the same canonical field set and semantics.
5. Ambiguous or conflicting candidates remain separate and are flagged for human review.

Do not automatically merge solely on title, approximate text similarity, or reference without sufficient buyer/source context. A canonical merge or split must write the corresponding audit event and retain all source links. Do not discard rejected candidate links or legacy provenance.

## 5. Imported tender validation

Legacy `state = imported` is not sufficient proof of a successful conversion.

For every non-empty `importedTenderId`:
- verify the referenced `tenders` row exists in `app_records`;
- verify it belongs to the same legacy organisation;
- verify the referenced tender record is structurally valid;
- record the exact mapping in the dry-run report.

Only then map the pursuit to `converted` and set `converted_tender_id`. Missing, malformed, cross-organisation or ambiguous references must be quarantined. Do not silently downgrade an imported row to `new` or fabricate a tender.

The Phase 2A `converted_tender_id` is currently a UUID column without a foreign key to the legacy `app_records` tender identity. Implementation must retain explicit validation and reconciliation; adding a durable relational tender FK is a separate schema decision.

## 6. Dry-run, idempotency and resumability

The backfill must have a dry-run mode that performs no writes and emits a machine-readable report with:
- baseline counts by legacy collection and source;
- valid/invalid legacy IDs and source keys;
- source registry mappings;
- source-run mapping counts and rejected rows;
- observation mapping counts, duplicates and malformed rows;
- state distribution and classification validation;
- imported tender reference validation;
- history reconstruction coverage and quarantine reasons;
- canonical seed counts and candidate cross-source matches;
- target counts expected after each stage;
- all discrepancies and explicit stop conditions.

Idempotency requirements:
- use deterministic source keys and canonical keys;
- use upserts constrained by target unique keys;
- never create a second observation for the same `(source_id, source_key)`;
- never append duplicate versions for the same observation/hash;
- store a migration-run identifier and per-stage checkpoints;
- commit bounded batches and persist progress so a process can resume safely;
- do not overwrite a target row that has changed since a previous backfill run without an explicit reconciliation rule.

The dry-run report must be reviewed before write mode is enabled. The write mode must support a no-op rerun and produce the same reconciliation totals.

## 7. Reconciliation and acceptance gates

After a local/branch backfill, verify:
- every in-scope legacy update is either migrated once or appears in quarantine with a reason;
- every source run maps once or is explicitly quarantined;
- every source key resolves to exactly one registry row;
- no observation has multiple active canonical links;
- every migrated observation has the intended organisation pursuit;
- state counts reconcile, with imported rows split into verified conversions and quarantined exceptions;
- every converted pursuit points to a verified same-organisation tender;
- all reconstructable history is represented by ordered immutable versions;
- incomplete history is disclosed, not hidden;
- source provenance and document URLs are preserved;
- canonical candidate merges are auditable;
- rerunning the backfill creates no duplicates and does not alter existing target state unexpectedly.

Run schema and repository integration tests against an isolated Supabase database. Add fixtures for duplicate source references, missing buyers, missing URLs, malformed timestamps, inconsistent change histories, dismissed rows without timestamps, imported rows with missing/cross-tenant tenders, and unknown source keys.

## 8. Rollout gates

Before any hosted migration or backfill:
1. Phase 2A must be reviewed and merged through the normal PR process.
2. The current production data must have a restorable backup/export, and restoration must be rehearsed successfully.
3. Phase 2B dry-run output must be reviewed and signed off.
4. The source mapping, quarantine policy and canonical matching rules must be approved.
5. The new `source_observation_seed` match method migration must pass local Postgres 17 integration tests.
6. A production execution and recovery runbook must exist, including stop conditions and reconciliation queries.
7. Application reads/writes must remain on the legacy path until a separate cutover plan and explicit approval.

No Phase 2B production action is authorised by this design document.


## 9. Running the read-only dry-run

Run only against the local Supabase stack. Do not use a hosted project URL, `--remote`, production environment variables, or a production service-role key.

```bash
npx supabase start
eval "$(npx supabase status -o env)"

export LOCAL_SUPABASE_URL="$API_URL"
export LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
export PHASE2B_DRY_RUN=1

npm run phase2b:dry-run
```

The command refuses to start unless the explicit dry-run flag is set and the configured hostname is `localhost`, `127.0.0.1`, or `::1`. It uses dedicated local-only environment variable names and does not fall back to the application's normal Supabase variables.

By default, the JSON report is written to `artifacts/phase-2b-dry-run.json`. Override the destination with `PHASE2B_REPORT_PATH`. The report queries `opportunity_updates` and `opportunity_changes` for the resolved legacy organisation only, while source runs remain global. Tender baseline counts are organisation-scoped; only tender IDs referenced by imported updates are additionally looked up across organisations, so cross-tenant imported references are quarantined rather than mistaken for missing tenders. The report contains record IDs, counts and validation messages, but not raw scraped payloads.

A freshly reset local database may contain no legacy discovery records; in that case the inventory will correctly report zero. The local Supabase integration test inserts temporary synthetic records, executes the same inventory function, verifies the expected quarantine and migration-candidate counts, checks that the records are unchanged, and removes the fixtures. It never uses production data.


### Dry-run report completeness
The read-only inventory report retains every row-level finding, not just a capped sample. Invalid imported tender UUIDs are quarantined before any UUID-column lookup, and malformed JSON records are handled before imported-reference extraction. These behaviours are covered by unit tests, including a report with more than 1,000 findings.


### Bounded imported-tender validation

Imported tender UUIDs are resolved in batches of at most 100 IDs per PostgREST request. Result pagination alone does not bound the URL/filter size of a single `.in(...)` request. The integration test treats global source-run counts as a lower bound because other integration suites may create independent global runs concurrently.


## 10. Resumable local backfill implementation

The implementation adds two additive schema migrations:

- `20261119070000_phase2b_source_observation_seed_method.sql` allows the explicit `source_observation_seed` provenance method without changing existing match values.
- `20261119071000_phase2b_backfill_checkpoints.sql` adds backend-only run and per-record checkpoint tables. The ledger stores legacy IDs, target IDs, status and sanitized findings; it does not copy raw legacy payloads.

The writer is `scripts/phase-2b-backfill.ts`. It is permanently restricted to loopback Supabase URLs and requires all of:

- `PHASE2B_BACKFILL=1`
- `LOCAL_SUPABASE_URL`
- `LOCAL_SUPABASE_SERVICE_ROLE_KEY`

It also requires the explicit `PHASE2B_BACKFILL_CONFIRM=REVIEWED_LOCAL_DRY_RUN` acknowledgement after the dry-run report has been reviewed. It does not fall back to application or hosted Supabase environment variables.

Run locally after starting Supabase and applying migrations:

```bash
npx supabase start
eval "$(npx supabase status -o env)"

export LOCAL_SUPABASE_URL="$API_URL"
export LOCAL_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"

# Read-only preflight first; inspect the report and quarantine findings.
export PHASE2B_DRY_RUN=1
npm run phase2b:dry-run
unset PHASE2B_DRY_RUN

export PHASE2B_BACKFILL=1
# Set this only after reviewing the output from npm run phase2b:dry-run.
export PHASE2B_BACKFILL_CONFIRM=REVIEWED_LOCAL_DRY_RUN

# Use an explicit UUID so an interrupted run can be resumed.
export PHASE2B_RUN_ID="$(node -e "console.log(crypto.randomUUID())")"
npm run phase2b:backfill
```

The command prints the run ID before writing and emits a mode-0600 report at `artifacts/phase-2b-backfill-report.json` by default. If interrupted, rerun with the same `PHASE2B_RUN_ID`. A completed run cannot be resumed; use a new UUID for an idempotency verification pass.

For bounded batches, set `PHASE2B_BACKFILL_RECORD_IDS` to a comma-separated list of legacy `app_records.id` UUIDs. Selecting an opportunity update automatically includes its linked change rows and any same-organisation tender it references. Selecting a source-run ID includes only that run. If the variable is unset, the command processes the full legacy workspace; an explicitly empty value selects no legacy rows and is used by CI to smoke-test the write path without touching seeded data. Unresolved requested IDs are reported.

### Write and recovery semantics

- Source registry entries are inserted by stable source key when absent; existing entries must match the adapter definition and are never reset or overwritten.
- Each observation uses `legacy-app-record:<app_records.id>` as its stable source key. Existing observations are reused only when every mapped field matches; conflicting rows are quarantined rather than overwritten.
- Each canonical seed uses a deterministic key derived from source key and legacy update ID; existing canonical fields must match exactly.
- Each pursuit is identified by `(organisation_id, canonical_opportunity_id)`. Existing workflow state is preserved; a mismatch is quarantined rather than overwritten.
- Source runs and audit events use deterministic UUIDs and are inserted once, then verified on retry.
- A per-record checkpoint is persisted only after its target writes complete. If the process stops midway through a record, deterministic IDs and natural-key upserts allow that record to be retried.
- Only one active run per organisation is allowed. A crashed run remains active and must be resumed with its recorded run ID; do not start a competing run.
- Legacy `app_records` rows are read-only and are never updated or deleted.
- Imported rows become `converted` only after the same-organisation tender is revalidated immediately before writing.
- Dismissed rows without a real legacy `dismissedAt` remain quarantined.
- Raw scraped text and source-run messages are not copied into the new schema.
- A failed or inconsistent history chain is quarantined as a group before any versions for that parent are inserted.

### Historical reconstruction

Unlike the dry-run inventory, the writer can reconstruct snapshots when the full chain is provable. It starts from the current legacy update, walks sparse deltas backwards in reverse chronological order, and requires each delta's `after` values to match the state reached from the current record. It then emits full normalized snapshots for each detected transition, in chronological order, with SHA-256 hashes. Unsupported fields, missing values, invalid timestamps or inconsistent transitions are quarantined; no partial history is written for that update.

The pure history-reconstruction unit tests exercise a consistent sparse chain and verify chronological full snapshots. The local integration test exercises the inconsistent-chain quarantine path. The integration fixture does not attempt to delete immutable version rows because the target table is intentionally append-only. This reconstruction is still only as complete as the legacy change log. It cannot recover changes that were never recorded, and it does not invent a pre-history baseline snapshot.

### CI and acceptance

CI runs the read-only dry-run and the write-path smoke test against its disposable local Supabase database, then runs the full integration suite. Integration coverage exercises:

- a new opportunity and an imported opportunity with a valid same-organisation tender;
- a dismissed opportunity without a real timestamp (quarantined);
- a global source-run mapping;
- a deliberately inconsistent history chain quarantined without inserting partial immutable versions;
- preservation of legacy records;
- deterministic observation identity and no duplicate target row on a second run;
- ledger accounting across a new idempotency-verification run.

A successful local synthetic run validates the engine and schema contract. It does not prove that the user's historical production data contains no additional anomalies. A sanitized export is still required for source-by-source reconciliation and a production runbook. No hosted schema migration, production backfill, application cutover, Storage change or deployment is part of this implementation.
