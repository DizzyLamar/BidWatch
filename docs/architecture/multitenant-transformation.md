# BidWatch multi-tenant transformation
## Phase 0 production audit and Phase 1 implementation specification

Audit date: 2026-11-15  
Repository: `DizzyLamar/BidWatch`  
Audited branch: `main`  
Audited commit: `f5c1c5a491d005cafde0dc99638e8c3f590d560d`  
Production database: BidWatch Supabase project (read-only inspection)

> This document records the repository and live database state observed during Phase 0. It does not claim that the live Render deployment is byte-for-byte identical to the audited GitHub commit. No production data or schema was changed during this audit.

---

## 1. Executive summary

BidWatch is a working single-workspace procurement and bid-management application. It is not yet a multi-tenant opportunity-intelligence platform.

The existing product has valuable functionality worth preserving: provisioned Google authentication, role-based permissions, protected Super Admin actions, bid ownership, deadlines and reminders, opportunity discovery, source health, source-run history, duplicate consolidation for display, qualification, tasks, attachments, bid history, activity, audit events and optimistic concurrency.

The main architectural limitation is that all application entities are stored in one generic `public.app_records` JSONB table. The backend uses a Supabase server-side secret key and generic collection helpers. RLS denies direct client access, but that does not provide tenant isolation for backend requests made with the service role. Tenant isolation must be enforced in the application repository and request context, with database constraints and RLS retained as defence in depth.

The transformation should be additive and staged:
1. Establish organisations, memberships and organisation-scoped roles.
2. Assign all existing records to one legacy/default organisation.
3. Enforce organisation scope in every backend read and write.
4. Only after this foundation is proven, introduce the shared canonical opportunity model and configurable matching.

No destructive migration is justified at this stage.

## 2. Repository baseline

### 2.1 Repository and deployment workflow

- Default branch: `main`.
- Audited commit: `f5c1c5a491d005cafde0dc99638e8c3f590d560d`.
- Last commit on the audited branch: 2026-10-05.
- Repository visibility: public.
- Branch protection: disabled; no required status checks are configured.
- CI workflow runs typecheck, production build, repository verification and automation-script syntax checks.
- The CI workflow deploys to Render only after verification succeeds.
- The CI workflow currently targets `https://bidwatch-gk3r.onrender.com`.
- README production URL still points to the older `https://bidwatch.onrender.com/`; update the documentation in a separate documentation change.
- The root repository listing does not contain a package lockfile; CI uses `npm install`.

The README itself recommends making the repository private before using it as a real company source repository. Repository visibility should be reviewed before the platform is opened to additional organisations. This audit did not change visibility.

### 2.2 Technology

- Frontend: React 19, TypeScript, Vite 6 and Tailwind CSS.
- Backend: Express 5.
- Database, authentication and object storage: Supabase.
- Supabase client dependency: `@supabase/supabase-js` 2.57.4 range.
- CI runtime: Node.js 20.
- Hosting: Render.

### 2.3 Existing product capabilities to preserve

The current application and README document:
- Google authentication and provisioned-user checks.
- Role and permission administration.
- Protected Super Admin identity and sensitive permissions.
- Bid CRUD, assignment and workflow transitions.
- Deadline urgency and scheduled reminders.
- Opportunity discovery and source-run health.
- Source observation history and change detection.
- Qualification, requirements and task workflows.
- Document upload, signed retrieval and deletion.
- Bid history, activity and security audit records.
- KPI visibility based on permissions.
- Optimistic concurrency using record revisions.
- User-facing error, loading and destructive-confirmation states.

These capabilities are migration constraints, not features to casually replace.

## 3. Live Supabase inventory

### 3.1 Physical schema

The only application table in the `public` schema is:

```sql
public.app_records (
  id uuid primary key,
  table_name text not null,
  record jsonb not null default '{}',
  created_at timestamptz not null,
  updated_at timestamptz not null
)
```

Indexes observed:
- Primary key on `id`.
- `app_records_table_created_idx` on `(table_name, created_at)`.
- `app_records_users_email_unique`, a partial unique index on lowercased user email for records where `table_name = 'users'`. This is consistent with keeping provisioned user identity records platform-global; do not convert this collection into one duplicate user row per organisation.

No organisation, membership or tenant ownership columns/tables currently exist in the application schema.

### 3.2 Live record counts

