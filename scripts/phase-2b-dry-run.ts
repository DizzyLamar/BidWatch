import { createClient } from '@supabase/supabase-js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

type LegacyRow = {
  id: string;
  table_name: string;
  record: Record<string, unknown>;
  scope_type: string | null;
  organisation_id: string | null;
};

type Finding = { recordId: string; collection: string; code: string; message: string };
type SourceDefinition = { id: string; name: string; url: string };

export const LEGACY_SOURCES: SourceDefinition[] = [
  { id: 'maneps', name: 'MANePS procurement notices', url: 'https://maneps.mw/procurement-notice' },
  { id: 'ppda', name: 'PPDA procurement notices', url: 'https://ppda.mw/tenders' },
  { id: 'malawi-gov', name: 'Malawi Government tenders', url: 'https://www.malawi.gov.mw/index.php/resources/publications/tenders' },
  { id: 'careersmw', name: 'Careers Malawi tenders & bids', url: 'https://careersmw.com/tenders-and-non-consultancy-services/' },
  { id: 'careersmw-consultancies', name: 'Careers Malawi consultancies', url: 'https://careersmw.com/consultancies-tenders/' },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIT_LEVELS = new Set(['direct', 'partner', 'peripheral']);
const UPDATE_STATES = new Set(['new', 'imported', 'dismissed']);
const RUN_STATUSES = new Set(['ok', 'error', 'authentication_required']);
const SCAN_TYPES = new Set(['scheduled', 'manual']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function validTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const [hour, minute, second] = value.slice(11, 19).split(':').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day && hour <= 23 && minute <= 59 && second <= 59;
}
function validHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch { return false; }
}
function addFinding(findings: Finding[], row: LegacyRow, code: string, message: string) {
  findings.push({ recordId: row.id, collection: row.table_name, code, message });
}
function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) {
    const value = key(item) || '(missing)';
    result[value] = (result[value] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

export function buildPhase2BDryRunReport(input: {
  organisationId: string;
  rows: LegacyRow[];
  generatedAt?: string;
}) {
  const { organisationId, rows } = input;
  const findings: Finding[] = [];
  const sourceKeys = new Set(LEGACY_SOURCES.map(source => source.id));
  const updates = rows.filter(row => row.table_name === 'opportunity_updates');
  const changes = rows.filter(row => row.table_name === 'opportunity_changes');
  const runs = rows.filter(row => row.table_name === 'opportunity_source_runs');
  const tenders = rows.filter(row => row.table_name === 'tenders');
  const updateById = new Map(updates.map(row => [row.id, row]));
  const tenderById = new Map(tenders.map(row => [row.id, row]));

  for (const row of updates) {
    const item = row.record;
    if (!UUID.test(row.id)) addFinding(findings, row, 'invalid_record_id', 'Legacy app_records ID is not a UUID.');
    if (row.scope_type !== 'organisation' || row.organisation_id !== organisationId) {
      addFinding(findings, row, 'scope_mismatch', 'Opportunity update is not scoped to the resolved legacy organisation.');
    }
    if (typeof item.sourceId !== 'string' || !sourceKeys.has(item.sourceId)) {
      addFinding(findings, row, 'unknown_source', 'sourceId is missing or is not one of the five registered discovery sources.');
    }
    if (typeof item.title !== 'string' || !item.title.trim()) addFinding(findings, row, 'missing_title', 'Target observation requires a non-empty title.');
    if (!validHttpUrl(item.url)) addFinding(findings, row, 'invalid_notice_url', 'Target observation requires an absolute HTTP(S) notice URL.');
    if (!validTimestamp(item.firstSeenAt)) addFinding(findings, row, 'invalid_first_seen', 'firstSeenAt is missing or is not a valid timezone-aware ISO timestamp.');
    if (!validTimestamp(item.lastSeenAt)) addFinding(findings, row, 'invalid_last_seen', 'lastSeenAt is missing or is not a valid timezone-aware ISO timestamp.');
    if (validTimestamp(item.firstSeenAt) && validTimestamp(item.lastSeenAt) &&
      new Date(String(item.lastSeenAt)).getTime() < new Date(String(item.firstSeenAt)).getTime()) {
      addFinding(findings, row, 'seen_order_invalid', 'lastSeenAt is earlier than firstSeenAt.');
    }
    if (!UPDATE_STATES.has(String(item.state))) addFinding(findings, row, 'unknown_update_state', 'Legacy workflow state is not recognised.');
    if (item.fitLevel != null && !FIT_LEVELS.has(String(item.fitLevel))) addFinding(findings, row, 'invalid_fit_level', 'fitLevel is not accepted by the Phase 2 schema.');
    if (item.relevanceScore != null && (!Number.isFinite(Number(item.relevanceScore)) || Number(item.relevanceScore) < 0 || Number(item.relevanceScore) > 100)) {
      addFinding(findings, row, 'invalid_relevance_score', 'relevanceScore must be between 0 and 100.');
    }
    if (item.categories != null && !Array.isArray(item.categories)) addFinding(findings, row, 'invalid_categories', 'categories must be an array when present.');
    if (item.matchedTerms != null && !Array.isArray(item.matchedTerms)) addFinding(findings, row, 'invalid_matched_terms', 'matchedTerms must be an array when present.');
    if (item.details != null && !isObject(item.details)) addFinding(findings, row, 'invalid_details', 'details must be an object when present.');
    if (isObject(item.details) && item.details.documents != null && !Array.isArray(item.details.documents)) {
      addFinding(findings, row, 'invalid_documents', 'details.documents must be an array when present.');
    }
    if (item.state === 'dismissed' && !validTimestamp(item.dismissedAt)) {
      addFinding(findings, row, 'dismissal_timestamp_unresolved', 'No valid legacy dismissedAt timestamp exists; do not invent dismissed_at.');
    }
    if (item.state === 'imported') {
      const tenderId = typeof item.importedTenderId === 'string' ? item.importedTenderId : '';
      const tender = tenderById.get(tenderId);
      if (!tender) addFinding(findings, row, 'imported_tender_missing', 'Imported state does not resolve to an existing legacy tender record.');
      else if (tender.scope_type !== 'organisation' || tender.organisation_id !== organisationId) {
        addFinding(findings, row, 'imported_tender_scope_mismatch', 'Referenced tender is not in the same legacy organisation.');
      }
    }
  }

  for (const row of runs) {
    const run = row.record;
    if (row.scope_type !== 'global' || row.organisation_id !== null) {
      addFinding(findings, row, 'run_scope_mismatch', 'Source run should be globally scoped in the Phase 1 legacy store.');
    }
    if (typeof run.sourceId !== 'string' || !sourceKeys.has(run.sourceId)) addFinding(findings, row, 'unknown_run_source', 'Source run has an unknown sourceId.');
    if (!RUN_STATUSES.has(String(run.status))) addFinding(findings, row, 'unknown_run_status', 'Source run status is not supported by the target mapping.');
    if (!SCAN_TYPES.has(String(run.scanType))) addFinding(findings, row, 'unknown_scan_type', 'Source run scanType is not scheduled or manual.');
    for (const field of ['fetchedCount', 'parsedCount', 'relevantCount', 'failedCount']) {
      const value = run[field];
      if (!Number.isInteger(value) || Number(value) < 0) addFinding(findings, row, 'invalid_' + field, field + ' must be a non-negative integer.');
    }
    if (!validTimestamp(run.checkedAt)) addFinding(findings, row, 'invalid_checked_at', 'checkedAt is missing or invalid.');
    if (run.durationMs != null && (!Number.isFinite(Number(run.durationMs)) || Number(run.durationMs) < 0)) {
      addFinding(findings, row, 'invalid_duration', 'durationMs must be a non-negative number.');
    }
  }

  for (const row of changes) {
    const change = row.record;
    if (row.scope_type !== 'organisation' || row.organisation_id !== organisationId) {
      addFinding(findings, row, 'change_scope_mismatch', 'Opportunity change is not scoped to the resolved legacy organisation.');
    }
    if (typeof change.opportunityUpdateId !== 'string' || !updateById.has(change.opportunityUpdateId)) {
      addFinding(findings, row, 'orphan_change', 'Change record does not resolve to an opportunity_updates app_records ID.');
    }
    if (!validTimestamp(change.detectedAt)) addFinding(findings, row, 'invalid_detected_at', 'detectedAt is missing or invalid.');
    if (!Array.isArray(change.changedFields) || !change.changedFields.every(field => typeof field === 'string')) {
      addFinding(findings, row, 'invalid_changed_fields', 'changedFields must be an array of strings.');
    }
    if (!isObject(change.before) || !isObject(change.after)) {
      addFinding(findings, row, 'invalid_change_delta', 'before and after must both be JSON objects.');
    } else if (Array.isArray(change.changedFields)) {
      for (const field of change.changedFields) {
        if (!(field in change.before) || !(field in change.after)) {
          addFinding(findings, row, 'incomplete_change_delta', 'A changedFields entry is absent from before or after; full history cannot be reconstructed.');
          break;
        }
      }
    }
  }

  const blockingCodes = new Set([
    'invalid_record_id', 'scope_mismatch', 'unknown_source', 'missing_title', 'invalid_notice_url',
    'invalid_first_seen', 'invalid_last_seen', 'seen_order_invalid', 'unknown_update_state',
    'invalid_fit_level', 'invalid_relevance_score', 'invalid_categories', 'invalid_matched_terms',
    'invalid_details', 'invalid_documents', 'dismissal_timestamp_unresolved', 'imported_tender_missing',
    'imported_tender_scope_mismatch',
  ]);
  const blockedUpdateIds = new Set(findings.filter(f => f.collection === 'opportunity_updates' && blockingCodes.has(f.code)).map(f => f.recordId));
  const runBlocking = new Set(['run_scope_mismatch', 'unknown_run_source', 'unknown_run_status', 'unknown_scan_type',
    'invalid_fetchedCount', 'invalid_parsedCount', 'invalid_relevantCount', 'invalid_failedCount', 'invalid_checked_at', 'invalid_duration']);
  const blockedRunIds = new Set(findings.filter(f => f.collection === 'opportunity_source_runs' && runBlocking.has(f.code)).map(f => f.recordId));

  const history = {
    legacyChangeRecords: changes.length,
    changesLinkedToKnownUpdates: changes.filter(row => updateById.has(String(row.record.opportunityUpdateId))).length,
    changesWithValidTimestamps: changes.filter(row => validTimestamp(row.record.detectedAt)).length,
    reconstructableFullSnapshots: 0,
    note: 'This pass validates sparse before/after deltas only. It does not claim complete baseline snapshots or generate observation versions.',
  };

  return {
    reportVersion: 1,
    mode: 'read-only-dry-run',
    generatedAt: input.generatedAt || new Date().toISOString(),
    organisation: { id: organisationId, legacySlug: 'legacy-bidwatch-workspace' },
    safety: {
      databaseWrites: false,
      storageAccess: false,
      productionTargetAllowed: false,
      rawPayloadsIncluded: false,
    },
    baseline: {
      collections: {
        opportunity_updates: updates.length,
        opportunity_changes: changes.length,
        opportunity_source_runs: runs.length,
        tenders: tenders.length,
      },
      updatesBySource: countBy(updates, row => String(row.record.sourceId || '')),
      updatesByState: countBy(updates, row => String(row.record.state || '')),
      sourceRunsBySource: countBy(runs, row => String(row.record.sourceId || '')),
      sourceRunsByStatus: countBy(runs, row => String(row.record.status || '')),
    },
    validation: {
      updateRecords: updates.length,
      migratableUpdateCandidates: updates.length - blockedUpdateIds.size,
      quarantinedUpdateCandidates: blockedUpdateIds.size,
      sourceRunRecords: runs.length,
      migratableSourceRunCandidates: runs.length - blockedRunIds.size,
      quarantinedSourceRunCandidates: blockedRunIds.size,
      findingCount: findings.length,
      findingsByCode: countBy(findings, finding => finding.code),
      sampleFindings: findings.slice(0, 1000),
    },
    history,
    canonicalisation: {
      seedCanonicalPerObservation: updates.length - blockedUpdateIds.size,
      automaticCrossSourceMerges: 0,
      note: 'No cross-source identity merges are performed by the dry-run.',
    },
    stopConditions: [
      ...(blockedUpdateIds.size ? ['Resolve or explicitly quarantine all blocked opportunity updates.'] : []),
      ...(blockedRunIds.size ? ['Resolve or explicitly quarantine all blocked source runs.'] : []),
      ...(history.reconstructableFullSnapshots < history.legacyChangeRecords ? ['History version backfill requires a separate complete-snapshot reconstruction strategy.'] : []),
    ],
  };
}

function assertLocalDryRunConfiguration() {
  if (process.env.PHASE2B_DRY_RUN !== '1') throw new Error('Refusing to run: set PHASE2B_DRY_RUN=1 explicitly.');
  const urlValue = process.env.LOCAL_SUPABASE_URL || '';
  const key = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY || '';
  if (!urlValue || !key) throw new Error('Set LOCAL_SUPABASE_URL and LOCAL_SUPABASE_SERVICE_ROLE_KEY for the local Supabase stack.');
  const url = new URL(urlValue);
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('Refusing non-local Supabase host. This tool is permanently restricted to localhost.');
  }
  return { url: url.toString(), key };
}

async function readAllRows(client: any, query: (builder: any) => any): Promise<LegacyRow[]> {
  const rows: LegacyRow[] = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const result = await query(client.from('app_records').select('id,table_name,record,scope_type,organisation_id')
      .order('id', { ascending: true }))
      .range(from, from + pageSize - 1);
    if (result.error) throw new Error('Read-only legacy inventory query failed: ' + result.error.message);
    const page = (result.data || []) as LegacyRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

export async function collectPhase2BDryRunReport(client: any) {
  const orgResult = await client.from('organisations').select('id,slug').eq('slug', 'legacy-bidwatch-workspace');
  if (orgResult.error) throw new Error('Could not resolve legacy organisation: ' + orgResult.error.message);
  if (!Array.isArray(orgResult.data) || orgResult.data.length !== 1) {
    throw new Error('Expected exactly one legacy-bidwatch-workspace organisation; found ' + (orgResult.data?.length ?? 0) + '.');
  }
  const organisationId = String(orgResult.data[0].id);
  const rows = await readAllRows(client, builder => builder.in('table_name', [
    'opportunity_updates', 'opportunity_changes', 'opportunity_source_runs', 'tenders',
  ]));
  return buildPhase2BDryRunReport({ organisationId, rows });
}

async function main() {
  const { url, key } = assertLocalDryRunConfiguration();
  const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const report = await collectPhase2BDryRunReport(client);
  const outputPath = resolve(process.env.PHASE2B_REPORT_PATH || 'artifacts/phase-2b-dry-run.json');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(JSON.stringify({
    reportPath: outputPath,
    mode: report.mode,
    baseline: report.baseline.collections,
    validation: {
      migratableUpdateCandidates: report.validation.migratableUpdateCandidates,
      quarantinedUpdateCandidates: report.validation.quarantinedUpdateCandidates,
      migratableSourceRunCandidates: report.validation.migratableSourceRunCandidates,
      quarantinedSourceRunCandidates: report.validation.quarantinedSourceRunCandidates,
      findingsByCode: report.validation.findingsByCode,
    },
    stopConditions: report.stopConditions,
  }, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  });
}
