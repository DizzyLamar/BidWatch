import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPhase2BDryRunReport } from '../scripts/phase-2b-dry-run';

const ORG = '11111111-1111-4111-8111-111111111111';
const UPDATE = '22222222-2222-4222-8222-222222222222';
const TENDER = '33333333-3333-4333-8333-333333333333';
const CHANGE = '44444444-4444-4444-8444-444444444444';
const RUN = '55555555-5555-4555-8555-555555555555';

function row(id: string, table_name: string, record: Record<string, unknown>, scope_type = 'organisation', organisation_id: string | null = ORG) {
  return { id, table_name, record, scope_type, organisation_id };
}
function update(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: 'maneps',
    title: 'Supply of network security equipment',
    url: 'https://example.org/tender/1',
    firstSeenAt: '2026-11-01T10:00:00.000Z',
    lastSeenAt: '2026-11-02T10:00:00.000Z',
    state: 'new',
    fitLevel: 'direct',
    relevanceScore: 82,
    categories: ['Cybersecurity'],
    matchedTerms: ['firewall'],
    details: { documents: [{ title: 'Tender document', url: 'https://example.org/document.pdf' }] },
    ...overrides,
  };
}

test('dry-run accepts a valid update, matching imported tender and global source run', () => {
  const rows = [
    row(UPDATE, 'opportunity_updates', update()),
    row(TENDER, 'tenders', { title: 'Imported tender' }),
    row('66666666-6666-4666-8666-666666666666', 'opportunity_updates', update({
      state: 'imported', importedTenderId: TENDER,
    })),
    row(RUN, 'opportunity_source_runs', {
      sourceId: 'maneps', status: 'ok', scanType: 'scheduled',
      fetchedCount: 10, parsedCount: 10, relevantCount: 3, failedCount: 0,
      checkedAt: '2026-11-02T10:00:00.000Z', durationMs: 1200,
    }, 'global', null),
  ];
  const report = buildPhase2BDryRunReport({ organisationId: ORG, rows, generatedAt: '2026-11-18T00:00:00.000Z' });
  assert.equal(report.safety.databaseWrites, false);
  assert.equal(report.validation.migratableUpdateCandidates, 2);
  assert.equal(report.validation.quarantinedUpdateCandidates, 0);
  assert.equal(report.validation.migratableSourceRunCandidates, 1);
  assert.equal(report.history.reconstructableFullSnapshots, 0);
});

test('dry-run quarantines dismissed rows without a real dismissal timestamp', () => {
  const report = buildPhase2BDryRunReport({
    organisationId: ORG,
    rows: [row(UPDATE, 'opportunity_updates', update({ state: 'dismissed' }))],
  });
  assert.equal(report.validation.migratableUpdateCandidates, 0);
  assert.equal(report.validation.quarantinedUpdateCandidates, 1);
  assert.equal(report.validation.findingsByCode.dismissal_timestamp_unresolved, 1);
});

test('dry-run rejects impossible calendar timestamps and invalid URL schemes', () => {
  const report = buildPhase2BDryRunReport({
    organisationId: ORG,
    rows: [row(UPDATE, 'opportunity_updates', update({
      firstSeenAt: '2026-02-30T10:00:00.000Z',
      url: 'javascript:alert(1)',
    }))],
  });
  assert.equal(report.validation.quarantinedUpdateCandidates, 1);
  assert.equal(report.validation.findingsByCode.invalid_first_seen, 1);
  assert.equal(report.validation.findingsByCode.invalid_notice_url, 1);
});

test('dry-run rejects imported tender references crossing organisation boundaries', () => {
  const otherOrg = '77777777-7777-4777-8777-777777777777';
  const report = buildPhase2BDryRunReport({
    organisationId: ORG,
    rows: [
      row(TENDER, 'tenders', { title: 'Foreign tender' }, 'organisation', otherOrg),
      row(UPDATE, 'opportunity_updates', update({ state: 'imported', importedTenderId: TENDER })),
    ],
  });
  assert.equal(report.validation.quarantinedUpdateCandidates, 1);
  assert.equal(report.validation.findingsByCode.imported_tender_scope_mismatch, 1);
});

test('dry-run reports orphaned changes without claiming reconstructable snapshots', () => {
  const report = buildPhase2BDryRunReport({
    organisationId: ORG,
    rows: [row(CHANGE, 'opportunity_changes', {
      opportunityUpdateId: '88888888-8888-4888-8888-888888888888',
      detectedAt: '2026-11-03T10:00:00.000Z',
      changedFields: ['title'],
      before: { title: 'Old title' },
      after: { title: 'New title' },
    })],
  });
  assert.equal(report.history.legacyChangeRecords, 1);
  assert.equal(report.history.changesLinkedToKnownUpdates, 0);
  assert.equal(report.history.reconstructableFullSnapshots, 0);
  assert.equal(report.validation.findingsByCode.orphan_change, 1);
});

test('dry-run quarantines malformed document links and credential-bearing URLs', () => {
  const report = buildPhase2BDryRunReport({
    organisationId: ORG,
    rows: [row(UPDATE, 'opportunity_updates', update({
      url: 'https://user:secret@example.org/tender/1',
      details: { documents: [{ title: 'Tender document', url: 'javascript:alert(1)' }] },
    }))],
  });
  assert.equal(report.validation.quarantinedUpdateCandidates, 1);
  assert.equal(report.validation.findingsByCode.invalid_notice_url, 1);
  assert.equal(report.validation.findingsByCode.invalid_documents, 1);
});

test('dry-run quarantines imported references to structurally invalid same-organisation tenders', () => {
  const report = buildPhase2BDryRunReport({
    organisationId: ORG,
    rows: [
      row(TENDER, 'tenders', { description: 'Missing title' }),
      row(UPDATE, 'opportunity_updates', update({ state: 'imported', importedTenderId: TENDER })),
    ],
  });
  assert.equal(report.validation.quarantinedUpdateCandidates, 1);
  assert.equal(report.validation.findingsByCode.imported_tender_invalid, 1);
});