The live database contained 113 physical `app_records` rows across eight populated logical collections at audit time.

| Logical collection | Rows |
|---|---:|
| activity | 2 |
| bid_history | 1 |
| categories | 14 |
| opportunity_source_runs | 28 |
| opportunity_updates | 48 |
| roles | 18 |
| tenders | 1 |
| users | 1 |
| **Total** | **113** |

Additional live state:
- Supabase Auth users: 1.
- The one active BidWatch user record links to the one Auth user.
- The linked user has the existing Super Admin role.
- Private storage bucket `bidwatch` exists.
- Objects currently stored in that bucket: 0.

The counts are a point-in-time inventory, not a promise that records will remain unchanged.

### 3.3 Collections referenced by code but currently empty in production

The backend code references 15 logical collections in total. Seven are not currently populated in the live database:
- `attachments`
- `bid_requirements`
- `bid_tasks`
- `notifications`
- `opportunity_watchlists`
- `security_activity`
- `opportunity_changes`

These collections still need to be included in the tenant-scope audit because code paths may create records in them later. Empty today does not mean safe to leave unscoped.

### 3.4 Duplicate configuration records

The live category collection contains 14 rows representing seven category names, with each name appearing twice.

The role collection contains 18 rows across three role names:
- Bid Manager: 6 rows.
- Member: 6 rows.
- Super Admin: 6 rows.

The current user references one of the Super Admin role records. Do not deduplicate by name alone. Before migration:
1. Compare permissions, descriptions, system flags and timestamps for each same-name role.
2. Preserve the exact role currently referenced by the active user as a migration input.
3. Map every existing role reference to the chosen canonical role.
4. Deduplicate categories by normalized name only after checking all category references.
5. Record every mapping in a migration audit table or export.

The migration must preserve effective permissions and must not weaken the protected Super Admin boundary.

## 4. Existing persistence and access-control behaviour

### 4.1 Generic JSONB repository

`backend/runtime.ts` implements generic `list`, `get`, `add`, `update` and `delete` helpers over `app_records`.

The helpers filter by `table_name` and, for record operations, by record ID. They do not accept or enforce an organisation identifier.

The backend creates a Supabase client using `SUPABASE_SECRET_KEY`. Supabase service-role access bypasses ordinary RLS policies. Therefore, adding an `organisation_id` column without changing the repository and every route would not create tenant isolation.

### 4.2 Existing RLS and storage

- RLS is enabled on `public.app_records`.
- The policy `deny direct app record access` denies all direct `anon` and `authenticated` access.
- The private `bidwatch` bucket has a policy denying direct `anon` and `authenticated` object access.
- Application access is mediated through the backend.

Preserve this backend-mediated access model unless a separately reviewed architecture change is approved. New tenant-aware tables must also have RLS enabled and no unintended direct client access.

### 4.3 Security advisor findings

The Supabase security advisor reported:
1. `public.rls_auto_enable()` is a `SECURITY DEFINER` event-trigger function with EXECUTE granted to PUBLIC, `anon` and `authenticated`. The event trigger `ensure_rls` uses it to enable RLS on new public tables.
2. Leaked-password protection is disabled in Supabase Auth.

The event-trigger function has a restricted `search_path` of `pg_catalog`, and it is associated with an active DDL event trigger. Review the required execution privileges and revoke unnecessary API-role grants without disabling the event trigger. Enable leaked-password protection after reviewing the user sign-in impact.

No regular table triggers were found in the inspected `public` and `auth` schemas.

## 5. Migration history drift

The live Supabase migration history contains:
- `20260918124946_bidwatch_runtime`
- `20260923071821_prevent_duplicate_bidwatch_users`

The repository currently contains only:
- `20260918000000_bidwatch_runtime.sql`

The checked-in runtime migration timestamp does not match the live migration history timestamp. The second live migration has no corresponding checked-in migration file. The live database does have the corresponding unique partial index `app_records_users_email_unique`.

Before creating any new production migration:
1. Reconcile the checked-in migration directory with the live migration history.
2. Recover or reconstruct the missing duplicate-user migration from the actual live DDL and repository history.
3. Verify the exact SQL and intended effects.
4. Do not rewrite or delete existing production migration-history entries.
5. Create a clean, forward-only migration after the history is understood.

## 6. Current CI and operational baseline

### 6.1 Repository CI

