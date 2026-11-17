import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY;
const bucket = process.env.BIDWATCH_STORAGE_BUCKET || 'bidwatch';
const apply = process.argv.includes('--apply');
const pageSize = 500;

if (!supabaseUrl || !serviceKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required.');
}

const admin = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

type AttachmentRecord = {
  tenderId?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  path?: string;
  legacyPath?: string;
  legacyMigratedAt?: string;
};

function digest(value: Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 140) || 'attachment';
}

async function listAllLegacyAttachments(organisationId: string) {
  const rows: Array<{ id: string; record: AttachmentRecord }> = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await admin.from('app_records')
      .select('id,record')
      .eq('table_name', 'attachments')
      .eq('scope_type', 'organisation')
      .eq('organisation_id', organisationId)
      .order('created_at', { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []) as Array<{ id: string; record: AttachmentRecord }>);
    if (!data || data.length < pageSize) break;
  }
  return rows.filter(row => typeof row.record.path === 'string' && row.record.path.startsWith('tenders/'));
}

async function main() {
  const { data: organisation, error: organisationError } = await admin.from('organisations')
    .select('id,name,slug,status')
    .eq('slug', 'legacy-bidwatch-workspace')
    .maybeSingle();
  if (organisationError || !organisation) {
    throw organisationError || new Error('Legacy BidWatch workspace was not found.');
  }
  if (organisation.status !== 'active') throw new Error('Legacy workspace is not active.');

  const rows = await listAllLegacyAttachments(organisation.id);
  const plan = rows.map(row => {
    const attachment = row.record;
    const oldPath = attachment.path!;
    const tenderId = String(attachment.tenderId || '');
    const filename = safeFilename(String(attachment.filename || 'attachment'));
    const pathHash = createHash('sha256').update(oldPath).digest('hex').slice(0, 20);
    return {
      metadataId: row.id,
      tenderId,
      filename,
      oldPath,
      newPath: 'organisations/' + organisation.id + '/tenders/' + tenderId + '/legacy-' + pathHash + '-' + filename,
      size: Number(attachment.size || 0),
      alreadyMigrated: Boolean(attachment.legacyPath),
    };
  });

  if (!apply) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      organisationId: organisation.id,
      attachmentsFound: plan.length,
      alreadyMarkedMigrated: plan.filter(item => item.alreadyMigrated).length,
      candidates: plan,
      originalsDeleted: 0,
      instruction: 'Review this report, then rerun with --apply to copy, verify and repoint metadata. Original objects are never deleted by this script.',
    }, null, 2));
    return;
  }

  const outcomes: Array<{ metadataId: string; status: string; oldPath: string; newPath: string; error?: string }> = [];
  for (const item of plan) {
    try {
      if (!item.tenderId) throw new Error('Attachment metadata has no tenderId.');
      const { data: tender, error: tenderError } = await admin.from('app_records')
        .select('id')
        .eq('id', item.tenderId)
        .eq('table_name', 'tenders')
        .eq('scope_type', 'organisation')
        .eq('organisation_id', organisation.id)
        .maybeSingle();
      if (tenderError || !tender) throw tenderError || new Error('Attachment tender is not in the legacy workspace.');

      const { data: originalBlob, error: downloadError } = await admin.storage.from(bucket).download(item.oldPath);
      if (downloadError || !originalBlob) throw downloadError || new Error('Original storage object could not be downloaded.');
      const original = Buffer.from(await originalBlob.arrayBuffer());
      const originalHash = digest(original);

      const upload = await admin.storage.from(bucket).upload(item.newPath, original, {
        contentType: String(rows.find(row => row.id === item.metadataId)?.record.mimeType || 'application/octet-stream'),
        upsert: false,
      });
      if (upload.error) {
        // A previous interrupted run may already have copied the deterministic
        // destination. Reuse it only after verifying its bytes exactly.
        const { data: existingBlob, error: existingError } = await admin.storage.from(bucket).download(item.newPath);
        if (existingError || !existingBlob) throw upload.error;
        const existing = Buffer.from(await existingBlob.arrayBuffer());
        if (digest(existing) !== originalHash) {
          throw new Error('Existing destination object does not match the original; refusing to overwrite it.');
        }
      }

      const { data: verifiedBlob, error: verifyError } = await admin.storage.from(bucket).download(item.newPath);
      if (verifyError || !verifiedBlob) throw verifyError || new Error('Copied object could not be verified.');
      const verified = Buffer.from(await verifiedBlob.arrayBuffer());
      if (verified.length !== original.length || digest(verified) !== originalHash) {
        throw new Error('Copied object failed byte-for-byte verification.');
      }

      const current = rows.find(row => row.id === item.metadataId)!;
      const nextRecord = {
        ...current.record,
        path: item.newPath,
        legacyPath: item.oldPath,
        legacyMigratedAt: new Date().toISOString(),
      };
      const { data: updated, error: updateError } = await admin.from('app_records')
        .update({ record: nextRecord, updated_at: new Date().toISOString() })
        .eq('id', item.metadataId)
        .eq('organisation_id', organisation.id)
        .eq('record->>path', item.oldPath)
        .select('id')
        .maybeSingle();
      if (updateError || !updated) {
        throw updateError || new Error('Attachment metadata changed during migration; original path remains authoritative.');
      }

      outcomes.push({ metadataId: item.metadataId, status: 'migrated-and-verified', oldPath: item.oldPath, newPath: item.newPath });
    } catch (error) {
      outcomes.push({
        metadataId: item.metadataId,
        status: 'failed',
        oldPath: item.oldPath,
        newPath: item.newPath,
        error: error instanceof Error ? error.message : 'Unknown migration error.',
      });
    }
  }

  const failures = outcomes.filter(item => item.status === 'failed');
  console.log(JSON.stringify({
    mode: 'apply',
    organisationId: organisation.id,
    attachmentsFound: plan.length,
    migratedAndVerified: outcomes.length - failures.length,
    failed: failures.length,
    originalsDeleted: 0,
    outcomes,
    nextStep: 'Keep legacyPath tracked. Verify the application and backups before any separately approved original-object cleanup.',
  }, null, 2));
  if (failures.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
