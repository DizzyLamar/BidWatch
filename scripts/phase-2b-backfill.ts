import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  buildPhase2BDryRunReport,
  LEGACY_SOURCES,
  parseLocalSupabaseUrl,
  readAllRows,
} from './phase-2b-dry-run';

type LegacyRow = {
  id: string;
  table_name: string;
  record: Record<string, unknown>;
  scope_type: string | null;
  organisation_id: string | null;
};
type Finding = { recordId: string; collection: string; code: string; message: string };
type Snapshot = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UPDATE_BLOCKING = new Set([
  'invalid_record_id', 'invalid_record_shape', 'scope_mismatch', 'unknown_source', 'missing_title',
  'invalid_notice_url', 'invalid_first_seen', 'invalid_last_seen', 'seen_order_invalid',
  'unknown_update_state', 'invalid_fit_level', 'invalid_relevance_score', 'invalid_categories',
  'invalid_matched_terms', 'invalid_details', 'invalid_documents', 'dismissal_timestamp_unresolved',
  'imported_tender_invalid_id', 'imported_tender_missing', 'imported_tender_scope_mismatch',
  'imported_tender_invalid',
]);
const RUN_BLOCKING = new Set([
  'invalid_record_id', 'invalid_record_shape', 'run_scope_mismatch', 'unknown_run_source',
  'unknown_run_status', 'unknown_scan_type', 'invalid_fetchedCount', 'invalid_parsedCount',
  'invalid_relevantCount', 'invalid_failedCount', 'invalid_checked_at', 'invalid_duration',
]);
const HISTORY_FIELDS = new Set([
  'title', 'organisation', 'reference', 'deadline', 'description', 'noticeType', 'url',
  'relevanceScore', 'relevanceLevel', 'fitLevel', 'classificationReason', 'contentHash',
  'categories', 'matchedTerms',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return '{' + Object.keys(object).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(object[key])).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}
function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function deterministicUuid(value: string): string {
  const bytes = createHash('sha256').update('bidwatch-phase2b:' + value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}
function parseDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}
function sameField(field: string, a: unknown, b: unknown): boolean {
  if (field.endsWith('_at')) {
    if (a == null || b == null) return a == null && b == null;
    const at = Date.parse(String(a));
    const bt = Date.parse(String(b));
    if (Number.isFinite(at) && Number.isFinite(bt)) return at === bt;
  }
  return sameJson(a, b);
}
function addFinding(findings: Finding[], row: LegacyRow, code: string, message: string) {
  findings.push({ recordId: row.id, collection: row.table_name, code, message });
}
function countByStatus(records: Array<{ status: string }>) {
  return records.reduce<Record<string, number>>((counts, row) => {
    counts[row.status] = (counts[row.status] || 0) + 1;
    return counts;
  }, {});
}

export function reconstructHistorySnapshots(
  currentRecord: Record<string, unknown>,
  changes: Array<{ id: string; record: Record<string, unknown> }>,
): { ok: true; snapshots: Array<{ legacyChangeId: string; observedAt: string; snapshot: Snapshot; hash: string }> } |
   { ok: false; reason: string } {
  if (!changes.length) return { ok: true, snapshots: [] };
  const ordered = [...changes].sort((a, b) => {
    const at = Date.parse(String(a.record.detectedAt || ''));
    const bt = Date.parse(String(b.record.detectedAt || ''));
    return at - bt || a.id.localeCompare(b.id);
  });
  const state: Record<string, unknown> = {};
  for (const field of HISTORY_FIELDS) state[field] = currentRecord[field] ?? null;
  const reversed: Array<{ legacyChangeId: string; observedAt: string; snapshot: Snapshot; hash: string }> = [];

  for (const changeRow of [...ordered].reverse()) {
    const change = changeRow.record;
    const detectedAt = parseDate(change.detectedAt);
    if (!detectedAt) return { ok: false, reason: 'Change has no valid detectedAt timestamp.' };
    if (!Array.isArray(change.changedFields) || !change.changedFields.length ||
        !change.changedFields.every((field): field is string => typeof field === 'string' && HISTORY_FIELDS.has(field))) {
      return { ok: false, reason: 'Change contains an empty or unsupported changedFields list.' };
    }
    if (!isObject(change.before) || !isObject(change.after)) {
      return { ok: false, reason: 'Change before/after values are not objects.' };
    }
    for (const field of change.changedFields as string[]) {
      if (!(field in change.before) || !(field in change.after)) {
        return { ok: false, reason: 'A changed field is missing from before or after.' };
      }
      if (!sameJson(state[field], change.after[field])) {
        return { ok: false, reason: 'Change chain does not match the current legacy record for field ' + field + '.' };
      }
    }
    const snapshot = normalizeSnapshot(state);
    reversed.push({
      legacyChangeId: changeRow.id,
      observedAt: detectedAt,
      snapshot,
      hash: sha256(snapshot),
    });
    for (const field of change.changedFields as string[]) state[field] = change.before[field];
  }

  return { ok: true, snapshots: reversed.reverse() };
}

