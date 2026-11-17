# BidWatch live attachment inventory and migration readiness

**Inspection date:** 17 November 2026  
**Project:** BidWatch (`morqfszgazeotndgbvfl`, eu-west-1)  
**Method:** Read-only SQL inspection through the connected Supabase project. No writes, schema changes, object copies, or deletions were performed.

## Executive result

The live project is still on the pre-multitenancy schema. Its migration history contains only:

- `20260918124946_bidwatch_runtime`
- `20260923071821_prevent_duplicate_bidwatch_users`

The `public.app_records` table has only `id`, `table_name`, `record`, `created_at`, and `updated_at`. It does not yet have `scope_type` or `organisation_id`; the `organisations`, `organisation_roles`, `organisation_members`, and `platform_admins` tables are absent.

Consequently, the PR's tenant-scoped attachment migration script cannot be run against this live schema yet. The inventory below is the real-environment, read-only equivalent; it is not the script's tenant-scoped dry-run output.

## Legacy record inventory

| `app_records.table_name` | Rows |
|---|---:|
| activity | 2 |
| bid_history | 1 |
| categories | 14 |
| opportunity_source_runs | 34 |
| opportunity_updates | 53 |
| roles | 18 |
| tenders | 1 |
| users | 1 |
| **Total** | **124** |

- Rows with a top-level `record.path`: **0**
- Rows with a top-level path beginning `tenders/`: **0**
- Rows in a table named `attachments`: **0**
- Tender and bid-history payloads inspected for top-level attachment arrays: **none found**
- The single live tender has no attachment metadata field in its payload.

## Storage inventory

| Resource | Result |
|---|---:|
| Bucket | `bidwatch` |
| Bucket visibility | Private |
| Total Storage objects | 0 |
| Objects under `tenders/` | 0 |
| Objects under `organisations/` | 0 |

There are currently no stored objects to map to attachment metadata. The bucket exists and is private.

## Ownership and migration preflight signals

- One existing user profile is present.
- Its `userId` and `roleId` are populated; the read-only check found no missing identity or role references.
- The profile is not marked inactive/suspended.
- The legacy role table contains six definitions each for `Super Admin`, `Bid Manager`, and `Member`. Each set of six has one distinct permissions definition, so the current migration's conflicting-permissions guard should not reject these duplicates on that criterion.
- One profile is assigned the `Super Admin` role.
- The PR's foundation migration has not been applied, so no legacy workspace ownership mapping has yet been materialised.

These checks are preliminary evidence only. They do not replace a reviewed migration preflight or backup verification.

## Decision

**Attachment migration candidate count: 0 based on the current live metadata and Storage inventory.**

**Migration readiness: blocked pending the separately approved multitenancy schema migration.** Do not run `scripts/migrate-legacy-attachments.ts` against this live project until the organisation tables and scope columns exist and the migration preflight has been reviewed.

No `--apply` run was performed. No Storage objects were copied, overwritten, or deleted. No metadata was updated.

## Separate live security-advisor findings

The Supabase security advisor also reports that the pre-existing `public.rls_auto_enable()` event-trigger function is `SECURITY DEFINER` and executable by `anon` and `authenticated`, and that leaked-password protection is disabled. The function's body is an RLS auto-enable event trigger, but its exposed execute ACL should be reviewed and restricted by a separately reviewed production change. These findings are not introduced by the PR migrations and were not modified during this inventory.
