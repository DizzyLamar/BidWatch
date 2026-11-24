import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpportunityShadowComparison } from '../backend/opportunity-shadow';
import { readPagedLegacyInventory } from '../backend/legacy-opportunity-inventory';

test('shadow comparison uses the deterministic Phase 2B legacy mapping', () => {
  const report = buildOpportunityShadowComparison([
    { id: 'legacy-a', sourceId: 'ppda', state: 'new' },
    { id: 'legacy-b', sourceId: 'maneps', state: 'imported' },
    { id: 'legacy-c', sourceId: 'pppc', state: 'dismissed' },
  ], [
    { canonical_key: 'legacy:ppda:legacy-a', state: 'new' },
    { canonical_key: 'legacy:maneps:legacy-b', state: 'converted' },
    { canonical_key: 'legacy:pppc:legacy-c', state: 'new' },
    { canonical_key: 'legacy:ppda:unrelated', state: 'new' },
  ]);
  assert.deepEqual(report, {
    legacyCount: 3, canonicalCount: 4, matchedCount: 3,
    missingCanonicalCount: 0, unmatchedCanonicalCount: 1,
    stateMismatchCount: 1, duplicateCanonicalKeyCount: 0, invalidLegacyStateCount: 0, complete: true,
  });
});

test('shadow comparison reports missing rows and duplicate canonical keys', () => {
  const report = buildOpportunityShadowComparison([
    { id: 'legacy-a', sourceId: 'ppda', state: 'new' },
    { id: 'legacy-b', sourceId: 'maneps', state: 'new' },
  ], [
    { canonical_key: 'legacy:ppda:legacy-a', state: 'new' },
    { canonical_key: 'legacy:ppda:legacy-a', state: 'new' },
  ], false);
  assert.equal(report.matchedCount, 1);
  assert.equal(report.missingCanonicalCount, 1);
  assert.equal(report.duplicateCanonicalKeyCount, 1);
  assert.equal(report.complete, false);
});

test('shadow comparison never assumes a match from a similar title or source alone', () => {
  const report = buildOpportunityShadowComparison(
    [{ id: 'legacy-a', sourceId: 'ppda', state: 'new' }],
    [
      { canonical_key: 'legacy:ppda:another-record', state: 'new' },
      { canonical_key: 'legacy:maneps:legacy-a', state: 'new' },
    ],
  );
  assert.equal(report.matchedCount, 0);
  assert.equal(report.missingCanonicalCount, 1);
});


test('shadow comparison flags unsupported legacy workflow states instead of treating them as new', () => {
  const report = buildOpportunityShadowComparison(
    [{ id: 'legacy-a', sourceId: 'ppda', state: 'unexpected-state' }],
    [{ canonical_key: 'legacy:ppda:legacy-a', state: 'new' }],
  );
  assert.equal(report.matchedCount, 1);
  assert.equal(report.invalidLegacyStateCount, 1);
  assert.equal(report.stateMismatchCount, 1);
});

test('unmatched canonical count includes every canonical row without a legacy identity', () => {
  const report = buildOpportunityShadowComparison(
    [{ id: 'legacy-a', sourceId: 'ppda', state: 'new' }],
    [
      { canonical_key: 'legacy:ppda:legacy-a', state: 'new' },
      { canonical_key: 'legacy:unknown:extra', state: 'new' },
      { canonical_key: 'legacy:unknown:extra', state: 'new' },
    ],
  );
  assert.equal(report.unmatchedCanonicalCount, 2);
  assert.equal(report.duplicateCanonicalKeyCount, 1);
});


test('legacy inventory pagination traverses more than the PostgREST 1,000-row cap', async () => {
  const records = Array.from({ length: 1205 }, (_, id) => ({ id, sourceId: 'ppda', state: 'new' }));
  const calls: Array<{ limit: number; offset: number }> = [];
  const result = await readPagedLegacyInventory(async ({ limit, offset }) => {
    calls.push({ limit, offset });
    // Model a PostgREST server that never returns more than its configured
    // maximum, even when the caller asks for more.
    return { items: records.slice(offset, offset + Math.min(limit, 1000)) };
  }, { maxRecords: 5000, pageSize: 500 });
  assert.equal(result.items.length, 1205);
  assert.equal(result.complete, true);
  assert.deepEqual(calls.map(call => call.offset), [0, 500, 1000]);
});

test('legacy inventory is incomplete when the configured comparison bound is exceeded', async () => {
  const records = Array.from({ length: 5001 }, (_, id) => ({ id }));
  const result = await readPagedLegacyInventory(
    async ({ limit, offset }) => ({ items: records.slice(offset, offset + limit) }),
    { maxRecords: 5000, pageSize: 500 },
  );
  assert.equal(result.items.length, 5000);
  assert.equal(result.complete, false);
});

test('legacy inventory reports an exactly-full bounded inventory as complete', async () => {
  const records = Array.from({ length: 5000 }, (_, id) => ({ id }));
  const result = await readPagedLegacyInventory(
    async ({ limit, offset }) => ({ items: records.slice(offset, offset + limit) }),
    { maxRecords: 5000, pageSize: 500 },
  );
  assert.equal(result.items.length, 5000);
  assert.equal(result.complete, true);
});