function normalizeSnapshot(record: Record<string, unknown>): Snapshot {
  return {
    title: asText(record.title) || '',
    buyer_name: asText(record.organisation),
    reference: asText(record.reference),
    source_url: asText(record.url) || '',
    deadline_at: parseDate(record.deadline),
    description: asText(record.description),
    notice_type: asText(record.noticeType),
    relevance_score: record.relevanceScore == null ? null : Number(record.relevanceScore),
    relevance_level: asText(record.relevanceLevel),
    fit_level: asText(record.fitLevel),
    classification_reason: asText(record.classificationReason),
    content_hash: asText(record.contentHash),
    matched_categories: arrayOfStrings(record.categories),
    matched_terms: arrayOfStrings(record.matchedTerms),
  };
}

async function loadLegacy(client: any) {
  const orgResult = await client.from('organisations').select('id,slug').eq('slug', 'legacy-bidwatch-workspace');
  if (orgResult.error) throw new Error('Could not resolve legacy organisation: ' + orgResult.error.message);
  if (!Array.isArray(orgResult.data) || orgResult.data.length !== 1) {
    throw new Error('Expected exactly one legacy-bidwatch-workspace organisation; found ' + (orgResult.data?.length ?? 0) + '.');
  }
  const organisationId = String(orgResult.data[0].id);
  const organisationRows = await readAllRows(client, builder => builder
    .in('table_name', ['opportunity_updates', 'opportunity_changes'])
    .eq('organisation_id', organisationId));
  const runRows = await readAllRows(client, builder => builder.eq('table_name', 'opportunity_source_runs'));
  const tenderRows = await readAllRows(client, builder => builder.eq('table_name', 'tenders'));
  return { organisationId, updates: organisationRows.filter(row => row.table_name === 'opportunity_updates'),
    changes: organisationRows.filter(row => row.table_name === 'opportunity_changes'), runs: runRows, tenders: tenderRows };
}

async function assertResult(result: any, label: string) {
  if (result.error) throw new Error(label + ': ' + result.error.message);
  return result.data;
}
async function writeLedger(client: any, input: {
  collection: string; recordId: string; runId: string; organisationId: string;
  status: 'migrated' | 'quarantined'; targetIds?: Record<string, string>; findings?: Finding[];
}) {
  const result = await client.from('legacy_opportunity_backfill_records').upsert({
    legacy_collection: input.collection,
    legacy_record_id: input.recordId,
    run_id: input.runId,
    organisation_id: input.organisationId,
    status: input.status,
    target_ids: input.targetIds || {},
    findings: (input.findings || []).map(({ recordId: _id, collection: _collection, ...finding }) => finding),
    processed_at: new Date().toISOString(),
  }, { onConflict: 'legacy_collection,legacy_record_id' });
  await assertResult(result, 'Could not persist backfill checkpoint for ' + input.collection + '/' + input.recordId);
}

async function ensureRun(client: any, runId: string, organisationId: string) {
  const existing = await client.from('legacy_opportunity_backfill_runs').select('id,organisation_id,status')
    .eq('id', runId).maybeSingle();
  await assertResult(existing, 'Could not inspect backfill run');
  if (existing.data) {
    if (existing.data.organisation_id !== organisationId) throw new Error('Backfill run ID belongs to a different organisation.');
    if (existing.data.status === 'completed') throw new Error('This run is already completed. Start a new run ID for an idempotent verification pass.');
    const update = await client.from('legacy_opportunity_backfill_runs').update({ status: 'running', completed_at: null })
      .eq('id', runId);
    await assertResult(update, 'Could not resume backfill run');
    return;
  }
  const inserted = await client.from('legacy_opportunity_backfill_runs').insert({
    id: runId, organisation_id: organisationId, status: 'running', summary: {},
  });
  await assertResult(inserted, 'Could not create backfill run. Another active run may already own this organisation.');
}

async function loadMigratedIds(client: any, collection: string): Promise<Set<string>> {
  const result = await client.from('legacy_opportunity_backfill_records').select('legacy_record_id')
    .eq('legacy_collection', collection).eq('status', 'migrated');
  const rows = await assertResult(result, 'Could not load existing backfill checkpoints');
  return new Set((rows || []).map((row: any) => String(row.legacy_record_id)));
}

