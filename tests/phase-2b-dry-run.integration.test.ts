import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { collectPhase2BDryRunReport, parseLocalSupabaseUrl } from '../scripts/phase-2b-dry-run';

const supabaseUrl = process.env.SUPABASE_URL || '';
const serviceKey = process.env.SUPABASE_SECRET_KEY || '';

test('Phase 2B dry-run inventories synthetic legacy records without changing them', async () => {
  assert.ok(supabaseUrl && serviceKey, 'Export local Supabase URL and service-role key before running this integration test.');
  assert.doesNotThrow(
    () => parseLocalSupabaseUrl(supabaseUrl),
    'Refusing to write integration fixtures to a non-local Supabase host.',
  );

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const orgResult = await admin.from('organisations').select('id').eq('slug', 'legacy-bidwatch-workspace');
  assert.ifError(orgResult.error);
  assert.equal(orgResult.data?.length, 1, 'Expected the Phase 1 legacy workspace in the local database.');
  const organisationId = orgResult.data![0].id;

  const updateId = randomUUID();
  const importedUpdateId = randomUUID();
  const dismissedUpdateId = randomUUID();
  const tenderId = randomUUID();
  const runId = randomUUID();
  const changeId = randomUUID();
  const timestamp = '2026-11-02T10:00:00.000Z';
  const commonUpdate = {
    sourceId: 'maneps',
    source: 'MANePS procurement notices',
    sourceUrl: 'https://maneps.mw/procurement-notice',
    title: 'Synthetic network security procurement',
    organisation: 'Synthetic public buyer',
    reference: 'TEST/ICT/001',
    url: 'https://example.test/notices/1',
    description: 'Synthetic fixture only.',
    firstSeenAt: '2026-11-01T10:00:00.000Z',
    lastSeenAt: timestamp,
    fitLevel: 'direct',
    relevanceScore: 80,
    categories: ['Cybersecurity'],
    matchedTerms: ['firewall'],
    state: 'new',
    details: { publishedAt: timestamp, documents: [] },
  };
  const fixtureRows = [
    { id: updateId, table_name: 'opportunity_updates', record: commonUpdate, scope_type: 'organisation', organisation_id: organisationId },
    { id: importedUpdateId, table_name: 'opportunity_updates', record: { ...commonUpdate, reference: 'TEST/ICT/002', state: 'imported', importedTenderId: tenderId }, scope_type: 'organisation', organisation_id: organisationId },
    { id: dismissedUpdateId, table_name: 'opportunity_updates', record: { ...commonUpdate, reference: 'TEST/ICT/003', state: 'dismissed' }, scope_type: 'organisation', organisation_id: organisationId },
    { id: tenderId, table_name: 'tenders', record: { title: 'Synthetic imported tender' }, scope_type: 'organisation', organisation_id: organisationId },
    { id: runId, table_name: 'opportunity_source_runs', record: {
      sourceId: 'maneps', source: 'MANePS procurement notices', sourceUrl: 'https://maneps.mw/procurement-notice',
      status: 'ok', accessMethod: 'public-ocds-api', scanType: 'scheduled',
      fetchedCount: 4, parsedCount: 4, relevantCount: 2, failedCount: 0,
      durationMs: 900, checkedAt: timestamp, message: 'Synthetic integration fixture.',
    }, scope_type: 'global', organisation_id: null },
    { id: changeId, table_name: 'opportunity_changes', record: {
      opportunityUpdateId: updateId, reference: 'TEST/ICT/001', title: commonUpdate.title,
      source: commonUpdate.source, changedFields: ['title'],
      before: { title: 'Old synthetic title' }, after: { title: commonUpdate.title }, detectedAt: timestamp,
    }, scope_type: 'organisation', organisation_id: organisationId },
  ];

  const inserted = await admin.from('app_records').insert(fixtureRows);
  assert.ifError(inserted.error);

  try {
    const beforeResult = await admin.from('app_records').select('id,record,updated_at').in('id', fixtureRows.map(row => row.id)).order('id');
    assert.ifError(beforeResult.error);
    const report = await collectPhase2BDryRunReport(admin);
    const afterResult = await admin.from('app_records').select('id,record,updated_at').in('id', fixtureRows.map(row => row.id)).order('id');
    assert.ifError(afterResult.error);

    assert.equal(report.safety.databaseWrites, false);
    assert.equal(report.baseline.collections.opportunity_updates, 3);
    assert.equal(report.baseline.collections.opportunity_changes, 1);
    assert.ok(report.baseline.collections.opportunity_source_runs >= 1,
      'the synthetic global run must be present; other integration tests may add their own global runs concurrently');
    assert.equal(report.baseline.collections.tenders, 1);
    assert.equal(report.validation.migratableUpdateCandidates, 2);
    assert.equal(report.validation.quarantinedUpdateCandidates, 1);
    assert.equal(report.validation.migratableSourceRunCandidates, 1);
    assert.equal(report.history.changesLinkedToKnownUpdates, 1);
    assert.equal(report.history.reconstructableFullSnapshots, 0);
    assert.deepEqual(afterResult.data, beforeResult.data, 'Dry-run must not mutate legacy app_records rows.');
  } finally {
    const cleanup = await admin.from('app_records').delete().in('id', fixtureRows.map(row => row.id));
    assert.ifError(cleanup.error);
  }
});
