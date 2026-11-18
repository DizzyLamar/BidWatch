# Legacy attachment migration

## Purpose

Move attachment metadata that still points to the legacy `tenders/` storage prefix into the organisation-owned `organisations/{organisationId}/tenders/{tenderId}/` namespace.

This migration is a copy-and-verify operation. It does not delete legacy objects.

## Safety properties

- The script targets only the active `legacy-bidwatch-workspace`.
- It only considers `attachments` rows scoped to that organisation whose current `record.path` starts with `tenders/`.
- It verifies that the referenced tender belongs to the same organisation before copying.
- Destination names are deterministic, so an interrupted run can safely resume.
- Existing destination objects are reused only after their SHA-256 digest matches the source.
- Metadata is updated only if the original path is still the current path (compare-and-swap).
- The original path is retained in `record.legacyPath`; storage inventory and cleanup treat it as tracked.
- There is no automatic deletion of original storage objects.

## Runbook

1. Take and verify the normal database and Storage backups.
2. Run the script without `--apply`. This is the default dry-run and reads metadata only:

   ```bash
   SUPABASE_URL="$SUPABASE_URL" \
   SUPABASE_SECRET_KEY="$SUPABASE_SECRET_KEY" \
   npx tsx scripts/migrate-legacy-attachments.ts
   ```

3. Review the report. Investigate missing tender references, unexpected paths, or a candidate count that differs from the attachment inventory.
4. Only after a separately approved maintenance window, run with `--apply`:

   ```bash
   SUPABASE_URL="$SUPABASE_URL" \
   SUPABASE_SECRET_KEY="$SUPABASE_SECRET_KEY" \
   npx tsx scripts/migrate-legacy-attachments.ts --apply
   ```

5. Review every outcome. A successful item means the destination was downloaded again and byte-for-byte SHA-256 verified before metadata was repointed.
6. Exercise attachment listing, signed URL retrieval, download, and deletion through the application in the legacy workspace.
7. Keep original objects and `legacyPath` metadata until the application checks, backups, and retention requirements have been signed off.

## Rollback

If an application-level verification fails, restore the affected attachment metadata `record.path` to its retained `record.legacyPath` value using a reviewed, compare-and-swap update. Do not delete the copied destination during rollback; it is harmless and can be reconciled after the cause is understood.

## Original-object cleanup

Original objects are deliberately retained. Removing `tenders/` objects is a separate destructive operation and requires explicit approval after the migration report, application verification, and backup verification have all been reviewed. Do not use the ordinary orphan-cleanup endpoint as a substitute for this sign-off.