async function mapSourceRegistry(client: any) {
  const map = new Map<string, string>();
  for (const source of LEGACY_SOURCES) {
    const existingResult = await client.from('procurement_sources')
      .select('id,source_key,name,base_url,adapter_key').eq('source_key', source.id).maybeSingle();
    const existing = await assertResult(existingResult, 'Could not inspect procurement source registry');
    if (existing) {
      if (existing.name !== source.name || existing.base_url !== source.url || existing.adapter_key !== source.id) {
        throw new Error('Existing procurement source registry entry differs from the legacy adapter definition: ' + source.id);
      }
      map.set(source.id, String(existing.id));
      continue;
    }
    const inserted = await client.from('procurement_sources').insert({
      source_key: source.id, name: source.name, base_url: source.url, adapter_key: source.id, status: 'active',
    }).select('id').single();
    const data = await assertResult(inserted, 'Could not create procurement source registry entry');
    map.set(source.id, String(data.id));
  }
  if (map.size !== LEGACY_SOURCES.length) throw new Error('Source registry did not resolve all five expected sources.');
  return map;
}

function sourceRunPayload(row: LegacyRow, sourceId: string) {
  const item = row.record;
  const completedAt = parseDate(item.checkedAt)!;
  const duration = item.durationMs == null ? null : Number(item.durationMs);
  const startedAt = duration == null ? completedAt : new Date(Date.parse(completedAt) - duration).toISOString();
  const status = item.status === 'authentication_required' ? 'authentication_required' : item.status;
  return {
    id: deterministicUuid('opportunity_source_runs:' + row.id),
    source_id: sourceId,
    scan_type: item.scanType,
    status,
    started_at: startedAt,
    completed_at: completedAt,
    fetched_count: Number(item.fetchedCount),
    parsed_count: Number(item.parsedCount),
    relevant_count: Number(item.relevantCount),
    failed_count: Number(item.failedCount),
    safe_message: null,
    metadata: {
      legacy_record_id: row.id,
      access_method: typeof item.accessMethod === 'string' ? item.accessMethod : null,
      duration_ms: duration,
      started_at_derivation: duration == null ? 'checkedAt; duration unavailable in legacy record' : 'checkedAt minus durationMs',
    },
  };
}

function observationPayload(row: LegacyRow, sourceId: string) {
  const item = row.record;
  const details = isObject(item.details) ? item.details : {};
  const documentLinks = Array.isArray(details.documents)
    ? details.documents.filter((document: any) => isObject(document) && typeof document.title === 'string' &&
      typeof document.url === 'string').map((document: any) => ({ title: document.title, url: document.url }))
    : [];
  const snapshot = normalizeSnapshot(item);
  const sourceStatus = item.sourceStatus === 'active' ? 'active'
    : item.sourceStatus === 'not-seen' ? 'not_seen'
      : item.sourceStatus === 'withdrawn' ? 'withdrawn' : 'unknown';
  const sourceDefinition = LEGACY_SOURCES.find(source => source.id === item.sourceId);
  if (!sourceDefinition) throw new Error('Legacy source registry definition is missing.');
  const rawPayload = {
    legacy_record_id: row.id,
    legacy_source_key: item.sourceId,
    source_name: sourceDefinition.name,
    source_listing_url: sourceDefinition.url,
  };
  const sourceKey = 'legacy-app-record:' + row.id;
  return {
    id: deterministicUuid('observation:' + item.sourceId + ':' + row.id),
    source_id: sourceId,
    source_key: sourceKey,
    external_id: asText(item.externalId),
    reference: asText(item.reference),
    source_url: String(snapshot.source_url || ''),
    title: String(snapshot.title || ''),
    buyer_name: asText(item.organisation),
    published_at: parseDate(details.publishedAt),
    deadline_at: parseDate(item.deadline),
    notice_type: asText(item.noticeType),
    procurement_method: asText(details.procurementMethod),
    description: asText(item.description),
    document_links: documentLinks,
    raw_payload: rawPayload,
    content_hash: sha256(snapshot),
    first_seen_at: parseDate(item.firstSeenAt)!,
    last_seen_at: parseDate(item.lastSeenAt)!,
    source_status: sourceStatus,
  };
}

function pursuitPayload(row: LegacyRow, organisationId: string, canonicalId: string) {
  const item = row.record;
  const state = item.state === 'imported' ? 'converted' : item.state;
  return {
    organisation_id: organisationId,
    canonical_opportunity_id: canonicalId,
    state,
    fit_level: asText(item.fitLevel),
    relevance_score: item.relevanceScore == null ? null : Number(item.relevanceScore),
    classification_version: asText(item.classifierVersion),
    matched_categories: arrayOfStrings(item.categories),
    matched_terms: arrayOfStrings(item.matchedTerms),
    classification_reason: asText(item.classificationReason),
    dismissed_at: item.state === 'dismissed' ? parseDate(item.dismissedAt) : null,
    converted_tender_id: item.state === 'imported' ? String(item.importedTenderId) : null,
  };
}

