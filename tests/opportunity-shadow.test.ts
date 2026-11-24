import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpportunityShadowComparison } from '../backend/opportunity-shadow';

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
