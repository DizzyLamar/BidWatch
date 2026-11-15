# Phase 1 preparation without a paid Supabase branch

## Decision

Do not create a Supabase development branch. Prepare and test Phase 1 using:
1. A Git feature branch for application and migration files (no database branch charge).
2. A local Supabase stack started with the Supabase CLI and Docker on a developer machine.
3. An optional GitHub Actions job that starts the same local Supabase stack on a disposable runner for repeatable CI tests.
4. A private local logical backup of production before any production migration.

This does not create a second hosted Supabase project, consume Supabase branch-hours, or write to the production database while developing.

## Why this is the right fit for BidWatch

The current production database has a small application footprint: 113 `app_records` rows across eight populated logical collections, one Auth user, and an empty private storage bucket. The production schema is still a single generic JSONB table.

The current migration chain must be reconciled before a Phase 1 migration is written:
- Live migration history: `20260918124946_bidwatch_runtime`, `20260923071821_prevent_duplicate_bidwatch_users`.
- Checked-in file: `20260918000000_bidwatch_runtime.sql`.
- The live database has the unique index `app_records_users_email_unique`, but its migration file is absent from the repository.

The exact live index definition observed during the audit is:

```sql
CREATE UNIQUE INDEX app_records_users_email_unique
ON public.app_records USING btree (lower((record ->> 'email'::text)))
WHERE (
  (table_name = 'users'::text)
  AND (COALESCE((record ->> 'email'::text), ''::text) <> ''::text)
);
```

The mismatch should be reconciled in source control before any migration is deployed. Do not repair it by deleting rows from `supabase_migrations.schema_migrations` or by blindly running `db pull` against production.

## A. Secure production backup (one-time gate)

Use the Supabase CLI from a trusted local machine. Obtain the database connection string from the Supabase Dashboard's **Connect** panel. Prefer the session pooler unless the network supports the direct connection.

Never paste the connection string, password, access token, or dump contents into chat or GitHub.

In a private working directory:

```bash
umask 077
mkdir -p "$HOME/bidwatch-private-backup"
cd "$HOME/bidwatch-private-backup"

read -rsp "Supabase database URL: " DATABASE_URL
echo
export DATABASE_URL

supabase db dump --db-url "$DATABASE_URL" -f roles.sql --role-only
supabase db dump --db-url "$DATABASE_URL" -f schema.sql
supabase db dump --db-url "$DATABASE_URL" -f data.sql --use-copy --data-only

unset DATABASE_URL
sha256sum roles.sql schema.sql data.sql > SHA256SUMS
```

Keep this directory outside the repository and synchronised cloud folders. Encrypt the backup at rest using an encryption method you control. Retain the original files until a restore test has succeeded.

The dump is a logical database backup. Storage object bytes are separate from database rows; the audit found zero objects in the `bidwatch` bucket, but recheck immediately before backup and migration.

Do not use production `data.sql` as a GitHub Actions artifact or commit it to the repository. It contains real application records.

## B. Local Supabase development stack

### Prerequisites

- Docker Engine (or another Docker-compatible runtime) running locally.
- Supabase CLI installed.
- Git branch for the work.

Check the installed versions and command syntax before running commands:

```bash
docker --version
docker info
supabase --version
supabase --help
supabase migration --help
```

The CLI v3 release changed database commands to target the local stack by default. A hosted target now requires explicit `--remote`, and unattended hosted mutations require `--yes`. Keep this work local and do not add `--remote` to development/reset commands.

The repository already has a `supabase/migrations` directory but does not yet have a checked-in `supabase/config.toml`. Initialise the local CLI configuration carefully, preserving the existing migration directory:

```bash
supabase init
```

Review the generated configuration before committing it. Do not add project credentials, OAuth secrets, production URLs, or database passwords to `config.toml`.

### Reconcile migration filenames locally

First inspect the live migration list using a read-only command:

```bash
supabase link --project-ref "$BIDWATCH_PROJECT_REF"
supabase migration list --remote
```

Linking records local CLI project configuration; it does not apply a schema migration. The migration-list command is for comparison only.