async function ensureCanonicalLink(client: any, observationId: string, canonicalId: string) {
  const existing = await client.from('canonical_opportunity_sources')
    .select('id,canonical_opportunity_id,review_status').eq('observation_id', observationId);
  const rows = await assertResult(existing, 'Could not inspect canonical links');
  const active = (rows || []).filter((row: any) => ['automatic', 'pending_review', 'confirmed'].includes(row.review_status));
  if (active.length > 1) throw new Error('Observation already has multiple active canonical links.');
  if (active.length === 1) {
    if (active[0].canonical_opportunity_id !== canonicalId) {
      throw new Error('Observation is already linked to a different canonical opportunity; refusing reassignment.');
    }
    return String(active[0].id);
  }
  const inserted = await client.from('canonical_opportunity_sources').insert({
    canonical_opportunity_id: canonicalId,
    observation_id: observationId,
    match_method: 'source_observation_seed',
    match_confidence: null,
    review_status: 'automatic',
  }).select('id').single();
  const data = await assertResult(inserted, 'Could not create canonical source link');
  return String(data.id);
}

async function ensureLinkEvent(client: any, observationId: string, canonicalId: string, eventId: string, legacyRecordId: string) {
  const payload = {
    id: eventId,
    event_type: 'source_linked',
    canonical_opportunity_id: canonicalId,
    observation_id: observationId,
    reason: 'Initial one-observation canonical seed during legacy backfill',
    details: { legacy_record_id: legacyRecordId, match_method: 'source_observation_seed' },
  };
  const existingResult = await client.from('canonical_opportunity_events').select('*').eq('id', eventId).maybeSingle();
  const existing = await assertResult(existingResult, 'Could not inspect canonical source-link audit event');
  if (existing) {
    for (const field of ['event_type', 'canonical_opportunity_id', 'observation_id', 'reason', 'details']) {
      if (!sameJson(existing[field], (payload as any)[field])) {
        throw new Error('Existing canonical source-link audit event was changed; refusing to overwrite it.');
      }
    }
    return;
  }
  const inserted = await client.from('canonical_opportunity_events').insert(payload);
  await assertResult(inserted, 'Could not persist canonical source-link audit event');
}

async function inspectPartialUpdateTargets(client: any, row: LegacyRow, organisationId: string, sourceId: string) {
  const ids: Record<string, string> = {};
  const sourceKey = 'legacy-app-record:' + row.id;
  const observationResult = await client.from('procurement_source_observations').select('id')
    .eq('source_id', sourceId).eq('source_key', sourceKey).maybeSingle();
  if (observationResult.data?.id) ids.observation_id = String(observationResult.data.id);

  const canonicalKey = 'legacy:' + row.record.sourceId + ':' + row.id;
  const canonicalResult = await client.from('canonical_opportunities').select('id')
    .eq('canonical_key', canonicalKey).maybeSingle();
  if (canonicalResult.data?.id) ids.canonical_opportunity_id = String(canonicalResult.data.id);

  if (ids.observation_id) {
    const linkResult = await client.from('canonical_opportunity_sources').select('id')
      .eq('observation_id', ids.observation_id).in('review_status', ['automatic', 'pending_review', 'confirmed']).maybeSingle();
    if (linkResult.data?.id) ids.canonical_source_link_id = String(linkResult.data.id);
    const eventId = deterministicUuid('source-linked-event:' + ids.observation_id);
    const eventResult = await client.from('canonical_opportunity_events').select('id').eq('id', eventId).maybeSingle();
    if (eventResult.data?.id) ids.canonical_source_event_id = String(eventResult.data.id);
  }
  if (ids.canonical_opportunity_id) {
    const pursuitResult = await client.from('organisation_opportunities').select('id')
      .eq('organisation_id', organisationId).eq('canonical_opportunity_id', ids.canonical_opportunity_id).maybeSingle();
    if (pursuitResult.data?.id) ids.organisation_opportunity_id = String(pursuitResult.data.id);
  }
  return ids;
}