The latest observed push-triggered CI run on the current `main` commit failed during TypeScript typechecking:
- File: `backend/opportunity-discovery.ts`
- Location: line 410 in the audited commit.
- Error: `TS1161: Unterminated regular expression literal`.
- Production build, repository verification and script validation were skipped as a consequence.

The preceding push CI run also failed. A prior run on 2026-10-05 completed successfully before the later changes that introduced the current typecheck failure.

A fresh local baseline has not been executed as part of this read-only audit. The CI result is the known baseline; do not describe the current branch as passing.

### 6.2 Scheduled discovery

The latest observed scheduled opportunity-scan run failed before making the API request because the workflow environment supplied empty values for:
- `BIDWATCH_URL`
- `CRON_SECRET`

The workflow requires both values. Configure the required GitHub Actions secrets/variables in the repository environment and verify the scheduled scan after the CI/typecheck issue is fixed. Do not print or commit their values.

### 6.3 Other operational observations

- The CI log reported five high-severity npm audit findings at the time of the last push run. Re-run a current dependency audit before changing packages; do not blindly apply force upgrades.
- The `main` branch is not protected. Before Phase 1 merges, enable pull-request review or an equivalent controlled merge process and require the CI checks.
- The public repository contains application source and README operational details. Review repository visibility before onboarding external organisations.

## 7. Phase 0 conclusion and exit criteria

The production database is small enough to make a controlled initial migration practical, but the source-code and migration drift must be resolved first.

Phase 0 is considered assessed, with the following implementation blockers still open:
- [ ] Reconcile live and checked-in migration history.
- [ ] Fix the existing TypeScript failure and obtain a clean CI run.
- [ ] Configure the scheduled discovery workflow environment.
- [ ] Review the Supabase security advisor findings.
- [ ] Capture an explicit pre-migration backup/export and verify restoration procedure.
- [ ] Protect the default branch and establish required checks.
- [ ] Confirm the default organisation display name and initial owner mapping before the tenant migration.

No production schema or data was modified during Phase 0.

---

# Phase 1: organisation and tenancy foundation

## 8. Phase 1 objective

Introduce a real organisation boundary while preserving the existing BidWatch workspace and its current behaviour.

At the end of Phase 1:
- Every existing record belongs to one default/legacy organisation.
- A user can belong to more than one organisation.
- Membership and role are specific to an organisation.
- The backend resolves the active organisation from a trusted request context and verifies membership.
- Every application record read and write is scoped to that organisation.
- A user from one organisation cannot access another organisation's records, even when they know a record ID.
- Existing tender discovery and bid workflows still work.

Phase 1 is not yet the general opportunity model. The current tender/opportunity structures remain in place, but they become tenant-scoped.

## 9. Proposed relational foundation

Use relational tables for identity and tenant ownership. Do not represent organisations and memberships as JSONB records.

### 9.1 `organisations`

Proposed fields:
- `id uuid primary key`
- `name text not null`
- `slug text not null unique`
- `status text not null` with constrained values such as active/suspended
- `created_by uuid references auth.users(id)`
- `created_at timestamptz`
- `updated_at timestamptz`

### 9.2 `organisation_members`

Proposed fields:
- `id uuid primary key`
- `organisation_id uuid not null references organisations(id)`
- `user_id uuid not null references auth.users(id)`
- `role_id uuid not null references organisation_roles(id)`
- `status text not null` with invited/active/suspended/removed states as appropriate
- `joined_at timestamptz`
- `created_at timestamptz`
- Unique constraint on `(organisation_id, user_id)`.

A user can have one membership per organisation and different roles in different organisations.

### 9.3 `organisation_roles`

Proposed fields:
- `id uuid primary key`
- `organisation_id uuid not null references organisations(id)`
- `key text not null`
- `name text not null`
- `description text`
- `permissions jsonb not null default '[]'`
- `is_system boolean not null default false`
- `created_at timestamptz`
- `updated_at timestamptz`
- Unique constraint on `(organisation_id, key)`.

Create built-in organisation roles such as Owner, Administrator, Bid Manager and Member. Preserve the existing permission vocabulary initially; permission redesign is outside the tenancy foundation.

### 9.4 `platform_admins`

Keep platform-level administration separate from organisation membership. The current protected Super Admin must not silently become an organisation role that grants control over every tenant.

