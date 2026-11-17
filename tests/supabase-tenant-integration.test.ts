import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import type { Request, Response } from 'express';
import type { DatabaseScope } from '../backend/scoped-records';

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SECRET_KEY;

type Context = {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, unknown>;
  user?: { userId: string; email: string; name: string };
  organisation?: {
    id: string;
    slug: string;
    name: string;
    membershipId: string;
    roleId: string;
    roleKey: string;
    roleName: string;
    permissions: string[];
    isPlatformAdmin: boolean;
  };
  req: Request;
  res: Response;
};

test('local Supabase Auth and PostgREST enforce real organisation boundaries', async t => {
  assert.ok(supabaseUrl && anonKey && serviceKey, 'Export SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SECRET_KEY from the local Supabase CLI before running integration tests.');
  const configuredHost = new URL(supabaseUrl!).hostname;
  assert.ok(
    configuredHost === '127.0.0.1' || configuredHost === 'localhost' || configuredHost === '::1',
    'Integration tests are restricted to localhost; refusing to create test data on a remote Supabase project.',
  );

  let bucketCreated = false;
  const admin = createClient(supabaseUrl!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const anon = createClient(supabaseUrl!, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  // Ensure the bucket exists before testing direct-client denial. A missing
  // bucket must never be mistaken for a successful authorization test.
  const { data: buckets, error: bucketsError } = await admin.storage.listBuckets();
  assert.ifError(bucketsError);
  const existingBucket = (buckets || []).find(bucket => bucket.id === 'bidwatch');
  if (existingBucket) {
    assert.equal(existingBucket.public, false, 'the integration bucket must be private');
  } else {
    const { error: createBucketError } = await admin.storage.createBucket('bidwatch', { public: false });
    assert.ifError(createBucketError);
    bucketCreated = true;
  }

  // Import only after environment variables are present: runtime.ts creates
  // its server-side Supabase client from SUPABASE_URL and SUPABASE_SECRET_KEY.
  const runtime = await import('../backend/runtime');
  const tenancy = await import('../backend/tenancy');
  const scoped = await import('../backend/scoped-records');

  const suffix = randomUUID();
  const identities: Array<{ id: string; email: string }> = [];
  const organisationIds: string[] = [];
  const roleIds: string[] = [];
  const membershipIds: string[] = [];
  const profileIds: string[] = [];
  const recordIds: string[] = [];
  let httpServer: ReturnType<ReturnType<typeof express>['listen']> | null = null;
  let apiBaseUrl = '';
  const tokens = new Map<string, string>();
  let currentScope: DatabaseScope | null = null;

  async function createIdentity(label: string) {
    const email = `bidwatch-${label}-${suffix}@example.test`;
    const password = `Bw!Integration-${randomUUID()}-9x`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    assert.ifError(error);
    assert.ok(data.user);
    identities.push({ id: data.user.id, email });

    const { data: session, error: signInError } = await anon.auth.signInWithPassword({ email, password });
    assert.ifError(signInError);
    assert.ok(session.session?.access_token);
    tokens.set(data.user.id, session.session.access_token);
    return data.user.id;
  }

  async function createOrganisation(name: string, slug: string, userId: string) {
    const { data: organisation, error: organisationError } = await admin
      .from('organisations')
      .insert({ name, slug: `${slug}-${suffix.slice(0, 8)}`, status: 'active', created_by: userId })
      .select('id')
      .single();
    assert.ifError(organisationError);
    organisationIds.push(organisation.id);

    const { data: role, error: roleError } = await admin
      .from('organisation_roles')
      .insert({
        organisation_id: organisation.id,
        key: 'member',
        name: 'Member',
        permissions: ['bids.view', 'bids.create', 'attachments.upload', 'attachments.delete'],
        is_system: true,
      })
      .select('id')
      .single();
    assert.ifError(roleError);
    roleIds.push(role.id);

    const { data: membership, error: membershipError } = await admin
      .from('organisation_members')
      .insert({
        organisation_id: organisation.id,
        user_id: userId,
        role_id: role.id,
        status: 'active',
        joined_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    assert.ifError(membershipError);
    membershipIds.push(membership.id);

    const { data: profile, error: profileError } = await admin.from('app_records').insert({
      table_name: 'users',
      record: {
        userId,
        email: identities.find(identity => identity.id === userId)!.email,
        name,
        roleId: role.id,
        active: true,
        status: 'Active',
        createdAt: new Date().toISOString(),
      },
      scope_type: 'global',
      organisation_id: null,
    }).select('id').single();
    assert.ifError(profileError);
    profileIds.push(profile.id);
    return organisation.id;
  }

  function authenticatedClient(userId: string) {
    const token = tokens.get(userId);
    assert.ok(token);
    return createClient(supabaseUrl!, anonKey!, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
  }

  async function authenticatedContext(userId: string, organisationId?: string): Promise<Context> {
    const token = tokens.get(userId);
    assert.ok(token);
    const ctx: Context = {
      body: {},
      params: {},
      query: {},
      req: {
        headers: {
          authorization: `Bearer ${token}`,
          ...(organisationId ? { 'x-organisation-id': organisationId } : {}),
        },
      } as Request,
      res: {} as Response,
    } satisfies Context;

    const authResult = await runtime.requireAuth()(ctx);
    assert.equal(authResult, undefined, 'valid local Auth access token should authenticate');
    assert.equal(ctx.user?.userId, userId);
    return ctx;
  }

  try {
    const userA = await createIdentity('a');
    const userB = await createIdentity('b');
    const orgA = await createOrganisation('Integration Workspace A', 'integration-a', userA);
    const orgB = await createOrganisation('Integration Workspace B', 'integration-b', userB);

    await t.test('controlled bootstrap grants only the explicitly selected Auth identity', async () => {
      const bootstrap = await import('../scripts/bootstrap-platform-admin');
      const first = await bootstrap.bootstrapFirstPlatformAdmin(admin, userA);
      assert.equal(first.userId, userA);
      assert.equal(first.alreadyProvisioned, false);

      const repeated = await bootstrap.bootstrapFirstPlatformAdmin(admin, userA);
      assert.equal(repeated.alreadyProvisioned, true);

      const { data: adminA, error: adminAError } = await admin
        .from('platform_admins').select('user_id').eq('user_id', userA).maybeSingle();
      assert.ifError(adminAError);
      assert.equal(adminA?.user_id, userA);

      const { data: adminB, error: adminBError } = await admin
        .from('platform_admins').select('user_id').eq('user_id', userB).maybeSingle();
      assert.ifError(adminBError);
      assert.equal(adminB, null, 'the bootstrap must not grant platform access to another identity');

      await assert.rejects(
        bootstrap.bootstrapFirstPlatformAdmin(admin, randomUUID()),
        /Could not verify the Auth identity|Auth identity does not exist/,
      );
    });

    const tenderA = randomUUID();
    const tenderB = randomUUID();
    for (const [id, organisationId, title] of [
      [tenderA, orgA, 'Private tender belonging to A'],
      [tenderB, orgB, 'Private tender belonging to B'],
    ] as const) {
      const { error: tenderError } = await admin.from('app_records').insert({
        id,
        table_name: 'tenders',
        record: {
          title,
          organisation: 'Integration client',
          reference: '',
          description: '',
          deadline: '2099-12-31',
          source: 'integration-test',
          url: 'https://example.test/tender',
          category: 'Other',
          status: 'New',
          assigneeId: '',
          submittedBy: userA,
          submittedAt: new Date().toISOString(),
          notes: '',
          revision: 1,
        },
        scope_type: 'organisation',
        organisation_id: organisationId,
      });
      assert.ifError(tenderError);
      recordIds.push(id);
    }

    const api = await import('../backend/index');
    const app = express();
    app.use(express.json({ limit: '15mb' }));
    app.use(api.handler);
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      httpServer!.once('listening', resolve);
      httpServer!.once('error', reject);
    });
    const address = httpServer.address();
    assert.ok(address && typeof address !== 'string');
    apiBaseUrl = `http://127.0.0.1:${address.port}`;

    async function apiRequest(userId: string, organisationId: string | undefined, route: string, init: RequestInit = {}) {
      const token = tokens.get(userId);
      assert.ok(token);
      return fetch(`${apiBaseUrl}${route}`, {
        ...init,
        headers: {
          ...(init.headers || {}),
          Authorization: `Bearer ${token}`,
          ...(organisationId ? { 'X-Organisation-Id': organisationId } : {}),
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
    }

    await t.test('organisation administrators can invite, accept, change roles, suspend, reactivate and remove members', async () => {
      const { data: ownerRole, error: ownerRoleLookupError } = await admin.from('organisation_roles')
        .select('id').eq('organisation_id', orgA).single();
      assert.ifError(ownerRoleLookupError);
      const { error: permissionError } = await admin.from('organisation_roles')
        .update({ permissions: ['bids.view', 'users.view', 'users.manage'] })
        .eq('organisation_id', orgA).eq('id', ownerRole.id);
      assert.ifError(permissionError);

      const invitedEmail = `bidwatch-invited-${suffix}@example.test`;
      const inviteResponse = await apiRequest(userA, orgA, '/api/admin/users', {
        method: 'POST', body: JSON.stringify({ email: invitedEmail, name: 'Invited Test User', roleId: ownerRole.id }),
      });
      assert.equal(inviteResponse.status, 201, await inviteResponse.text());

      const { data: profileRow, error: profileLookupError } = await admin.from('app_records')
        .select('id,record').eq('table_name', 'users').contains('record', { email: invitedEmail }).single();
      assert.ifError(profileLookupError);
      assert.ok(profileRow?.record?.userId);
      profileIds.push(profileRow.id);
      const invitedUserId = String(profileRow.record.userId);
      const { data: invitedIdentity, error: invitedIdentityError } = await admin.auth.admin.getUserById(invitedUserId);
      assert.ifError(invitedIdentityError);
      assert.ok(invitedIdentity.user);
      identities.push({ id: invitedUserId, email: invitedEmail });

      const { data: membership, error: membershipLookupError } = await admin.from('organisation_members')
        .select('id,status,role_id').eq('organisation_id', orgA).eq('user_id', invitedUserId).single();
      assert.ifError(membershipLookupError);
      assert.equal(membership.status, 'invited');
      membershipIds.push(membership.id);

      // Simulate the verified sign-in that follows the invitation. The API
      // activates only invitations belonging to this exact Auth user UUID.
      const invitePassword = `Bw!Integration-${randomUUID()}-9x`;
      const { error: confirmError } = await admin.auth.admin.updateUserById(invitedUserId, {
        email_confirm: true, password: invitePassword,
      });
      assert.ifError(confirmError);
      const { data: signedIn, error: signInError } = await anon.auth.signInWithPassword({
        email: invitedEmail, password: invitePassword,
      });
      assert.ifError(signInError);
      assert.ok(signedIn.session?.access_token);
      tokens.set(invitedUserId, signedIn.session.access_token);

      const organisationsResponse = await apiRequest(invitedUserId, undefined, '/api/organisations');
      assert.equal(organisationsResponse.status, 200, await organisationsResponse.text());
      const organisationsBody = await organisationsResponse.json() as { organisations: Array<{ id: string }> };
      assert.ok(organisationsBody.organisations.some(item => item.id === orgA));
      const { data: acceptedMembership, error: acceptedMembershipError } = await admin.from('organisation_members')
        .select('status').eq('id', membership.id).single();
      assert.ifError(acceptedMembershipError);
      assert.equal(acceptedMembership.status, 'active');
      await anon.auth.signOut();

      const { data: observerRole, error: observerRoleError } = await admin.from('organisation_roles')
        .insert({ organisation_id: orgA, key: `observer_${suffix.slice(0, 8)}`, name: 'Integration Observer', permissions: ['bids.view'], is_system: false })
        .select('id').single();
      assert.ifError(observerRoleError);
      roleIds.push(observerRole.id);
      const changedRole = await apiRequest(userA, orgA, `/api/admin/users/${membership.id}`, {
        method: 'PUT', body: JSON.stringify({ roleId: observerRole.id }),
      });
      assert.equal(changedRole.status, 200, await changedRole.text());
      const wrongTenantRole = await apiRequest(userA, orgA, `/api/admin/users/${membership.id}`, {
        method: 'PUT', body: JSON.stringify({ roleId: (await admin.from('organisation_roles').select('id').eq('organisation_id', orgB).single()).data!.id }),
      });
      assert.equal(wrongTenantRole.status, 400);

      const suspended = await apiRequest(userA, orgA, `/api/admin/users/${membership.id}`, {
        method: 'PUT', body: JSON.stringify({ status: 'suspended' }),
      });
      assert.equal(suspended.status, 200, await suspended.text());
      const reactivated = await apiRequest(userA, orgA, `/api/admin/users/${membership.id}`, {
        method: 'PUT', body: JSON.stringify({ status: 'active' }),
      });
      assert.equal(reactivated.status, 200, await reactivated.text());
      const removed = await apiRequest(userA, orgA, `/api/admin/users/${membership.id}`, { method: 'DELETE' });
      assert.equal(removed.status, 200, await removed.text());
      const { data: finalMembership, error: finalMembershipError } = await admin.from('organisation_members')
        .select('status').eq('id', membership.id).single();
      assert.ifError(finalMembershipError);
      assert.equal(finalMembership.status, 'removed');
    });

    const invalidCtx = {
      body: {},
      params: {},
      query: {},
      req: { headers: { authorization: 'Bearer invalid-token' } } as Request,
      res: {} as Response,
    } satisfies Context;
    const invalidAuth = await runtime.requireAuth()(invalidCtx);
    assert.equal((invalidAuth as { status?: number })?.status, 401);

    await t.test('real Auth tokens resolve their corresponding identities', async () => {
      const ctxA = await authenticatedContext(userA, orgA);
      const ctxB = await authenticatedContext(userB, orgB);
      assert.notEqual(ctxA.user?.userId, ctxB.user?.userId);
    });

    const applyScope = (scope: DatabaseScope) => { currentScope = scope; };
    const resolveOrganisation = tenancy.createRequireOrganisationMiddleware(admin, applyScope);
    const repository = scoped.createScopedRecordRepository(admin, () => currentScope);

    await t.test('PostgREST membership checks reject a forged organisation header', async () => {
      const ctx = await authenticatedContext(userA, orgB);
      const result = await resolveOrganisation(ctx);
      assert.equal((result as { status?: number })?.status, 403);
      assert.equal(ctx.organisation, undefined);
      assert.equal(currentScope, null);
    });

    await t.test('real membership and role rows establish tenant context', async () => {
      const ctx = await authenticatedContext(userA, orgA);
      const result = await resolveOrganisation(ctx);
      assert.equal(result, undefined);
      assert.equal(ctx.organisation?.id, orgA);
      assert.equal(ctx.organisation?.roleKey, 'member');
      assert.deepEqual(ctx.organisation?.permissions, ['bids.view', 'bids.create', 'attachments.upload', 'attachments.delete']);
      assert.deepEqual(currentScope, { kind: 'organisation', organisationId: orgA, legacyStorage: false });
    });

    await t.test('PostgREST queries isolate two organisations and reject cross-tenant writes', async () => {
      currentScope = { kind: 'organisation', organisationId: orgA };
      const [recordA] = await repository.add('tenders', [{ title: 'A private tender' }]);
      recordIds.push(recordA);

      currentScope = { kind: 'organisation', organisationId: orgB };
      const [recordB] = await repository.add('tenders', [{ title: 'B private tender' }]);
      recordIds.push(recordB);

      currentScope = { kind: 'organisation', organisationId: orgA };
      const visibleA = await repository.list<{ title: string }>('tenders');
      const visibleAIds = new Set(visibleA.items.map(row => row.id));
      assert.deepEqual(
        [...visibleAIds].sort(),
        [tenderA, recordA].sort(),
        'A must see both of its own fixture records and no records belonging to B',
      );
      assert.deepEqual(await repository.get('tenders', [recordB]), []);

      currentScope = { kind: 'organisation', organisationId: orgB };
      const visibleB = await repository.list<{ title: string }>('tenders');
      const visibleBIds = new Set(visibleB.items.map(row => row.id));
      assert.deepEqual(
        [...visibleBIds].sort(),
        [tenderB, recordB].sort(),
        'B must see both of its own fixture records and no records belonging to A',
      );

      await assert.rejects(
        repository.update('tenders', [{ id: recordA, record: { title: 'tampered by B' } }]),
        /Scoped update rejected/,
      );
      await assert.rejects(repository.delete('tenders', [recordA]), /Scoped delete rejected/);

      const { data: storedA, error: readError } = await admin
        .from('app_records').select('record').eq('id', recordA).single();
      assert.ifError(readError);
      assert.equal(storedA.record.title, 'A private tender');
    });

    await t.test('direct client access cannot bypass backend-only tables or app_records RLS', async () => {
      const clientA = authenticatedClient(userA);

      const { data: organisationRows, error: organisationError } = await clientA
        .from('organisations').select('id').eq('id', orgA);
      assert.ok(organisationError, 'authenticated clients must not have direct organisation-table privileges');
      assert.equal(organisationRows, null);

      const { data: membershipRows, error: membershipError } = await clientA
        .from('organisation_members').select('id').eq('user_id', userA);
      assert.ok(membershipError, 'authenticated clients must not have direct membership-table privileges');
      assert.equal(membershipRows, null);

      const { data: appRows, error: appReadError } = await clientA
        .from('app_records').select('id').eq('table_name', 'tenders');
      assert.ifError(appReadError);
      assert.deepEqual(appRows, [], 'the deny-all app_records policy must hide backend records');

      const { error: appWriteError } = await clientA.from('app_records').insert({
        table_name: 'tenders',
        record: { title: 'forged direct client write' },
        scope_type: 'organisation',
        organisation_id: orgA,
      });
      assert.ok(appWriteError, 'direct authenticated writes to app_records must be denied');

      const { error: storageError } = await clientA.storage
        .from('bidwatch')
        .upload(`integration/${suffix}/blocked.txt`, 'blocked', { contentType: 'text/plain' });
      assert.ok(storageError, 'direct authenticated uploads must be denied by the storage policy');
      assert.match(
        String(storageError.message || ''),
        /row-level security|not authorized|permission denied|unauthorized/i,
        'the denial must come from Storage authorization, not a missing bucket or unrelated failure',
      );

      const ctx = await authenticatedContext(userA, orgA);
      const platformAdminResult = await tenancy.requirePlatformAdmin()(ctx);
      assert.equal((platformAdminResult as { status?: number })?.status, 403);
    });

    await t.test('database constraints reject assigning a role from another organisation', async () => {
      const { error: crossOrganisationRoleError } = await admin
        .from('organisation_members')
        .insert({
          organisation_id: orgA,
          user_id: userB,
          role_id: roleIds[1],
          status: 'active',
        });
      assert.ok(crossOrganisationRoleError);
      assert.equal(crossOrganisationRoleError.code, '23503');
    });

    await t.test('real Express API routes enforce organisation boundaries', async () => {
      const organisationsA = await apiRequest(userA, undefined, '/api/organisations');
      assert.equal(organisationsA.status, 200);
      const organisationBodyA = await organisationsA.json() as { organisations: Array<{ id: string }> };
      assert.deepEqual(organisationBodyA.organisations.map(item => item.id), [orgA]);

      const organisationsB = await apiRequest(userB, undefined, '/api/organisations');
      assert.equal(organisationsB.status, 200);
      const organisationBodyB = await organisationsB.json() as { organisations: Array<{ id: string }> };
      assert.deepEqual(organisationBodyB.organisations.map(item => item.id), [orgB]);

      const responseA = await apiRequest(userA, orgA, '/api/tenders');
      assert.equal(responseA.status, 200);
      const tendersA = await responseA.json() as { tenders: Array<{ id: string; title: string }> };
      assert.ok(tendersA.tenders.some(item => item.id === tenderA && item.title === 'Private tender belonging to A'));
      assert.ok(tendersA.tenders.every(item => item.id !== tenderB), 'A must never receive B\'s tender through the HTTP API');

      const responseB = await apiRequest(userB, orgB, '/api/tenders');
      assert.equal(responseB.status, 200);
      const tendersB = await responseB.json() as { tenders: Array<{ id: string; title: string }> };
      assert.ok(tendersB.tenders.some(item => item.id === tenderB && item.title === 'Private tender belonging to B'));
      assert.ok(tendersB.tenders.every(item => item.id !== tenderA), 'B must never receive A\'s tender through the HTTP API');

      const forged = await apiRequest(userB, orgA, '/api/tenders');
      assert.equal(forged.status, 403, 'a real HTTP request cannot switch tenants by forging the organisation header');
    });

    await t.test('attachment upload, signed URL, cross-tenant denial and deletion work end to end', async () => {
      const fileText = 'BidWatch tenant storage integration proof';
      const content = Buffer.from(fileText, 'utf8').toString('base64');
      const upload = await apiRequest(userA, orgA, `/api/tenders/${tenderA}/attachments`, {
        method: 'POST',
        body: JSON.stringify({
          filename: 'proof.txt',
          mimeType: 'text/plain',
          size: Buffer.byteLength(fileText),
          content,
        }),
      });
      assert.equal(upload.status, 201, `attachment upload returned HTTP ${upload.status}`);
      const uploadBody = await upload.json() as { attachment: { id: string; filename: string } };
      assert.equal(uploadBody.attachment.filename, 'proof.txt');
      const attachmentId = uploadBody.attachment.id;

      const folder = `organisations/${orgA}/tenders/${tenderA}`;
      const { data: uploadedObjects, error: listUploadedError } = await admin.storage.from('bidwatch').list(folder, { limit: 100 });
      assert.ifError(listUploadedError);
      assert.equal(uploadedObjects?.length, 1, 'the object must exist in its organisation-owned storage prefix');
      const objectPath = `${folder}/${uploadedObjects![0].name}`;

      const directDownload = await authenticatedClient(userA).storage.from('bidwatch').download(objectPath);
      assert.ok(directDownload.error, 'authenticated clients must not download private objects directly');
      const directSignedUrl = await authenticatedClient(userA).storage.from('bidwatch').createSignedUrl(objectPath, 60);
      assert.ok(directSignedUrl.error, 'authenticated clients must not mint Storage signed URLs directly');

      const signedUrlResponse = await apiRequest(userA, orgA, `/api/attachments/${attachmentId}/url`);
      assert.equal(signedUrlResponse.status, 200);
      const signedUrlBody = await signedUrlResponse.json() as { url: string };
      assert.ok(signedUrlBody.url);
      const fileResponse = await fetch(signedUrlBody.url);
      assert.equal(fileResponse.status, 200);
      assert.equal(await fileResponse.text(), fileText);

      const crossTenantUrl = await apiRequest(userB, orgB, `/api/attachments/${attachmentId}/url`);
      assert.equal(crossTenantUrl.status, 404, 'another organisation must not resolve the attachment metadata or signed URL');

      const deleted = await apiRequest(userA, orgA, `/api/attachments/${attachmentId}`, { method: 'DELETE' });
      assert.equal(deleted.status, 200, await deleted.text().catch(() => ''));

      const { data: remainingObjects, error: listRemainingError } = await admin.storage.from('bidwatch').list(folder, { limit: 100 });
      assert.ifError(listRemainingError);
      assert.deepEqual(remainingObjects, [], 'deleting attachment metadata through the API must remove the stored object too');

      const afterDelete = await apiRequest(userA, orgA, `/api/attachments/${attachmentId}/url`);
      assert.equal(afterDelete.status, 404, 'deleted attachment metadata must no longer produce a signed URL');
    });

    await t.test('unauthenticated requests cannot resolve an organisation', async () => {
      const ctx = {
        body: {}, params: {}, query: {},
        req: { headers: {} } as Request,
        res: {} as Response,
      } satisfies Context;
      const result = await resolveOrganisation(ctx);
      assert.equal((result as { status?: number })?.status, 401);
    });
  } finally {
    currentScope = null;
    if (httpServer) {
      await new Promise<void>((resolve, reject) => httpServer!.close(error => error ? reject(error) : resolve()));
    }
    // Remove any object left behind if an assertion failed before the API
    // lifecycle test reached its deletion step.
    for (const organisationId of organisationIds) {
      const { data: organisationRows } = await admin.from('app_records').select('id').eq('organisation_id', organisationId);
      const tenderRecordIds = (organisationRows || []).filter(row => recordIds.includes(row.id)).map(row => row.id);
      for (const tenderId of tenderRecordIds) {
        const folder = `organisations/${organisationId}/tenders/${tenderId}`;
        const { data: objects } = await admin.storage.from('bidwatch').list(folder, { limit: 100 });
        if (objects?.length) await admin.storage.from('bidwatch').remove(objects.map(object => `${folder}/${object.name}`));
      }
    }
    for (const organisationId of organisationIds) {
      // Remove every tenant-owned test record, including activity rows created
      // by the real HTTP handlers, before deleting the organisation itself.
      const { error } = await admin.from('app_records').delete().eq('organisation_id', organisationId);
      if (error) throw error;
    }
    if (profileIds.length) {
      const { error } = await admin.from('app_records').delete().in('id', profileIds);
      if (error) throw error;
    }
    if (membershipIds.length) {
      const { error } = await admin.from('organisation_members').delete().in('id', membershipIds);
      if (error) throw error;
    }
    if (roleIds.length) {
      const { error } = await admin.from('organisation_roles').delete().in('id', roleIds);
      if (error) throw error;
    }
    if (organisationIds.length) {
      const { error } = await admin.from('organisations').delete().in('id', organisationIds);
      if (error) throw error;
    }
    for (const identity of identities) {
      const { error } = await admin.auth.admin.deleteUser(identity.id);
      if (error) throw error;
    }
    if (bucketCreated) {
      const { error } = await admin.storage.deleteBucket('bidwatch');
      if (error) throw error;
    }
    await anon.auth.signOut();
    await admin.auth.signOut();
  }
});