async function migrateUpdate(client: any, row: LegacyRow, organisationId: string, sourceIds: Map<string, string>, tenderRows: LegacyRow[]) {
  const sourceId = sourceIds.get(String(row.record.sourceId));
  if (!sourceId) throw new Error('Validated source key was not present in source registry.');
  if (row.record.state === 'imported') {
    const tender = tenderRows.find(candidate => candidate.id.toLowerCase() === String(row.record.importedTenderId).toLowerCase());
    if (!tender || tender.scope_type !== 'organisation' || tender.organisation_id !== organisationId ||
        !isObject(tender.record) || !asText(tender.record.title)) {
      throw new Error('Imported tender ownership or structure changed after validation; refusing conversion mapping.');
    }
  }
  const observation = observationPayload(row, sourceId);
  const observationResult = await client.from('procurement_source_observations')
    .select('*').eq('source_id', sourceId).eq('source_key', observation.source_key).maybeSingle();
  const existingObservation = await assertResult(observationResult, 'Could not inspect source observation');
  let observationId: string;
  if (existingObservation) {
    const fields = Object.keys(observation) as Array<keyof typeof observation>;
    for (const field of fields) {
      if (!sameJson(existingObservation[field as string], observation[field])) {
        throw new Error('Existing source observation differs from the deterministic legacy mapping; refusing to overwrite it.');
      }
    }
    observationId = String(existingObservation.id);
  } else {
    const inserted = await client.from('procurement_source_observations').insert(observation).select('id').single();
    const data = await assertResult(inserted, 'Could not insert source observation');
    observationId = String(data.id);
  }

  const canonicalKey = 'legacy:' + row.record.sourceId + ':' + row.id;
  const canonicalPayload = {
    canonical_key: canonicalKey,
    title: observation.title,
    buyer_name: observation.buyer_name,
    reference: observation.reference,
    published_at: observation.published_at,
    deadline_at: observation.deadline_at,
    description: observation.description,
    notice_type: observation.notice_type,
    procurement_method: observation.procurement_method,
    lifecycle_status: 'unknown',
    canonical_url: observation.source_url,
  };
  const canonicalResult = await client.from('canonical_opportunities').select('*')
    .eq('canonical_key', canonicalKey).maybeSingle();
  const existingCanonical = await assertResult(canonicalResult, 'Could not inspect canonical opportunity');
  let canonicalId: string;
  if (existingCanonical) {
    for (const [field, value] of Object.entries(canonicalPayload)) {
      if (!sameField(field, existingCanonical[field], value)) {
        throw new Error('Existing canonical opportunity differs from the deterministic legacy mapping; refusing to overwrite it.');
      }
    }
    canonicalId = String(existingCanonical.id);
  } else {
    const inserted = await client.from('canonical_opportunities').insert(canonicalPayload).select('id').single();
    const data = await assertResult(inserted, 'Could not insert canonical opportunity');
    canonicalId = String(data.id);
  }
  const linkId = await ensureCanonicalLink(client, observationId, canonicalId);
  const eventId = deterministicUuid('source-linked-event:' + observationId);
  await ensureLinkEvent(client, observationId, canonicalId, eventId, row.id);

  const desiredPursuit = pursuitPayload(row, organisationId, canonicalId);
  const existingPursuitResult = await client.from('organisation_opportunities').select('*')
    .eq('organisation_id', organisationId).eq('canonical_opportunity_id', canonicalId).maybeSingle();
  const existingPursuit = await assertResult(existingPursuitResult, 'Could not inspect organisation pursuit');
  let pursuitId: string;
  if (existingPursuit) {
    for (const [field, value] of Object.entries(desiredPursuit)) {
      if (!sameField(field, existingPursuit[field], value)) {
        throw new Error('Existing organisation pursuit differs from the legacy mapping; refusing to overwrite organisation workflow state.');
      }
    }
    pursuitId = String(existingPursuit.id);
  } else {
    const inserted = await client.from('organisation_opportunities').insert(desiredPursuit).select('id').single();
    const data = await assertResult(inserted, 'Could not insert organisation pursuit');
    pursuitId = String(data.id);
  }
  return { observationId, canonicalId, linkId, pursuitId };
}

