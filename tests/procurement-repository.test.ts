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
    or(value: string) { calls.push({ method: 'or', args: [value] }); return this; },
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
  assert.ok(fake.calls.some(call => call.method === 'limit' && call.args[0] === 101));
  assert.ok(fake.calls.some(call => call.method === 'order' && call.args[0] === 'id'));
});

test('opportunity pages use a stable composite cursor and return the next page token', async () => {
  const rows = [
    { id: '22222222-2222-4222-8222-222222222222', updated_at: '2026-11-18T10:00:00.000Z' },
    { id: '33333333-3333-4333-8333-333333333333', updated_at: '2026-11-18T09:00:00.000Z' },
    { id: '44444444-4444-4444-8444-444444444444', updated_at: '2026-11-18T08:00:00.000Z' },
  ];
  const fake = fakeClient({ data: rows, error: null });
  const scope: DatabaseScope = { kind: 'organisation', organisationId: ORGANISATION_A };
  const repository = createProcurementReadRepository(fake.client, () => scope);

  const page = await repository.listOrganisationOpportunitiesPage({ limit: 2 });
  assert.deepEqual(page.items, rows.slice(0, 2));
  assert.deepEqual(page.nextCursor, {
    updatedAt: rows[1].updated_at,
    id: rows[1].id,
  });
  assert.ok(fake.calls.some(call => call.method === 'limit' && call.args[0] === 3));

  const secondFake = fakeClient({ data: [rows[2]], error: null });
  const secondRepository = createProcurementReadRepository(secondFake.client, () => scope);
  const secondPage = await secondRepository.listOrganisationOpportunitiesPage({
    limit: 2,
    cursor: page.nextCursor!,
  });
  assert.deepEqual(secondPage.items, [rows[2]]);
  assert.equal(secondPage.nextCursor, null);
  assert.ok(secondFake.calls.some(call =>
    call.method === 'or'
      && String(call.args[0]).includes('updated_at.lt.2026-11-18T09:00:00.000Z')
      && String(call.args[0]).includes('id.lt.33333333-3333-4333-8333-333333333333')
  ));

  const precisionFake = fakeClient({ data: [], error: null });
  const precisionRepository = createProcurementReadRepository(precisionFake.client, () => scope);
  await precisionRepository.listOrganisationOpportunitiesPage({
    cursor: { updatedAt: '2026-11-18T09:00:00.123456+00:00', id: rows[1].id },
  });
  assert.ok(precisionFake.calls.some(call =>
    call.method === 'or' && String(call.args[0]).includes('updated_at.lt.2026-11-18T09:00:00.123456+00:00')
  ));
});

test('invalid pagination cursors are rejected before querying Supabase', async () => {
  const fake = fakeClient();
  const scope: DatabaseScope = { kind: 'organisation', organisationId: ORGANISATION_A };
  const repository = createProcurementReadRepository(fake.client, () => scope);

  await assert.rejects(
    repository.listOrganisationOpportunitiesPage({
      cursor: { updatedAt: 'not-a-date', id: 'not-a-uuid' },
    }),
    /Invalid procurement opportunity cursor/,
  );
  assert.equal(fake.calls.length, 0);

  for (const updatedAt of [
    '2026-02-30T12:00:00Z',
    '2025-02-29T12:00:00Z',
    '2026-11-18T24:00:00Z',
    '2026-11-18T12:60:00Z',
    '2026-11-18T12:00:60Z',
    '2026-11-18T12:00:00+02:60',
  ]) {
    await assert.rejects(
      repository.listOrganisationOpportunitiesPage({
        cursor: { updatedAt, id: OPPORTUNITY_ID },
      }),
      /Invalid procurement opportunity cursor/,
      updatedAt,
    );
  }
  assert.equal(fake.calls.length, 0);
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
