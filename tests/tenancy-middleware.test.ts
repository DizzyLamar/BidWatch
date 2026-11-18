import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequireOrganisationMiddleware } from '../backend/tenancy';
import type { RouterContext } from '../backend/runtime';
import type { DatabaseScope } from '../backend/scoped-records';

const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const orgA = '11111111-1111-4111-8111-111111111111';
const orgB = '22222222-2222-4222-8222-222222222222';

class TableQuery {
  private filters: Array<(row: Record<string, unknown>) => boolean> = [];
  private maxRows = Number.POSITIVE_INFINITY;

  constructor(private rows: Record<string, unknown>[]) {}
  select(_columns: string) { return this; }
  eq(column: string, value: unknown) {
    this.filters.push(row => row[column] === value);
    return this;
  }
  limit(value: number) { this.maxRows = value; return this; }

  private matches() {
    return this.rows.filter(row => this.filters.every(filter => filter(row)));
  }

  maybeSingle() {
    return Promise.resolve({ data: this.matches()[0] || null, error: null });
  }

  then(resolve: (value: { data: Record<string, unknown>[]; error: null }) => unknown, reject?: (reason: unknown) => unknown) {
    return Promise.resolve({ data: this.matches().slice(0, this.maxRows), error: null }).then(resolve, reject);
  }
}

function fixture() {
  const tables: Record<string, Record<string, unknown>[]> = {
    organisation_members: [
      { id: 'membership-a', organisation_id: orgA, user_id: userA, role_id: 'role-a', status: 'active' },
      { id: 'membership-b', organisation_id: orgB, user_id: userB, role_id: 'role-b', status: 'active' },
      { id: 'membership-suspended', organisation_id: orgA, user_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', role_id: 'role-a', status: 'suspended' },
    ],
    organisations: [
      { id: orgA, name: 'Workspace A', slug: 'workspace-a', status: 'active' },
      { id: orgB, name: 'Workspace B', slug: 'workspace-b', status: 'active' },
    ],
    organisation_roles: [
      { id: 'role-a', key: 'member', name: 'Member', permissions: ['bids.view'] , organisation_id: orgA },
      { id: 'role-b', key: 'member', name: 'Member', permissions: ['bids.view'], organisation_id: orgB },
    ],
    platform_admins: [],
  };
  const database = {
    from(table: string) {
      return new TableQuery(tables[table] || []);
    },
  };
  return { database, tables };
}

function context(userId: string, organisationId?: string): RouterContext {
  return {
    body: {},
    params: {},
    query: {},
    user: { userId, email: 'member@example.test', name: 'Member' },
    req: { headers: organisationId ? { 'x-organisation-id': organisationId } : {} } as RouterContext['req'],
    res: {} as RouterContext['res'],
  };
}

function statusOf(result: unknown) {
  return (result as { status?: number } | undefined)?.status;
}

test('a member cannot switch into another organisation by changing X-Organisation-Id', async () => {
  const { database } = fixture();
  let appliedScope: DatabaseScope | null = null;
  const middleware = createRequireOrganisationMiddleware(database, scope => { appliedScope = scope; });
  const ctx = context(userA, orgB);

  const result = await middleware(ctx);

  assert.equal(statusOf(result), 403);
  assert.equal(ctx.organisation, undefined);
  assert.equal(appliedScope, null);
});

test('a verified active membership establishes the selected organisation and role', async () => {
  const { database } = fixture();
  let appliedScope: DatabaseScope | null = null;
  const middleware = createRequireOrganisationMiddleware(database, scope => { appliedScope = scope; });
  const ctx = context(userA, orgA);

  const result = await middleware(ctx);

  assert.equal(result, undefined);
  assert.equal(ctx.organisation?.id, orgA);
  assert.equal(ctx.organisation?.roleId, 'role-a');
  assert.deepEqual(ctx.organisation?.permissions, ['bids.view']);
  assert.deepEqual(appliedScope, { kind: 'organisation', organisationId: orgA, legacyStorage: false });
});

test('a single active membership may be selected explicitly by default', async () => {
  const { database } = fixture();
  const middleware = createRequireOrganisationMiddleware(database, () => {});
  const ctx = context(userA);

  const result = await middleware(ctx);

  assert.equal(result, undefined);
  assert.equal(ctx.organisation?.id, orgA);
});

test('multiple active memberships require an explicit organisation selection', async () => {
  const { database, tables } = fixture();
  tables.organisation_members.push({
    id: 'membership-a-in-b', organisation_id: orgB, user_id: userA, role_id: 'role-b', status: 'active',
  });
  const middleware = createRequireOrganisationMiddleware(database, () => {});
  const ctx = context(userA);

  const result = await middleware(ctx);

  assert.equal(statusOf(result), 400);
});

test('suspended members and malformed organisation identifiers are rejected', async () => {
  const { database } = fixture();
  const middleware = createRequireOrganisationMiddleware(database, () => {});
  const suspended = await middleware(context('cccccccc-cccc-4ccc-8ccc-cccccccccccc', orgA));
  const malformed = await middleware(context(userA, 'not-a-uuid'));

  assert.equal(statusOf(suspended), 403);
  assert.equal(statusOf(malformed), 400);
});

test('platform administrator status is loaded independently of the organisation role', async () => {
  const { database, tables } = fixture();
  tables.platform_admins.push({ user_id: userA });
  const middleware = createRequireOrganisationMiddleware(database, () => {});
  const ctx = context(userA, orgA);

  await middleware(ctx);

  assert.equal(ctx.organisation?.roleKey, 'member');
  assert.equal(ctx.organisation?.isPlatformAdmin, true);
});