async function migrateChangesForUpdate(
  client: any,
  updateRow: LegacyRow,
  changeRows: LegacyRow[],
  observationId: string,
  runId: string,
  organisationId: string,
) {
  const related = changeRows.filter(row => isObject(row.record) && row.record.opportunityUpdateId === updateRow.id);
  if (!related.length) return { migrated: 0, quarantined: 0, versions: 0 };
  const reconstructed = reconstructHistorySnapshots(updateRow.record, related.map(row => ({ id: row.id, record: row.record })));
  if (!reconstructed.ok) {
    for (const row of related) {
      await writeLedger(client, {
        collection: 'opportunity_changes', recordId: row.id, runId,
        organisationId, status: 'quarantined',
        targetIds: { observation_id: observationId },
        findings: [{ recordId: row.id, collection: row.table_name, code: 'history_not_reconstructable', message: reconstructed.reason }],
      });
    }
    return { migrated: 0, quarantined: related.length, versions: 0 };
  }

  const existingResult = await client.from('procurement_observation_versions')
    .select('id,version_no,content_hash').eq('observation_id', observationId);
  const existing = await assertResult(existingResult, 'Could not inspect existing observation versions') || [];
  const existingVersionIds = new Map<string, string>(existing.map((row: any) => [String(row.content_hash), String(row.id)]));
  let nextVersion = existing.reduce((max: number, row: any) => Math.max(max, Number(row.version_no) || 0), 0) + 1;
  let insertedCount = 0;
  const idsByChange = new Map<string, string>();

  for (const snapshot of reconstructed.snapshots) {
    let versionId = existingVersionIds.get(snapshot.hash);
    if (!versionId) {
      versionId = deterministicUuid('observation-version:' + observationId + ':' + snapshot.hash);
      const insert = await client.from('procurement_observation_versions').insert({
        id: versionId,
        observation_id: observationId,
        source_run_id: null,
        version_no: nextVersion,
        content_hash: snapshot.hash,
        snapshot: snapshot.snapshot,
        observed_at: snapshot.observedAt,
      }).select('id').single();
      const data = await assertResult(insert, 'Could not append immutable observation version');
      versionId = data.id;
      existingVersionIds.set(snapshot.hash, String(versionId));
      nextVersion += 1;
      insertedCount += 1;
    }
    if (versionId) idsByChange.set(snapshot.legacyChangeId, String(versionId));
  }

  for (const row of related) {
    await writeLedger(client, {
      collection: 'opportunity_changes', recordId: row.id, runId,
      organisationId, status: 'migrated',
      targetIds: { observation_id: observationId, ...(idsByChange.get(row.id) ? { version_id: idsByChange.get(row.id)! } : {}) },
    });
  }
  return { migrated: related.length, quarantined: 0, versions: insertedCount };
}


