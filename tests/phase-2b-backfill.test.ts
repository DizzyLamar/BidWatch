import test from 'node:test';
import assert from 'node:assert/strict';
import { reconstructHistorySnapshots, runPhase2BBackfill } from '../scripts/phase-2b-backfill';

const current = {
  title: 'Final title', organisation: 'Public buyer', reference: 'REF-1',
  deadline: '2026-12-01T10:00:00.000Z', description: 'Final description',
  noticeType: 'Tender', url: 'https://example.test/tender', relevanceScore: 80,
  relevanceLevel: 'high', fitLevel: 'direct', classificationReason: 'Matched ICT',
  contentHash: 'legacy-hash', categories: ['Cybersecurity'], matchedTerms: ['firewall'],
};

test('Phase 2B reconstructs complete snapshots backwards from the current record', () => {
  const result = reconstructHistorySnapshots(current, [
    { id: '00000000-0000-4000-8000-000000000001', record: {
      detectedAt: '2026-11-01T10:00:00.000Z', changedFields: ['title'],
      before: { title: 'Initial title' }, after: { title: 'Middle title' },
    } },
    { id: '00000000-0000-4000-8000-000000000002', record: {
      detectedAt: '2026-11-02T10:00:00.000Z', changedFields: ['title', 'description'],
      before: { title: 'Middle title', description: 'Initial description' },
      after: { title: 'Final title', description: 'Final description' },
    } },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshots.length, 2);
  assert.equal(result.snapshots[0].observedAt, '2026-11-01T10:00:00.000Z');
  assert.equal(result.snapshots[0].snapshot.title, 'Middle title');
  assert.equal(result.snapshots[1].snapshot.title, 'Final title');
  assert.equal(result.snapshots[1].snapshot.description, 'Final description');
  assert.notEqual(result.snapshots[0].hash, result.snapshots[1].hash);
});

test('Phase 2B refuses to invent snapshots when a transition does not match current state', () => {
  const result = reconstructHistorySnapshots(current, [{
    id: '00000000-0000-4000-8000-000000000001', record: {
      detectedAt: '2026-11-01T10:00:00.000Z', changedFields: ['title'],
      before: { title: 'Old title' }, after: { title: 'Not the current title' },
    },
  }]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /does not match/);
});

test('Phase 2B quarantines unsupported legacy history fields', () => {
  const result = reconstructHistorySnapshots(current, [{
    id: '00000000-0000-4000-8000-000000000001', record: {
      detectedAt: '2026-11-01T10:00:00.000Z', changedFields: ['rawText'],
      before: { rawText: 'old' }, after: { rawText: 'new' },
    },
  }]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /unsupported/);
});

test('Phase 2B writer rejects a non-local Supabase client before any query', async () => {
  await assert.rejects(
    () => runPhase2BBackfill({ supabaseUrl: 'https://production-project.supabase.co' }),
    /permanently restricted to localhost/,
  );
});

test('Phase 2B rejects non-ISO or impossible detectedAt timestamps for history versions', () => {
  for (const detectedAt of ['2026-11-01', '2026-02-30T10:00:00.000Z']) {
    const result = reconstructHistorySnapshots(current, [{
      id: '00000000-0000-4000-8000-000000000001', record: {
        detectedAt, changedFields: ['title'],
        before: { title: 'Old title' }, after: { title: current.title },
      },
    }]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /valid detectedAt/);
  }
});