The repository history needs to represent the exact versions already recorded in production. After reviewing the existing file contents and the live migration list:

1. Rename the checked-in runtime migration from `20260918000000_bidwatch_runtime.sql` to `20260918124946_bidwatch_runtime.sql`. Its SQL should remain unchanged.
2. Create the missing historical migration using the CLI generator, then rename the generated file to the exact live version:
   
   ```bash
   supabase migration new prevent_duplicate_bidwatch_users
   ```

3. Put the verified unique-index statement shown above in `20260923071821_prevent_duplicate_bidwatch_users.sql`.
4. Review both files against the live DDL and migration history. This is a source-control reconciliation, not an instruction to apply these old migrations to production.
5. Run `supabase migration list --remote` again and confirm local and remote versions line up before preparing any new Phase 1 migration.

Do not run `supabase db push --remote`, `supabase db reset --linked`, `supabase db pull --remote`, or `apply_migration` as part of this preparation. The first two can mutate a hosted database; a pull can alter migration history. The only remote command in this section is the read-only migration list.

### Test against synthetic data

Start the local stack and replay the checked-in migration chain:

```bash
supabase start
supabase db reset
supabase status
```

Use a hand-written synthetic seed for tests. Do not copy production user emails, Auth records, role data, or other production values into the repository.

For migration rehearsal, make a local-only copy of the current data shape with synthetic identifiers and redacted emails. Preserve the structural cases that matter:
- global provisioned user record;
- the duplicated category names;
- the three duplicated role names and differing role permissions;
- tender, bid history and activity records;
- source observations and source-run telemetry;
- empty collections that the backend already references.

A test fixture must not contain real user data or secrets.

## C. Free, repeatable CI validation

Once the local config and migration history are reconciled, add a dedicated GitHub Actions job that:
1. Runs on GitHub's disposable hosted runner.
2. Installs a pinned Supabase CLI version.
3. Starts the local Supabase stack.
4. Runs `supabase db reset` against that local stack.
5. Executes SQL assertions for migration state, constraints and indexes.
6. Runs the existing typecheck, repository tests and production build.
7. Stops the local stack when the job ends.

The runner is ephemeral. It does not connect to production, does not need a Supabase database password, and does not create a Supabase branch. It uses GitHub Actions runner time, not Supabase branch-hours.

Keep this job isolated from the Render deployment job. A schema-test PR must not trigger a production migration or deploy a database change.

## D. Phase 1 implementation sequence

After the local environment is reproducible:

1. Write the relational tenancy migration locally.
2. Add a local synthetic fixture with two organisations and one shared Auth identity.
3. Test membership uniqueness, organisation role scoping, global-versus-tenant record scope, and fail-closed behaviour.
4. Add tenant-aware repository functions without changing existing route behaviour yet.
5. Add route-level organisation context and membership checks.
6. Migrate legacy records in the local test database and assert exact collection counts.
7. Add cross-tenant read/update/delete tests, including known-ID access attempts.
8. Test storage path isolation using synthetic objects in local storage.
9. Run the existing regression suite and full CI.
10. Only after the migration and application code pass locally and the backup is verified, prepare a separate production deployment and migration review.

## E. Cost and safety boundaries

- Supabase development branch: **not created**.
- Additional Supabase project: **not created**.
- Production database DDL: **not changed**.
- Production data: **not copied into GitHub**.
- Git feature branches and repository documentation: no Supabase branch-hour cost.
- Local Docker stack: uses the developer's machine resources.
- GitHub Actions local-stack test: uses GitHub runner time; no Supabase branch is provisioned.
- Production migration: remains a separate, explicit release decision after backup and rehearsal.

## Phase 1 is not ready for production deployment until

- [ ] A restorable logical backup has been created and checksum-verified.
- [ ] The live migration versions and checked-in migration filenames match.
- [ ] The local Supabase stack starts and resets successfully.
- [ ] Synthetic fixtures cover the current production data shapes.
- [ ] Tenant isolation tests pass.
- [ ] Existing BidWatch CI passes.
- [ ] A production migration diff and rollback plan have been reviewed.