export async function runPhase2BBackfill(client: any, options: { runId?: string; generatedAt?: string } = {}) {
  const clientUrl = typeof client?.supabaseUrl === 'string' ? client.supabaseUrl : '';
  if (!clientUrl) throw new Error('Backfill requires a Supabase client with an inspectable endpoint.');
  parseLocalSupabaseUrl(clientUrl);
  const legacy = await loadLegacy(client);
  const allRows = [...legacy.updates, ...legacy.changes, ...legacy.runs, ...legacy.tenders];
  const dryRun = buildPhase2BDryRunReport({ organisationId: legacy.organisationId, rows: allRows, generatedAt: options.generatedAt });
  const findings = dryRun.validation.findings as Finding[];
  const blockedUpdates = new Map<string, Finding[]>();
  const blockedRuns = new Map<string, Finding[]>();
  for (const finding of findings) {
    const set = finding.collection === 'opportunity_updates' && UPDATE_BLOCKING.has(finding.code) ? blockedUpdates
      : finding.collection === 'opportunity_source_runs' && RUN_BLOCKING.has(finding.code) ? blockedRuns : null;
    if (set) set.set(finding.recordId, [...(set.get(finding.recordId) || []), finding]);
  }

  const runId = options.runId || randomUUID();
  if (!UUID.test(runId)) throw new Error('PHASE2B_RUN_ID must be a valid UUID.');
  await ensureRun(client, runId, legacy.organisationId);
  const summary = {
    runId,
    organisationId: legacy.organisationId,
    generatedAt: options.generatedAt || new Date().toISOString(),
    baseline: {
      opportunity_updates: legacy.updates.length,
      opportunity_changes: legacy.changes.length,
      opportunity_source_runs: legacy.runs.length,
      tenders: legacy.tenders.filter(row => row.scope_type === 'organisation' && row.organisation_id === legacy.organisationId).length,
    },
    migrated: { opportunity_updates: 0, opportunity_changes: 0, opportunity_source_runs: 0, observations: 0, pursuits: 0, versions: 0 },
    quarantined: { opportunity_updates: 0, opportunity_changes: 0, opportunity_source_runs: 0 },
    skippedPreviouslyMigrated: { opportunity_updates: 0, opportunity_changes: 0, opportunity_source_runs: 0 },
  };

  try {
    const sourceIds = await mapSourceRegistry(client);
    const migratedUpdates = await loadMigratedIds(client, 'opportunity_updates');
    const migratedRuns = await loadMigratedIds(client, 'opportunity_source_runs');
    const migratedChanges = await loadMigratedIds(client, 'opportunity_changes');
    const observationByLegacyId = new Map<string, string>();

    for (const row of legacy.updates) {
      if (migratedUpdates.has(row.id)) { summary.skippedPreviouslyMigrated.opportunity_updates += 1; continue; }
      const invalid = blockedUpdates.get(row.id) || [];
      if (invalid.length) {
        await writeLedger(client, { collection: 'opportunity_updates', recordId: row.id, runId, organisationId: legacy.organisationId, status: 'quarantined', findings: invalid });
        summary.quarantined.opportunity_updates += 1;
        continue;
      }
      try {
        const ids = await migrateUpdate(client, row, legacy.organisationId, sourceIds, legacy.tenders);
        observationByLegacyId.set(row.id, ids.observationId);
        await writeLedger(client, { collection: 'opportunity_updates', recordId: row.id, runId, organisationId: legacy.organisationId, status: 'migrated', targetIds: {
          observation_id: ids.observationId, canonical_opportunity_id: ids.canonicalId, canonical_source_link_id: ids.linkId,
          organisation_opportunity_id: ids.pursuitId,
        } });
        summary.migrated.opportunity_updates += 1;
        summary.migrated.observations += 1;
        summary.migrated.pursuits += 1;
      } catch (error) {
        const sourceId = sourceIds.get(String(row.record.sourceId));
        const partialTargets = sourceId ? await inspectPartialUpdateTargets(client, row, legacy.organisationId, sourceId) : {};
        await writeLedger(client, { collection: 'opportunity_updates', recordId: row.id, runId, organisationId: legacy.organisationId,
          status: 'quarantined', targetIds: partialTargets, findings: [{ recordId: row.id, collection: row.table_name, code: 'target_write_failed',
            message: error instanceof Error ? error.message : String(error) }] });
        summary.quarantined.opportunity_updates += 1;
      }
    }

    // Rebuild the legacy-ID → observation-ID map from the durable ledger so a resumed
    // process can continue with history even when the update was committed previously.
    const ledgerResult = await client.from('legacy_opportunity_backfill_records')
      .select('legacy_record_id,target_ids,status').eq('legacy_collection', 'opportunity_updates').eq('status', 'migrated');
    const ledgerRows = await assertResult(ledgerResult, 'Could not reload migrated update checkpoints') || [];
    for (const row of ledgerRows) if (row.target_ids?.observation_id) observationByLegacyId.set(row.legacy_record_id, row.target_ids.observation_id);

    for (const row of legacy.runs) {
      if (migratedRuns.has(row.id)) { summary.skippedPreviouslyMigrated.opportunity_source_runs += 1; continue; }
      const invalid = blockedRuns.get(row.id) || [];
      if (invalid.length) {
        await writeLedger(client, { collection: 'opportunity_source_runs', recordId: row.id, runId, organisationId: legacy.organisationId, status: 'quarantined', findings: invalid });
        summary.quarantined.opportunity_source_runs += 1;
        continue;
      }
      try {
        const sourceId = sourceIds.get(String(row.record.sourceId));
        if (!sourceId) throw new Error('Validated source key was not present in source registry.');
        const payload = sourceRunPayload(row, sourceId);
        const existingResult = await client.from('procurement_source_runs').select('*').eq('id', payload.id).maybeSingle();
        const existing = await assertResult(existingResult, 'Could not inspect source run');
        let targetRunId: string;
        if (existing) {
          for (const [field, value] of Object.entries(payload)) {
            if (!sameField(field, existing[field], value)) {
              throw new Error('Existing source run differs from deterministic legacy mapping; refusing to overwrite it.');
            }
          }
          targetRunId = String(existing.id);
        } else {
          const inserted = await client.from('procurement_source_runs').insert(payload).select('id').single();
          const data = await assertResult(inserted, 'Could not insert source run');
          targetRunId = String(data.id);
        }
        await writeLedger(client, { collection: 'opportunity_source_runs', recordId: row.id, runId, organisationId: legacy.organisationId,
          status: 'migrated', targetIds: { source_run_id: targetRunId } });
        summary.migrated.opportunity_source_runs += 1;
      } catch (error) {
        const partialRunId = deterministicUuid('opportunity_source_runs:' + row.id);
        const partialResult = await client.from('procurement_source_runs').select('id').eq('id', partialRunId).maybeSingle();
        await writeLedger(client, { collection: 'opportunity_source_runs', recordId: row.id, runId, organisationId: legacy.organisationId,
          status: 'quarantined', targetIds: partialResult.data?.id ? { source_run_id: String(partialResult.data.id) } : {},
          findings: [{ recordId: row.id, collection: row.table_name, code: 'target_write_failed',
            message: error instanceof Error ? error.message : String(error) }] });
        summary.quarantined.opportunity_source_runs += 1;
      }
    }

    for (const row of legacy.changes) {
      if (migratedChanges.has(row.id)) { summary.skippedPreviouslyMigrated.opportunity_changes += 1; continue; }
      const updateId = isObject(row.record) ? String(row.record.opportunityUpdateId || '') : '';
      const observationId = observationByLegacyId.get(updateId);
      if (!observationId) {
        const reason = 'Parent opportunity update was not migrated; history cannot be attached.';
        await writeLedger(client, { collection: 'opportunity_changes', recordId: row.id, runId, organisationId: legacy.organisationId,
          status: 'quarantined', findings: [{ recordId: row.id, collection: row.table_name, code: 'history_parent_unavailable', message: reason }] });
        summary.quarantined.opportunity_changes += 1;
      }
    }

    // History is processed per parent to validate the complete transition chain before
    // writing any immutable versions for that parent.
    for (const updateRow of legacy.updates) {
      const observationId = observationByLegacyId.get(updateRow.id);
      if (!observationId) continue;
      const related = legacy.changes.filter(row => isObject(row.record) && row.record.opportunityUpdateId === updateRow.id);
      if (!related.length) continue;
      const pending = related.filter(row => !migratedChanges.has(row.id));
      if (!pending.length) continue;
      const history = await migrateChangesForUpdate(client, updateRow, related, observationId, runId, legacy.organisationId);
      summary.migrated.opportunity_changes += history.migrated;
      summary.quarantined.opportunity_changes += history.quarantined;
      summary.migrated.versions += history.versions;
    }

    const ledgerCounts = await client.from('legacy_opportunity_backfill_records')
      .select('legacy_collection,status,legacy_record_id,findings').eq('organisation_id', legacy.organisationId);
    const ledger = await assertResult(ledgerCounts, 'Could not reconcile run ledger') || [];
    const ledgerByCollection = Object.fromEntries(['opportunity_updates', 'opportunity_changes', 'opportunity_source_runs'].map(collection => [
      collection,
      countByStatus(ledger.filter((row: any) => row.legacy_collection === collection)),
    ]));
    const findingsByCode: Record<string, number> = {};
    const quarantineRecords = ledger.filter((row: any) => row.status === 'quarantined');
    for (const record of quarantineRecords) {
      for (const finding of Array.isArray(record.findings) ? record.findings : []) {
        const code = String(finding.code || 'unknown');
        findingsByCode[code] = (findingsByCode[code] || 0) + 1;
      }
    }
    const runSummary = {
      ...summary,
      ledger: {
        records: ledger.length,
        byCollection: ledgerByCollection,
        findingsByCode,
        quarantinedLegacyRecordIds: quarantineRecords.map((row: any) => ({
          collection: row.legacy_collection,
          recordId: row.legacy_record_id,
        })),
      },
      reconciliation: {
        updateRowsAccountedFor: ledger.filter((row: any) => row.legacy_collection === 'opportunity_updates').length,
        sourceRunRowsAccountedFor: ledger.filter((row: any) => row.legacy_collection === 'opportunity_source_runs').length,
        changeRowsAccountedFor: ledger.filter((row: any) => row.legacy_collection === 'opportunity_changes').length,
        updateRowsUnaccountedFor: Math.max(0, legacy.updates.length - ledger.filter((row: any) => row.legacy_collection === 'opportunity_updates').length),
        sourceRunRowsUnaccountedFor: Math.max(0, legacy.runs.length - ledger.filter((row: any) => row.legacy_collection === 'opportunity_source_runs').length),
        changeRowsUnaccountedFor: Math.max(0, legacy.changes.length - ledger.filter((row: any) => row.legacy_collection === 'opportunity_changes').length),
        quarantinesRemain: quarantineRecords.length > 0,
        productionTouched: false,
      },
    };
    const finish = await client.from('legacy_opportunity_backfill_runs').update({
      status: 'completed', completed_at: new Date().toISOString(), summary: runSummary,
    }).eq('id', runId);
    await assertResult(finish, 'Could not complete backfill run');
    return runSummary;
  } catch (error) {
    await client.from('legacy_opportunity_backfill_runs').update({
      status: 'failed', summary: { ...summary, failure: error instanceof Error ? error.message : String(error) },
    }).eq('id', runId);
    throw error;
  }
}

async function main() {
  if (process.env.PHASE2B_BACKFILL !== '1') throw new Error('Refusing to run: set PHASE2B_BACKFILL=1 explicitly.');
  if (process.env.PHASE2B_BACKFILL_CONFIRM !== 'REVIEWED_LOCAL_DRY_RUN') {
    throw new Error('Refusing to write: set PHASE2B_BACKFILL_CONFIRM=REVIEWED_LOCAL_DRY_RUN only after reviewing the local dry-run report.');
  }
  const urlValue = process.env.LOCAL_SUPABASE_URL || '';
  const key = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY || '';
  if (!urlValue || !key) throw new Error('Set LOCAL_SUPABASE_URL and LOCAL_SUPABASE_SERVICE_ROLE_KEY for the local Supabase stack.');
  const url = parseLocalSupabaseUrl(urlValue);
  const client = createClient(url.toString(), key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const runId = process.env.PHASE2B_RUN_ID || randomUUID();
  process.stdout.write('Phase 2B backfill run ID: ' + runId + String.fromCharCode(10));
  const summary = await runPhase2BBackfill(client, { runId });
  const outputPath = resolve(process.env.PHASE2B_BACKFILL_REPORT_PATH || 'artifacts/phase-2b-backfill-report.json');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  });
}
