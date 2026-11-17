import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Request, Response } from 'express';
import type { DatabaseScope } from '../backend/scoped-records';

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SECRET_KEY;
const enabled = Boolean(supabaseUrl && anonKey && serviceKey);

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

test('local Supabase Auth and PostgREST enforce real organisation boundaries', { skip: !enabled }, async t => {
  const admin = createClient(supabaseUrl!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const anon = createClient(supabaseUrl!, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

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
  const recordIds: string[] = [];
  const tokens = new Map<string, string>();

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
        permissions: ['bids.view', 'bids.create'],
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
    return organisation.id;
  }

  async function authenticatedContext(userId: string, organisationId?: string): Promise<Context> {
    const token = tokens.get(userId);
    assert.ok(token);
    const ctx = {
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

    let currentScope: DatabaseScope | null = null;
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
      assert.deepEqual(ctx.organisation?.permissions, ['bids.view', 'bids.create']);
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
      assert.deepEqual(visibleA.items.map(row => row.id), [recordA]);
      assert.deepEqual(await repository.get('tenders', [recordB]), []);

      currentScope = { kind: 'organisation', organisationId: orgB };
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
    if (recordIds.length) {
      const { error } = await admin.from('app_records').delete().in('id', recordIds);
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
    await anon.auth.signOut();
    await admin.auth.signOut();
  }
});
