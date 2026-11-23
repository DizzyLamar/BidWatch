import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { parseLocalSupabaseUrl } from '../scripts/phase-2b-dry-run';
import { runPhase2BBackfill } from '../scripts/phase-2b-backfill';

const supabaseUrl = process.env.SUPABASE_URL || '';
const serviceKey = process.env.SUPABASE_SECRET_KEY || '';

function deterministicUuid(value: string) {
  const bytes = createHash('sha256').update('bidwatch-phase2b:' + value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

test('Phase 2B backfill is resumable, idempotent, tenant-scoped and preserves legacy rows', async () => {
  assert.ok(supabaseUrl && serviceKey, 'Export local Supabase URL and service-role key before running this integration test.');
  assert.doesNotThrow(() => parseLocalSupabaseUrl(supabaseUrl), 'Refusing to write fixtures to a non-local Supabase host.');

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
  const invalidDateUpdateId = randomUUID();
  const malformedUpdateId = randomUUID();
  const tenderId = randomUUID();
  const sourceRunId = randomUUID();
  const invalidSourceRunId = randomUUID();
  const changeId = randomUUID();
  const runId = randomUUID();
  const rerunId = randomUUID();
  const conflictRunId = randomUUID();
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
    relevanceLevel: 'high',
    classificationReason: 'Synthetic classifier fixture',
    classifierVersion: 'rules-v2',
    contentHash: 'legacy-fnv-hash',
    categories: ['Cybersecurity'],
    matchedTerms: ['firewall'],
    state: 'new',
    sourceStatus: 'active',
    details: { publishedAt: timestamp, procurementMethod: 'NCB', documents: [] },
  };
  const fixtureRows = [
    { id: updateId, table_name: 'opportunity_updates', record: commonUpdate, scope_type: 'organisation', organisation_id: organisationId },
    { id: importedUpdateId, table_name: 'opportunity_updates', record: { ...commonUpdate, reference: 'TEST/ICT/002', state: 'imported', importedTenderId: tenderId }, scope_type: 'organisation', organisation_id: organisationId },
    { id: dismissedUpdateId, table_name: 'opportunity_updates', record: { ...commonUpdate, reference: 'TEST/ICT/003', state: 'dismissed' }, scope_type: 'organisation', organisation_id: organisationId },
    { id: invalidDateUpdateId, table_name: 'opportunity_updates', record: {
      ...commonUpdate, reference: 'TEST/ICT/004', deadline: '2026-02-31T10:00:00.000Z',
    }, scope_type: 'organisation', organisation_id: organisationId },
    { id: malformedUpdateId, table_name: 'opportunity_updates', record: null as any, scope_type: 'organisation', organisation_id: organisationId },
    { id: tenderId, table_name: 'tenders', record: { title: 'Synthetic imported tender' }, scope_type: 'organisation', organisation_id: organisationId },
    { id: sourceRunId, table_name: 'opportunity_source_runs', record: {
      sourceId: 'maneps', source: 'MANePS procurement notices', sourceUrl: 'https://maneps.mw/procurement-notice',
      status: 'ok', accessMethod: 'public-ocds-api', scanType: 'scheduled',
      fetchedCount: 4, parsedCount: 4, relevantCount: 2, failedCount: 0,
      durationMs: 900, checkedAt: timestamp, message: 'Synthetic integration fixture.',
    }, scope_type: 'global', organisation_id: null },
    { id: invalidSourceRunId, table_name: 'opportunity_source_runs', record: {
      sourceId: 'maneps', source: 'MANePS procurement notices', sourceUrl: 'https://maneps.mw/procurement-notice',
      status: 'ok', accessMethod: 'raw-html-with-cookies=secret', scanType: 'scheduled',
      fetchedCount: 1, parsedCount: 1, relevantCount: 0, failedCount: 0,
      durationMs: 100, checkedAt: timestamp,
    }, scope_type: 'global', organisation_id: null },
    { id: changeId, table_name: 'opportunity_changes', record: {
      opportunityUpdateId: updateId, reference: 'TEST/ICT/001', title: commonUpdate.title,
      source: commonUpdate.source, changedFields: ['title'],
      before: { title: 'Initial synthetic title' }, after: { title: 'Inconsistent synthetic title' }, detectedAt: timestamp,
    }, scope_type: 'organisation', organisation_id: organisationId },
  ];

  const inserted = await admin.from('app_records').insert(fixtureRows);
  assert.ifError(inserted.error);

  const observationId = deterministicUuid('observation:maneps:' + updateId);
  const importedObservationId = deterministicUuid('observation:maneps:' + importedUpdateId);
  const canonicalKey = 'legacy:maneps:' + updateId;

  try {
    const before = await admin.from('app_records').select('id,record,updated_at').in('id', fixtureRows.map(row => row.id)).order('id');
    assert.ifError(before.error);

    const first = await runPhase2BBackfill(admin, { runId, generatedAt: timestamp, recordIds: fixtureRows.map(row => row.id) });
    assert.equal(first.migrated.opportunity_updates, 2);
    assert.equal(first.quarantined.opportunity_updates, 3);
    assert.equal(first.migrated.opportunity_source_runs, 1);
    assert.equal(first.quarantined.opportunity_source_runs, 1);
    assert.equal(first.migrated.opportunity_changes, 0);
    assert.equal(first.quarantined.opportunity_changes, 1);
    assert.equal(first.migrated.versions, 0);
    assert.equal(first.reconciliation.updateRowsAccountedFor, 5);
    assert.equal(first.reconciliation.sourceRunRowsAccountedFor, 2);
    assert.equal(first.reconciliation.changeRowsAccountedFor, 1);
    assert.equal(first.reconciliation.quarantinesRemain, true);
    assert.equal(first.reconciliation.productionTouched, false);

    const invalidRunLedger = await admin.from('legacy_opportunity_backfill_records')
      .select('status,target_ids,findings').eq('legacy_collection', 'opportunity_source_runs')
      .eq('legacy_record_id', invalidSourceRunId).single();
    assert.ifError(invalidRunLedger.error);
    assert.equal(invalidRunLedger.data.status, 'quarantined');
    assert.equal(invalidRunLedger.data.target_ids.source_run_id, undefined);
    assert.ok(invalidRunLedger.data.findings.some((finding: any) => finding.code === 'invalid_access_method'));

    const invalidDateLedger = await admin.from('legacy_opportunity_backfill_records')
      .select('status,findings').eq('legacy_collection', 'opportunity_updates')
      .eq('legacy_record_id', invalidDateUpdateId).single();
    assert.ifError(invalidDateLedger.error);
    assert.equal(invalidDateLedger.data.status, 'quarantined');
    assert.ok(invalidDateLedger.data.findings.some((finding: any) => finding.code === 'invalid_deadline'));

    const malformedLedger = await admin.from('legacy_opportunity_backfill_records')
      .select('status,findings').eq('legacy_collection', 'opportunity_updates')
      .eq('legacy_record_id', malformedUpdateId).single();
    assert.ifError(malformedLedger.error);
    assert.equal(malformedLedger.data.status, 'quarantined');
    assert.ok(malformedLedger.data.findings.some((finding: any) => finding.code === 'invalid_record_shape'));

    const observation = await admin.from('procurement_source_observations').select('id,source_key,raw_payload')
      .eq('source_key', 'legacy-app-record:' + updateId).single();
    assert.ifError(observation.error);
    assert.equal(observation.data.id, observationId);
    assert.equal(observation.data.raw_payload.legacy_record_id, updateId);
    assert.equal('rawText' in observation.data.raw_payload, false);

    const canonical = await admin.from('canonical_opportunities').select('id,canonical_key').eq('canonical_key', canonicalKey).single();
    assert.ifError(canonical.error);
    const link = await admin.from('canonical_opportunity_sources').select('match_method,observation_id')
      .eq('observation_id', observationId).single();
    assert.ifError(link.error);
    assert.equal(link.data.match_method, 'source_observation_seed');

    const noVersions = await admin.from('procurement_observation_versions').select('id', { count: 'exact', head: true })
      .eq('observation_id', observationId);
    assert.ifError(noVersions.error);
    assert.equal(noVersions.count, 0, 'An inconsistent history chain must not create partial immutable versions.');

    const pursuit = await admin.from('organisation_opportunities').select('id,state,converted_tender_id')
      .eq('organisation_id', organisationId).eq('canonical_opportunity_id', canonical.data.id).single();
    assert.ifError(pursuit.error);
    assert.equal(pursuit.data.state, 'new');

    const importedCanonical = await admin.from('canonical_opportunities').select('id')
      .eq('canonical_key', 'legacy:maneps:' + importedUpdateId).single();
    assert.ifError(importedCanonical.error);
    const importedPursuit = await admin.from('organisation_opportunities').select('state,converted_tender_id')
      .eq('organisation_id', organisationId).eq('canonical_opportunity_id', importedCanonical.data.id).single();
    assert.ifError(importedPursuit.error);
    assert.equal(importedPursuit.data.state, 'converted');
    assert.equal(importedPursuit.data.converted_tender_id, tenderId);

    const second = await runPhase2BBackfill(admin, { runId: rerunId, generatedAt: timestamp, recordIds: fixtureRows.map(row => row.id) });
    assert.equal(second.migrated.opportunity_updates, 0);
    assert.equal(second.skippedPreviouslyMigrated.opportunity_updates, 2);
    assert.equal(second.skippedPreviouslyMigrated.opportunity_changes, 0);
    assert.equal(second.quarantined.opportunity_changes, 1);
    assert.equal(second.quarantined.opportunity_updates, 3);
    assert.equal(second.skippedPreviouslyMigrated.opportunity_source_runs, 1);
    assert.equal(second.quarantined.opportunity_source_runs, 1);
    assert.equal(second.reconciliation.updateRowsAccountedFor, 3);

    // Simulate an interrupted migration with a target pursuit subsequently changed
    // by an operator. Removing only the checkpoint forces a retry; the writer must
    // quarantine the conflict instead of restoring stale legacy workflow state.
    const changedPursuit = await admin.from('organisation_opportunities').update({ state: 'watching' })
      .eq('organisation_id', organisationId).eq('canonical_opportunity_id', canonical.data.id);
    assert.ifError(changedPursuit.error);
    const removeCheckpoint = await admin.from('legacy_opportunity_backfill_records').delete()
      .eq('legacy_collection', 'opportunity_updates').eq('legacy_record_id', updateId);
    assert.ifError(removeCheckpoint.error);

    await runPhase2BBackfill(admin, { runId: conflictRunId, generatedAt: timestamp, recordIds: fixtureRows.map(row => row.id) });
    const preservedPursuit = await admin.from('organisation_opportunities').select('state')
      .eq('organisation_id', organisationId).eq('canonical_opportunity_id', canonical.data.id).single();
    assert.ifError(preservedPursuit.error);
    assert.equal(preservedPursuit.data.state, 'watching', 'A retry must not overwrite organisation workflow changes.');
    const conflictLedger = await admin.from('legacy_opportunity_backfill_records')
      .select('status,target_ids,findings').eq('legacy_collection', 'opportunity_updates')
      .eq('legacy_record_id', updateId).single();
    assert.ifError(conflictLedger.error);
    assert.equal(conflictLedger.data.status, 'quarantined');
    assert.equal(conflictLedger.data.target_ids.organisation_opportunity_id, pursuit.data.id);
    assert.ok(conflictLedger.data.findings.some((finding: any) => finding.code === 'target_write_failed'));

    const after = await admin.from('app_records').select('id,record,updated_at').in('id', fixtureRows.map(row => row.id)).order('id');
    assert.ifError(after.error);
    assert.deepEqual(after.data, before.data, 'Backfill must never modify or delete legacy app_records.');

    const observationCount = await admin.from('procurement_source_observations').select('id', { count: 'exact', head: true })
      .eq('source_key', 'legacy-app-record:' + updateId);
    assert.ifError(observationCount.error);
    assert.equal(observationCount.count, 1, 'Rerun must not create a duplicate observation.');
  } finally {
    const sourceRunLedger = await admin.from('legacy_opportunity_backfill_records').select('target_ids')
      .eq('legacy_collection', 'opportunity_source_runs').eq('legacy_record_id', sourceRunId).maybeSingle();
    const targetRunId = sourceRunLedger.data?.target_ids?.source_run_id;
    const ledgerCleanup = await admin.from('legacy_opportunity_backfill_records').delete().in('legacy_record_id',
      [updateId, importedUpdateId, dismissedUpdateId, invalidDateUpdateId, malformedUpdateId, sourceRunId, invalidSourceRunId, changeId]);
    assert.ifError(ledgerCleanup.error);
    const runCleanup = await admin.from('legacy_opportunity_backfill_runs').delete().in('id', [runId, rerunId, conflictRunId]);
    assert.ifError(runCleanup.error);
    const observationIds = [observationId, importedObservationId];
    await admin.from('canonical_opportunity_events').delete().in('observation_id', observationIds);
    await admin.from('canonical_opportunity_sources').delete().in('observation_id', observationIds);
    await admin.from('procurement_source_observations').delete().in('id', observationIds);
    const canonicalRows = await admin.from('canonical_opportunities').select('id')
      .in('canonical_key', [canonicalKey, 'legacy:maneps:' + importedUpdateId]);
    if (canonicalRows.data?.length) {
      const canonicalIds = canonicalRows.data.map(row => row.id);
      await admin.from('organisation_opportunities').delete().in('canonical_opportunity_id', canonicalIds);
      await admin.from('canonical_opportunities').delete().in('id', canonicalIds);
    }
    if (targetRunId) await admin.from('procurement_source_runs').delete().eq('id', targetRunId);
    await admin.from('app_records').delete().in('id', fixtureRows.map(row => row.id));
  }
});
