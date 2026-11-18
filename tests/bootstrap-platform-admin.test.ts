import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapFirstPlatformAdmin, validateBootstrapEnvironment } from '../scripts/bootstrap-platform-admin';

const userId = '11111111-1111-4111-8111-111111111111';
const organisationId = '22222222-2222-4222-8222-222222222222';
const ownerRoleId = '33333333-3333-4333-8333-333333333333';
const baseEnv = {
  BIDWATCH_BOOTSTRAP_CONFIRM: 'I_UNDERSTAND_THIS_GRANTS_PLATFORM_ADMIN',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SECRET_KEY: 'local-test-secret',
  BIDWATCH_BOOTSTRAP_USER_ID: userId,
};

test('bootstrap environment requires an explicit acknowledgement', () => {
  assert.throws(() => validateBootstrapEnvironment({ ...baseEnv, BIDWATCH_BOOTSTRAP_CONFIRM: '' }), /acknowledge/);
});

test('bootstrap refuses remote Supabase projects, even with confirmation', () => {
  assert.throws(() => validateBootstrapEnvironment({ ...baseEnv, SUPABASE_URL: 'https://example.supabase.co' }), /restricted to a localhost/);
});

test('bootstrap requires an exact Auth UUID', () => {
  assert.throws(() => validateBootstrapEnvironment({ ...baseEnv, BIDWATCH_BOOTSTRAP_USER_ID: 'admin@example.com' }), /exact Auth user UUID/);
});

test('bootstrap verifies the Auth identity before granting platform access', async () => {
  let fromCalls = 0;
  const admin = {
    auth: { admin: { getUserById: async () => ({ data: { user: null }, error: null }) } },
    from: () => { fromCalls++; throw new Error('Database must not be touched for an unknown Auth identity.'); },
  };
  await assert.rejects(bootstrapFirstPlatformAdmin(admin, userId), /Auth identity does not exist/);
  assert.equal(fromCalls, 0);
});

test('bootstrap provisions a verified first owner, global profile, membership and platform admin idempotently', async () => {
  const writes: Array<{ table: string; value: unknown }> = [];
  let platformAdminInserted = false;
  let membershipInserted: any = null;
  const authUser = {
    id: userId,
    email: 'owner@example.com',
    email_confirmed_at: '2026-01-01T00:00:00.000Z',
    user_metadata: { full_name: 'Workspace Owner' },
  };
  const admin = {
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: id === userId ? authUser : null }, error: null }) } },
    from: (table: string) => {
      if (table === 'organisations') return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: organisationId, name: 'Legacy BidWatch Workspace' }, error: null }) }) }),
      };
      if (table === 'organisation_roles') return {
        upsert: (value: unknown) => {
          writes.push({ table, value });
          return { select: () => ({ single: async () => ({ data: { id: ownerRoleId }, error: null }) }) };
        },
      };
      if (table === 'app_records') return {
        select: () => ({ eq: () => ({ contains: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
        insert: async (value: unknown) => { writes.push({ table, value }); return { error: null }; },
      };
      if (table === 'organisation_members') return {
        upsert: async (value: unknown) => { writes.push({ table, value }); membershipInserted = value; return { error: null }; },
        select: () => ({
          eq: (column: string) => column === 'user_id'
            ? { limit: async () => ({ data: [], error: null }) }
            : { eq: () => ({ maybeSingle: async () => ({ data: membershipInserted ? { user_id: userId, role_id: ownerRoleId, status: 'active' } : null, error: null }) }) },
        }),
      };
      if (table === 'platform_admins') return {
        upsert: async (value: unknown) => { writes.push({ table, value }); platformAdminInserted = true; return { error: null }; },
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: platformAdminInserted ? { user_id: userId } : null, error: null }) }) }),
      };
      throw new Error(`Unexpected table: ${table}`);
    },
  };

  const result = await bootstrapFirstPlatformAdmin(admin, userId);
  assert.equal(result.userId, userId);
  assert.equal(result.organisationId, organisationId);
  assert.equal(result.ownerRoleId, ownerRoleId);
  assert.equal(result.alreadyProvisioned, false);
  assert.equal(result.ownerMembershipProvisioned, true);
  assert.deepEqual(writes.map(write => write.table), [
    'organisation_roles', 'app_records', 'organisation_members', 'platform_admins',
  ]);
  const profile = writes.find(write => write.table === 'app_records')?.value as any;
  assert.equal(profile.record.userId, userId);
  assert.equal(profile.record.email, 'owner@example.com');
  assert.equal(profile.scope_type, 'global');
  const membership = writes.find(write => write.table === 'organisation_members')?.value as any;
  assert.equal(membership.status, 'active');
  assert.equal(membership.role_id, ownerRoleId);
});
