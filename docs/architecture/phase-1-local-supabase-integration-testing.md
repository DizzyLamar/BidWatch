# Phase 1 local Supabase integration tests

These tests exercise the real local Supabase services and BidWatch's production code paths. They create temporary Auth users, two organisations, role and membership rows, global user profiles, tenant-owned records, and a private Storage bucket when one does not already exist.

The suite runs the actual Express API router over an ephemeral localhost HTTP server. It verifies Auth, organisation discovery, tenant-scoped API reads, forged-header rejection, attachment upload, signed URL issuance, cross-tenant attachment denial, and attachment deletion. It also exercises the production organisation middleware and scoped repository directly against local PostgREST.

The tests are deliberately separate from `npm test`: the normal unit suite remains fast and does not require Docker or a running Supabase stack.

## Safety boundaries

- Run only against the local Supabase API at `127.0.0.1`, `localhost`, or `::1`.
- The test refuses a non-local Supabase URL before creating test data.
- It uses temporary `example.test` identities and random workspace names.
- It removes the records, memberships, roles, organisations, Auth users and uploaded objects it creates.
- If the private `bidwatch` bucket does not exist, the test creates it and removes it afterwards. If it already exists, the test requires it to be private and leaves the bucket itself intact.
- It does not link to, query or modify the hosted Supabase project.
- Do not run `supabase db reset`, `supabase db push --remote`, or any production migration as part of this test.

## Migration behaviour

The Phase 1 migration supports both existing and clean installations:

- On an existing installation with legacy user profiles, the preflight validates their Auth identities and role mappings, then backfills the legacy workspace, organisation roles, memberships and platform administrators.
- On a clean local/test database with no legacy profiles, it creates an empty Legacy BidWatch Workspace. It does not invent a platform administrator or grant ownership to an arbitrary account. A controlled first-owner bootstrap operation is still required before that empty workspace can be administered.

The migration is applied automatically when a fresh local Supabase stack starts. For an existing local database, inspect migration state with `npx supabase migration list --local`. Do not reset the database to re-run an edited migration; use a new corrective migration if a previously applied schema change needs adjustment.

## Start the required local services

The CI workflow uses the following lightweight service set. It keeps Postgres, Kong, Auth, PostgREST and Storage enabled while excluding optional services:

```bash
npx supabase stop
npx supabase start --exclude realtime,imgproxy,studio,mailpit,edge-runtime,analytics,vector,supavisor
```

Check the service status:

```bash
npx supabase status
```

Confirm the API URL is `http://127.0.0.1:54321` and that Auth, REST and Storage are available. Do not continue if the CLI reports any of these required services as stopped.

## Export local credentials without displaying them

From the repository root, in the same terminal session:

```bash
eval "$(npx supabase status -o env)"
export SUPABASE_URL="$API_URL"
export SUPABASE_ANON_KEY="$ANON_KEY"
export SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY"
```

The values come from the local CLI stack. Do not paste or share the service-role key. Do not put these values in a committed `.env` file.

## Run the integration suite

```bash
npm run test:integration
```

The suite verifies:

1. Real Auth users can sign in and BidWatch's `requireAuth` middleware validates their access tokens.
2. A member cannot select an organisation where they have no active membership, even by forging `X-Organisation-Id`.
3. The organisation middleware resolves membership, role and permissions from PostgREST.
4. Two real organisation scopes can create records, but each can only read its own records.
5. Cross-organisation repository updates and deletes are rejected without changing the original row.
6. Authenticated clients cannot directly read or write backend-only tables or `app_records`.
7. Authenticated clients cannot upload, download or mint signed URLs directly from the private Storage bucket.
8. The actual Express API returns only the caller's organisations and tenant records, and rejects forged organisation headers.
9. The API uploads a file under the organisation's storage prefix, issues a signed URL only after checking attachment ownership, rejects another tenant's attachment lookup, and removes both the object and metadata on deletion.
10. Cross-organisation role assignment is rejected by the composite database foreign key.
11. Requests without a valid Auth token cannot establish organisation context.

The test cleans up its temporary data in a `finally` block. If the process is forcibly interrupted before cleanup, remove only the test records and Auth users identified by their random `bidwatch-a` / `bidwatch-b` suffix; do not truncate shared tables.

## Normal validation

The integration test does not replace the ordinary checks:

```bash
npm run typecheck
npm test
npm run build
npm run test:integration
```

A successful in-memory unit suite is not a substitute for the real-service suite. Passing local or CI integration tests is not approval to migrate, merge or deploy production.
