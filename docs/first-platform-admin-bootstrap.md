# First platform administrator bootstrap

The platform administrator list is intentionally separate from organisation roles. A clean installation has no platform administrator until an operator performs this controlled bootstrap.

## Safety model

- There is no HTTP route for this operation.
- The script accepts an exact Supabase Auth user UUID, not an email address or user-editable metadata.
- It verifies the identity through the Supabase Auth Admin API before writing.
- It writes only one row to `public.platform_admins`; it does not create memberships, change roles, or edit application records.
- The script refuses every non-local Supabase URL. It is deliberately **not** a production bootstrap mechanism.
- An explicit confirmation phrase is required in addition to the local-host restriction.
- Re-running the operation for the same user is safe; the primary key and conflict handling prevent duplicate administrator rows.

## Local development

1. Start the local Supabase stack and apply the repository migrations.
2. Create or identify the Auth user in the local Auth instance. Obtain that user's UUID from the local Auth user list or the local Studio.
3. From the repository root, run:

```bash
BIDWATCH_BOOTSTRAP_CONFIRM=I_UNDERSTAND_THIS_GRANTS_PLATFORM_ADMIN \
BIDWATCH_BOOTSTRAP_USER_ID='<exact-auth-user-uuid>' \
SUPABASE_URL='http://127.0.0.1:54321' \
SUPABASE_SECRET_KEY='<local-service-role-secret>' \
npm run bootstrap:platform-admin
```

The local service-role secret is available from the local Supabase CLI status output. Do not paste it into source control, documentation, chat, or logs.

The script prints the verified Auth UUID only. It does not print the secret key.

## Production

Do not remove the localhost guard or use this script against a hosted project. Production first-owner provisioning requires a separately reviewed operational process with an approved operator, a verified identity, a change record, and a controlled privileged execution path. No production bootstrap is performed by this repository change.
