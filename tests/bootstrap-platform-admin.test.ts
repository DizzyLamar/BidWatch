import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapFirstPlatformAdmin, validateBootstrapEnvironment } from '../scripts/bootstrap-platform-admin';

const userId = '11111111-1111-4111-8111-111111111111';
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
  let writes = 0;
  const admin = {
    auth: { admin: { getUserById: async () => ({ data: { user: null }, error: null }) } },
    from: () => ({ upsert: async () => { writes++; return { error: null }; } }),
  };
  await assert.rejects(bootstrapFirstPlatformAdmin(admin, userId), /Auth identity does not exist/);
  assert.equal(writes, 0);
});

test('bootstrap inserts only the requested platform administrator and verifies it', async () => {
  const inserted: Array<{ user_id: string; created_by: string }> = [];
  const admin = {
    auth: { admin: { getUserById: async (id: string) => ({ data: { user: { id } }, error: null }) } },
    from: (table: string) => {
      assert.equal(table, 'platform_admins');
      return {
        upsert: async (row: { user_id: string; created_by: string }) => {
          inserted.push(row);
          return { error: null };
        },
        select: () => ({
          eq: (_column: string, id: string) => ({
            maybeSingle: async () => ({ data: inserted.some(row => row.user_id === id) ? { user_id: id } : null, error: null }),
          }),
        }),
      };
    },
  };
  const result = await bootstrapFirstPlatformAdmin(admin, userId);
  assert.deepEqual(inserted, [{ user_id: userId, created_by: userId }]);
  assert.equal(result.userId, userId);
});
