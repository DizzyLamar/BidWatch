# Phase 1 local Supabase integration tests

These tests exercise the real local Supabase Auth and PostgREST services. They create temporary Auth users, two organisations, role and membership rows, and tenant-owned `app_records`. They then execute BidWatch's actual authentication middleware, organisation middleware and scoped repository against the local PostgREST API.

They are deliberately separate from `npm test`: the normal unit suite remains fast and does not require Docker or a running Supabase stack.

## Safety boundaries

- Run only against the local Supabase API at `127.0.0.1` or `localhost`.
- The test refuses a non-local Supabase URL before creating any data.
- It uses temporary `example.test` identities and random workspace names.
- It removes the records, memberships, roles, organisations and Auth users it creates.
- It does not link to, query or modify the hosted Supabase project.
- Do not run `supabase db reset`, `supabase db push --remote`, or any production migration as part of this test.

The local Phase 1 migration must already be applied. The migration's preflight intentionally requires the legacy user/role fixture used by the local migration validation, so a fresh database reset without that fixture will fail rather than silently bootstrap an incomplete workspace.

## Start the required local services

The existing lightweight setup may have started only Postgres and Storage. Auth and PostgREST are also required. To preserve the existing local database volume while changing the service set, stop the stack normally (do not use `--no-backup`) and start it with only the unnecessary services excluded:

```bash
npx supabase stop
npx supabase start --exclude realtime,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
```

This keeps Postgres, Kong, Auth (GoTrue), PostgREST and Storage enabled. Supabase recommends around 7 GB RAM for the full stack; excluding Studio, analytics and other optional services keeps this setup lighter.

Check the service status:

```bash
npx supabase status
```

Confirm the API URL is `http://127.0.0.1:54321` and that Auth and REST are available. Do not continue if the CLI reports either service as stopped.

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

The test verifies:

1. Real Auth users can sign in and their access tokens are validated by BidWatch's `requireAuth` middleware.
2. A member cannot select an organisation where they have no active membership, even by forging `X-Organisation-Id`.
3. The organisation middleware resolves the selected organisation and its relational role/permissions from PostgREST.
4. Two real organisation scopes can create records, but each can only read its own records.
5. Cross-organisation update and delete attempts are rejected, and the original row remains unchanged.
6. Requests without a valid Auth token cannot establish organisation context.

The test cleans up its temporary data in a `finally` block. If the process is interrupted before cleanup, remove only the test records identified by the `bidwatch-a` / `bidwatch-b` test workspace names and their corresponding test Auth users; do not truncate shared tables.

## Normal validation

The integration test does not replace the existing checks:

```bash
npm test
npm run typecheck
npm run build
```

A successful in-memory unit suite is not a substitute for this real-service test. Likewise, passing this local integration suite is not approval to migrate, merge or deploy production.