Proposed fields:
- `user_id uuid primary key references auth.users(id)`
- `created_at timestamptz`
- `created_by uuid references auth.users(id)`

Seed the existing protected Super Admin account only after verifying the current user-to-role mapping and the existing protection rules. Do not use editable user metadata as an authorisation source.

### 9.5 Transitional `app_records` ownership

Add explicit scope metadata to `public.app_records` as an additive migration:
- `scope_type text not null`, constrained to `global` or `organisation`.
- `organisation_id uuid null references organisations(id)`.
- A check constraint requiring a null organisation ID for global records and a non-null organisation ID for organisation records.

Do not force every record into an organisation. The existing `users` collection represents provisioned identity and remains platform-global. `opportunity_source_runs` represents shared platform scan telemetry and also remains global. The remaining existing collections are assigned to the legacy organisation in Phase 1. The existing user's role and permissions are migrated into the organisation membership/role model; the legacy fields may remain temporarily for rollback compatibility but must no longer be authoritative for organisation access.

Migration sequence:
1. Create the default legacy organisation.
2. Create the deduplicated organisation roles and the existing user's organisation membership.
3. Add `scope_type` and nullable `organisation_id` to `app_records`.
4. Mark `users` and `opportunity_source_runs` as global with null organisation IDs.
5. Backfill all other existing application rows to the default organisation.
6. Verify the exact 113-row inventory, per-collection counts, scope assignment and foreign-key validity.
7. Add the foreign key, check constraint and index `(scope_type, organisation_id, table_name, created_at)`.
8. Keep the generic table as a compatibility store during later domain migrations; do not attempt a wholesale JSONB-to-relational rewrite in Phase 1.

The default organisation should be clearly labelled as the legacy BidWatch workspace and remain renameable by its owner. Confirm its display name before running the production data migration.

## 10. Backend changes required

### 10.1 Request context

Extend the authenticated request context with:
- authenticated Supabase user ID;
- active organisation ID;
- membership ID;
- organisation role and effective permissions.

Add organisation-resolution middleware after authentication. It must:
1. Resolve the requested active organisation from a dedicated request header or route context.
2. Verify that the authenticated user has an active membership in that organisation.
3. Reject missing, suspended, removed or unknown memberships.
4. Set the trusted organisation context on the request.
5. Never accept an organisation ID from an arbitrary JSON body as proof of access.

For the initial migration, the existing user is automatically placed in the legacy workspace. The UI can default to that organisation while the organisation switcher is introduced.

### 10.2 Tenant-aware repository

Replace implicit global collection operations with an explicit tenant-aware repository interface, for example:

```ts
const tenantDb = db.forOrganisation(ctx.organisation.id);

await tenantDb.list('tenders');
await tenantDb.get('tenders', ids);
await tenantDb.add('tenders', records);
await tenantDb.update('tenders', updates);
await tenantDb.delete('tenders', ids);
```

The exact API may differ, but the following rules are mandatory:
- Every repository operation declares either an organisation scope or an explicit platform-global scope.
- Organisation reads filter by `scope_type = 'organisation'`, `organisation_id` and `table_name`.
- Organisation updates and deletes filter by `scope_type`, `organisation_id`, `table_name` and record ID.
- Organisation inserts set `scope_type` and `organisation_id` server-side.
- Global reads/writes use a separate explicit platform-scoped repository method; they must never be available through an omitted tenant argument.
- No helper may fall back to an unscoped query.
- Internal scheduled jobs must declare their platform scope explicitly; global discovery must not inherit an arbitrary end-user organisation.
- Add tests that prove missing or ambiguous scope fails closed.

A service-role Supabase client bypasses RLS. The repository's explicit tenant predicates and membership checks are therefore security-critical.

### 10.3 API and UI

Introduce:
- `GET /api/organisations` for the current user's memberships.
- `POST /api/organisations` for creating an organisation and its initial owner membership.
- An organisation context/switcher in the authenticated workspace.
- Membership-aware permission checks for every organisation-owned route.

Do not expose member invitation or bulk membership administration until the membership lifecycle and email/invitation security are designed. The initial release can support the current user and controlled owner provisioning.

### 10.4 Storage

The existing bucket is private and currently contains no objects. Preserve private storage.

