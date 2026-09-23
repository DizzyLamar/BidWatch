# BidWatch portable deployment

BidWatch is being moved from the AppDeploy runtime to a conventional, portable stack:

- Render Web Service — one Node/Express service serves both the React build and /api/*.
- Supabase — Postgres-backed application data, Google authentication and private object storage.
- GitHub Actions — CI remains the source of truth and can run the daily reminder job without a paid Render cron service.
- Resend — remains the planned transactional email provider.

The existing API contract is preserved so the React workspace does not need a platform-specific rewrite.

## Required environment

### Render
- SUPABASE_URL
- SUPABASE_SECRET_KEY — server-only Supabase secret key. Never expose it to the browser.
- BIDWATCH_STORAGE_BUCKET=bidwatch
- CRON_SECRET
- NODE_ENV=production
- VITE_SUPABASE_URL
- VITE_SUPABASE_PUBLISHABLE_KEY

Supabase currently recommends a publishable key for browser code and a secret key only on a trusted backend.

## Supabase setup

Apply supabase/migrations/20260918000000_bidwatch_runtime.sql to a new Supabase project. Keep future schema changes in versioned migrations.

Enable Google under Supabase Authentication → Providers. Configure the production Render URL as the Site URL/allowed redirect target. Supabase supports Google sign-in through signInWithOAuth with provider google.

Create a Google OAuth Web client in Google Cloud and configure the callback URL shown by Supabase. Google OAuth requires the application's allowed origins and redirect configuration.

## Render

Create the Web Service from render.yaml, or configure manually:

- Build: npm install && npm run build
- Start: npm start
- Health check: /healthz

Render supports Node/Express web services and automatic deploys from a connected Git branch.

The free web service can spin down after inactivity, so it is suitable for a no-cost migration/staging target but is not an always-on production guarantee.

## Storage

BidWatch uses a private bidwatch bucket. The backend creates one-hour signed URLs for downloads, while direct browser access to the bucket is denied.

## Reminders

Render cron jobs are a separately billed service, so the no-cost path uses the existing daily reminder logic behind POST /api/internal/reminders, protected by CRON_SECRET.

The scheduled GitHub Actions job should send X-Cron-Secret to the Render service URL once the service is created.

## Migration safety

Do not delete the AppDeploy application until the replacement has passed:

1. Supabase schema/storage setup.
2. Google sign-in.
3. Provisioned-user RBAC.
4. Tender CRUD and optimistic concurrency.
5. Attachment upload/download/delete.
6. Bid history.
7. Opportunities and deadline verification.
8. KPIs and administration.
9. Reminder execution.
10. Existing-data export/import, if the current AppDeploy workspace contains records that must be retained.

No AppDeploy data is deleted by this branch.
