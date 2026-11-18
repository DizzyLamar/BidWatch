import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPhase2BDryRunReport, parseLocalSupabaseUrl, readAllRows } from '../scripts/phase-2b-dry-run';

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

test('dry-run excludes other organisations from the legacy baseline but detects foreign tender references', () => {
  const otherOrg = '99999999-9999-4999-8999-999999999999';
  const foreignUpdate = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const foreignChange = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const report = buildPhase2BDryRunReport({
    organisationId: ORG,
    rows: [
      row(UPDATE, 'opportunity_updates', update()),
      row(foreignUpdate, 'opportunity_updates', update({ reference: 'OTHER/001' }), 'organisation', otherOrg),
      row(foreignChange, 'opportunity_changes', {
        opportunityUpdateId: foreignUpdate,
        detectedAt: '2026-11-03T10:00:00.000Z',
        changedFields: ['title'],
        before: { title: 'Old title' },
        after: { title: 'New title' },
      }, 'organisation', otherOrg),
      row(TENDER, 'tenders', { title: 'Foreign tender' }, 'organisation', otherOrg),
      row('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'opportunity_updates', update({
        reference: 'TEST/FOREIGN-TENDER', state: 'imported', importedTenderId: TENDER,
      })),
    ],
  });
  assert.equal(report.baseline.collections.opportunity_updates, 2);
  assert.equal(report.baseline.collections.opportunity_changes, 0);
  assert.equal(report.baseline.collections.tenders, 0);
  assert.equal(report.validation.findingsByCode.scope_mismatch, undefined);
  assert.equal(report.validation.findingsByCode.imported_tender_scope_mismatch, 1);
});

test('local Supabase URL guard accepts IPv4, hostname and bracketed IPv6 loopback only', () => {
  assert.equal(parseLocalSupabaseUrl('http://localhost:54321').hostname, 'localhost');
  assert.equal(parseLocalSupabaseUrl('http://127.0.0.1:54321').hostname, '127.0.0.1');
  assert.equal(parseLocalSupabaseUrl('http://[::1]:54321').hostname, '[::1]');
  assert.throws(() => parseLocalSupabaseUrl('https://supabase.example.com'), /permanently restricted to localhost/);
  assert.throws(() => parseLocalSupabaseUrl('ftp://localhost:54321'), /permanently restricted to localhost/);
  assert.throws(() => parseLocalSupabaseUrl('http://localhost:54321@evil.example'), /permanently restricted to localhost/);
  assert.throws(() => parseLocalSupabaseUrl('http://user:pass@localhost:54321'), /permanently restricted to localhost/);
});

test('dry-run quarantines non-object JSON records without aborting the report', () => {
  const malformed = null as unknown as Record<string, unknown>;
  const report = buildPhase2BDryRunReport({
    organisationId: ORG,
    rows: [
      row(UPDATE, 'opportunity_updates', malformed),
      row(RUN, 'opportunity_source_runs', malformed, 'global', null),
      row(CHANGE, 'opportunity_changes', malformed),
    ],
  });
  assert.equal(report.validation.updateRecords, 1);
  assert.equal(report.validation.quarantinedUpdateCandidates, 1);
  assert.equal(report.validation.migratableUpdateCandidates, 0);
  assert.equal(report.validation.quarantinedSourceRunCandidates, 1);
  assert.equal(report.validation.migratableSourceRunCandidates, 0);
  assert.equal(report.validation.findingsByCode.invalid_record_shape, 3);
  assert.equal(report.history.legacyChangeRecords, 1);
  assert.equal(report.history.changesLinkedToKnownUpdates, 0);
});

test('dry-run quarantines malformed imported tender UUIDs without a tender lookup', () => {
  const report = buildPhase2BDryRunReport({
    organisationId: ORG,
    rows: [row(UPDATE, 'opportunity_updates', update({
      state: 'imported', importedTenderId: 'not-a-uuid',
    }))],
  });
  assert.equal(report.validation.quarantinedUpdateCandidates, 1);
  assert.equal(report.validation.findingsByCode.imported_tender_invalid_id, 1);
  assert.equal(report.validation.findingsByCode.imported_tender_missing, undefined);
});

test('dry-run report retains every quarantine finding above 1,000 records', () => {
  const rows = Array.from({ length: 1005 }, (_, index) => {
    const id = '00000000-0000-4000-8000-' + index.toString(16).padStart(12, '0');
    return row(id, 'opportunity_updates', update({ url: 'javascript:invalid' }));
  });
  const report = buildPhase2BDryRunReport({ organisationId: ORG, rows });
  assert.equal(report.validation.findingCount, 1005);
  assert.equal(report.validation.findings.length, 1005);
  assert.equal(report.validation.findings[0].code, 'invalid_notice_url');
  assert.equal(report.validation.findings[1004].code, 'invalid_notice_url');
});

test('dry-run matches imported tender UUIDs regardless of hexadecimal case', () => {
  const report = buildPhase2BDryRunReport({
    organisationId: ORG,
    rows: [
      row(TENDER, 'tenders', { title: 'Imported tender' }),
      row(UPDATE, 'opportunity_updates', update({
        state: 'imported', importedTenderId: TENDER.toUpperCase(),
      })),
    ],
  });
  assert.equal(report.validation.migratableUpdateCandidates, 1);
  assert.equal(report.validation.quarantinedUpdateCandidates, 0);
  assert.equal(report.validation.findingsByCode.imported_tender_missing, undefined);
});


test('legacy inventory keyset pagination does not skip rows when earlier UUIDs are deleted mid-scan', async () => {
  const initial = Array.from({ length: 1001 }, (_, index) => ({
    id: '00000000-0000-4000-8000-' + (index + 1).toString().padStart(12, '0'),
    table_name: 'opportunity_updates',
    record: { index: index + 1 },
    scope_type: 'organisation',
    organisation_id: ORG,
  }));
  let records = [...initial];
  let requests = 0;
  const client = {
    from: () => ({
      select: () => ({
        order: () => {
          let cursor: string | null = null;
          const builder = {
            gt: (_column: string, value: string) => { cursor = value; return builder; },
            limit: async (pageSize: number) => {
              requests += 1;
              const page = records.filter(item => cursor === null || item.id > cursor).slice(0, pageSize);
              // Simulate a concurrent deletion before the next request. Offset
              // pagination would now skip the first row of the following page.
              if (requests === 1) records = records.filter(item => item.id !== initial[9].id);
              return { data: page, error: null };
            },
          };
          return builder;
        },
      }),
    }),
  };
  const rows = await readAllRows(client, builder => builder as any);
  const ids = rows.map(item => item.id);
  assert.equal(requests, 3);
  assert.equal(ids.length, initial.length);
  assert.equal(new Set(ids).size, initial.length);
  assert.deepEqual(ids, initial.map(item => item.id));
});
