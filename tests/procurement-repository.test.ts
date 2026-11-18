import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcurementReadRepository } from '../backend/procurement-repository';
import type { DatabaseScope } from '../backend/scoped-records';

const ORGANISATION_A = '11111111-1111-4111-8111-111111111111';
const OPPORTUNITY_ID = '22222222-2222-4222-8222-222222222222';

function fakeClient(result: { data: unknown; error: { message: string } | null } = { data: [], error: null }) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const query = {
    select(value: string) { calls.push({ method: 'select', args: [value] }); return this; },
    eq(column: string, value: unknown) { calls.push({ method: 'eq', args: [column, value] }); return this; },
    order(column: string, options: unknown) { calls.push({ method: 'order', args: [column, options] }); return this; },
    limit(value: number) { calls.push({ method: 'limit', args: [value] }); return Promise.resolve(result); },
    maybeSingle() { calls.push({ method: 'maybeSingle', args: [] }); return Promise.resolve(result); },
  };
  return {
    calls,
    client: {
      from(table: string) {
        calls.push({ method: 'from', args: [table] });
        return query;
      },
    },
  };
}

test('procurement reads require a verified organisation scope before touching Supabase', async () => {
  const fake = fakeClient();
  const repository = createProcurementReadRepository(fake.client, () => null);
  await assert.rejects(
    repository.listOrganisationOpportunities(),
    /verified active organisation scope/,
  );
  assert.equal(fake.calls.length, 0);
});

test('opportunity list always scopes by the active organisation and bounds the page size', async () => {
  const expected = [{ id: OPPORTUNITY_ID, organisation_id: ORGANISATION_A, state: 'pursuing' }];
  const fake = fakeClient({ data: expected, error: null });
  const scope: DatabaseScope = { kind: 'organisation', organisationId: ORGANISATION_A };
  const repository = createProcurementReadRepository(fake.client, () => scope);

  const result = await repository.listOrganisationOpportunities({ state: 'pursuing', limit: 500 });
  assert.deepEqual(result, expected);
  assert.ok(fake.calls.some(call => call.method === 'eq' && call.args[0] === 'organisation_id' && call.args[1] === ORGANISATION_A));
  assert.ok(fake.calls.some(call => call.method === 'eq' && call.args[0] === 'state' && call.args[1] === 'pursuing'));
  assert.ok(fake.calls.some(call => call.method === 'limit' && call.args[0] === 100));
  assert.ok(fake.calls.some(call => call.method === 'order' && call.args[0] === 'id'));
});

test('known-ID reads include both the active organisation and record ID predicates', async () => {
  const fake = fakeClient({ data: null, error: null });
  const scope: DatabaseScope = { kind: 'organisation', organisationId: ORGANISATION_A };
  const repository = createProcurementReadRepository(fake.client, () => scope);

  const result = await repository.getOrganisationOpportunity(OPPORTUNITY_ID);
  assert.equal(result, null);
  assert.ok(fake.calls.some(call => call.method === 'eq' && call.args[0] === 'organisation_id' && call.args[1] === ORGANISATION_A));
  assert.ok(fake.calls.some(call => call.method === 'eq' && call.args[0] === 'id' && call.args[1] === OPPORTUNITY_ID));
});

test('invalid opportunity IDs return null without issuing a database query', async () => {
  const fake = fakeClient();
  const scope: DatabaseScope = { kind: 'organisation', organisationId: ORGANISATION_A };
  const repository = createProcurementReadRepository(fake.client, () => scope);

  assert.equal(await repository.getOrganisationOpportunity('not-a-uuid'), null);
  assert.equal(fake.calls.length, 0);
});

test('database errors are surfaced to the backend caller', async () => {
  const fake = fakeClient({ data: null, error: { message: 'database unavailable' } });
  const scope: DatabaseScope = { kind: 'organisation', organisationId: ORGANISATION_A };
  const repository = createProcurementReadRepository(fake.client, () => scope);

  await assert.rejects(repository.listOrganisationOpportunities(), /database unavailable/);
});
