# Phase 1 multitenancy migration and application rollback

## Scope

This runbook covers the Phase 1 organisation foundation migrations, the tenant-aware application release, and the legacy attachment copy-and-verify process. It is an operational guide, not an executable down migration.

## Important compatibility rule

Do not deploy the pre-multitenancy application against a database after tenant-scoped records have been written. The legacy repository does not filter app_records by scope_type and organisation_id; reverting only the application could expose records from multiple organisations to the legacy workspace.

## Before applying migrations

1. Confirm the target Supabase project and environment explicitly.
2. Take a database backup and verify that it can be restored. Record the current migration list and schema inventory.
3. Inventory Storage buckets and objects, and retain the report with the change record.
4. Review the Phase 1 migration preflight assumptions: every legacy user profile must map to an existing Auth identity and role; role definitions must have valid permission arrays; and the protected legacy Super Admin identity must exist.
5. Schedule a maintenance window. Pause application writes while the schema and application release are coordinated.
6. Apply the reviewed migrations in order, then deploy the tenant-aware application build. Do not enable new tenant writes until both schema and application versions are verified.

## If a migration fails

- The Phase 1 multitenancy migrations added by this PR use explicit transaction blocks, so a failure inside one of those files should roll back that file as a unit. The two pre-existing baseline migrations do not both declare an explicit transaction block.
- The full migration sequence is not one global transaction: earlier migration files may already have committed when a later file fails.
- Stop the rollout. Inspect the migration history and database state before retrying. Do not blindly rerun migrations, use db reset, or delete migration-history rows.
- Prefer a reviewed forward correction when the earlier migrations are valid. If the database must return to its exact pre-rollout state, use the verified backup restore procedure.

## If the application deployment fails

- If no tenant-aware writes have occurred, keep writes paused and restore the pre-rollout database backup and previous application version together.
- Do not simply redeploy the old application on top of the migrated database. The old repository does not enforce tenant scope.
- If tenant-aware writes have already occurred, do not restore only the old application. Either deploy a compatible tenant-aware build or plan a full database restore with explicit reconciliation of writes made after the backup.

## Attachment copy rollback

The legacy attachment script is a separate copy-and-verify operation. It retains the old object and stores the old path in record.legacyPath. If an application check fails, use a reviewed compare-and-swap metadata update to restore record.path from record.legacyPath. Leave the copied destination object in place until reconciliation is complete. The script does not delete originals.

## Destructive cleanup

Do not drop organisation tables, remove scope columns, delete original Storage objects, or attempt a hand-written reverse migration as routine rollback. Those actions can destroy tenant data or restore an unsafe legacy access model. Any such operation requires a separately reviewed recovery plan, verified backups, and explicit approval.

## Verification after recovery

- Confirm the expected migration history and application build.
- Confirm organisation membership and role boundaries using the local Supabase integration suite before reopening writes.
- Verify tenant-specific record reads and writes, attachment signed URLs, scheduled discovery, and scheduled reminders.
- Re-run Supabase security and performance advisors and document any remaining findings.