For future tenant files:
- Use server-generated paths with an organisation prefix.
- Verify membership and object ownership before signed URL creation, upload or deletion.
- Do not trust a caller-supplied storage path as an authorisation check.
- Add cross-organisation object access tests before enabling multi-tenant uploads.

## 11. Data migration mapping

| Existing collection | Phase 1 treatment |
|---|---|
| `users` | Keep as a platform-global provisioned identity/profile record; migrate its role and permissions into the organisation membership/role model; retain legacy role fields only for rollback during transition |
| `roles` | Map existing roles to deduplicated organisation roles; preserve protected platform admin separately |
| `categories` | Keep existing categories under the legacy organisation for now |
| `tenders` | Assign to legacy organisation |
| `bid_history` | Assign to legacy organisation |
| `activity` | Assign to legacy organisation |
| `opportunity_updates` | Assign to legacy organisation in Phase 1; shared canonical discovery is Phase 2 |
| `opportunity_source_runs` | Keep platform-global as shared source scan telemetry; access only through explicit platform-scoped repository operations |
| `attachments` | Add tenant ownership before the first record is created |
| `bid_requirements` | Add tenant ownership before the first record is created |
| `bid_tasks` | Add tenant ownership before the first record is created |
| `notifications` | Scope to organisation and recipient before the first record is created |
| `opportunity_watchlists` | Scope to organisation and user before the first record is created |
| `security_activity` | Separate platform audit events from organisation audit events |
| `opportunity_changes` | Preserve source-level change history; Phase 2 will attach it to canonical opportunities |

The Phase 1 migration must not move source observations into a global table yet. That separation belongs to Phase 2, after tenant boundaries are proven.

## 12. Phase 1 security and test requirements

Required automated tests:
1. A user with one active membership can read the legacy organisation.
2. A user with no membership cannot access any organisation route.
3. A suspended or removed membership is denied immediately.
4. A user belonging to two organisations can switch between them.
5. The same user can have different roles in each organisation.
6. Listing records in organisation A never returns records from organisation B.
7. Knowing a record ID from organisation B does not allow get/update/delete from organisation A.
8. An organisation ID in a request body cannot override the verified active organisation.
9. Inserts always receive the server-resolved organisation ID.
10. Missing tenant context causes repository operations to fail closed.
11. A storage path from another organisation cannot be signed, overwritten or deleted.
12. Existing tender workflow transitions, revision checks, submission evidence and audit behaviour remain intact.
13. Platform administration remains distinct from organisation administration.
14. Scheduled discovery and reminders continue to run with explicit, limited internal scope.

Acceptance criteria:
- Two independent organisations exist in a test environment.
- The same Auth user can belong to both with different roles.
- All 113 audited legacy rows are assigned to the default organisation after migration, with no row loss.
- Existing populated collection counts reconcile before and after migration.
- No cross-tenant access succeeds through API or storage.
- Existing single-organisation workflows pass regression tests.
- Typecheck, repository tests and production build pass.
- Production deployment is not performed until CI is green and the migration has been rehearsed against a backup or isolated branch.

## 13. Deployment and rollback strategy

Use an additive, expand-and-contract rollout:
1. Obtain and verify a restorable backup/export of `app_records`, migration history and storage metadata.
2. Reconcile migration history before adding a new migration.
3. Rehearse the migration against an isolated Supabase branch or restored database.
4. Apply additive organisation tables and nullable ownership column.
5. Seed the legacy organisation and membership.
6. Backfill records and verify exact collection counts.
7. Deploy tenant-aware backend code.
8. Verify current workspace workflows and cross-tenant rejection.
9. Enforce NOT NULL and required constraints after successful verification.
10. Keep a rollback path that restores the previous application version and does not delete the new additive tables or legacy data.

Do not use a destructive rollback that drops migrated rows. If a tenant-scope deployment fails, disable the new organisation context and restore the previous application version while retaining the additive schema and the verified legacy data.

---

## 14. Phase gates

Phase 1 implementation may begin only after:
- The current TypeScript error is fixed and CI is green.
- The migration-history discrepancy is reconciled.
- A restorable production backup is confirmed.
- The default organisation name and owner mapping are confirmed.
- The role/category deduplication map is reviewed.
- The Supabase security findings have an agreed remediation.

Phase 2 begins only after Phase 1's cross-tenant isolation tests pass. Shared canonical opportunities, organisation-specific matches and independent pursuits must not be introduced before tenant isolation is proven.
