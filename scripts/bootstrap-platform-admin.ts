import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const CONFIRMATION = 'I_UNDERSTAND_THIS_GRANTS_PLATFORM_ADMIN';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER_PERMISSIONS = [
  'bids.view', 'bids.create', 'bids.edit', 'bids.assign', 'bids.apply', 'bids.decline', 'bids.delete',
  'attachments.upload', 'attachments.delete', 'notifications.view',
  'users.view', 'users.manage', 'roles.view', 'roles.manage', 'categories.manage', 'settings.manage',
  'audit.view', 'kpis.view.overview', 'kpis.view.pipeline', 'kpis.view.deadlines',
  'kpis.view.submissions', 'kpis.view.workload', 'kpis.view.team', 'kpis.view.access', 'kpis.view.storage',
];

export function validateBootstrapEnvironment(env: NodeJS.ProcessEnv) {
  if (env.BIDWATCH_BOOTSTRAP_CONFIRM !== CONFIRMATION) {
    throw new Error(`Set BIDWATCH_BOOTSTRAP_CONFIRM=${CONFIRMATION} to acknowledge this privileged operation.`);
  }
  const rawUrl = env.SUPABASE_URL;
  const secretKey = env.SUPABASE_SECRET_KEY;
  const userId = env.BIDWATCH_BOOTSTRAP_USER_ID?.trim();
  if (!rawUrl || !secretKey || !userId) {
    throw new Error('SUPABASE_URL, SUPABASE_SECRET_KEY and BIDWATCH_BOOTSTRAP_USER_ID are required.');
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('SUPABASE_URL must be a valid URL.');
  }
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error('First-owner bootstrap is restricted to a localhost Supabase URL. Remote projects are refused.');
  }
  if (!UUID_PATTERN.test(userId)) {
    throw new Error('BIDWATCH_BOOTSTRAP_USER_ID must be an exact Auth user UUID.');
  }
  return { url: url.toString(), secretKey, userId };
}

export async function bootstrapFirstPlatformAdmin(admin: any, userId: string) {
  if (!UUID_PATTERN.test(userId)) throw new Error('A valid Auth user UUID is required.');

  const { data: authResult, error: authError } = await admin.auth.admin.getUserById(userId);
  if (authError) throw new Error(`Could not verify the Auth identity: ${authError.message}`);
  const authUser = authResult?.user;
  if (!authUser || authUser.id !== userId) throw new Error('The specified Auth identity does not exist.');
  const email = String(authUser.email || '').trim().toLowerCase();
  if (!email || !(authUser.email_confirmed_at || authUser.confirmed_at)) {
    throw new Error('The first platform owner must have a verified email address.');
  }

  const { data: organisation, error: organisationError } = await admin
    .from('organisations').select('id,name').eq('slug', 'legacy-bidwatch-workspace').maybeSingle();
  if (organisationError) throw new Error(`Could not inspect the initial workspace: ${organisationError.message}`);
  if (!organisation) throw new Error('The initial legacy-bidwatch-workspace is missing. Apply the Phase 1 foundation migration first.');

  const { data: ownerRole, error: roleError } = await admin
    .from('organisation_roles')
    .upsert({
      organisation_id: organisation.id,
      key: 'owner',
      name: 'Owner',
      description: 'Full administrative access within this organisation.',
      permissions: OWNER_PERMISSIONS,
      is_system: true,
    }, { onConflict: 'organisation_id,key' })
    .select('id').single();
  if (roleError || !ownerRole?.id) throw new Error(roleError?.message || 'Could not provision the initial owner role.');

  const { data: existingProfiles, error: profileLookupError } = await admin
    .from('app_records').select('id,record')
    .eq('table_name', 'users').contains('record', { userId }).limit(2);
  if (profileLookupError) throw new Error(`Could not inspect the global user profile: ${profileLookupError.message}`);
  if ((existingProfiles || []).length > 1) throw new Error('Multiple global user profiles match this Auth identity; resolve the duplicate before bootstrapping.');
  const existingProfile = existingProfiles?.[0];
  if (existingProfile) {
    const profileEmail = String(existingProfile.record?.email || '').trim().toLowerCase();
    if (profileEmail !== email) throw new Error('The existing BidWatch profile email does not match the verified Auth identity.');
  } else {
    const displayName = String(authUser.user_metadata?.full_name || authUser.user_metadata?.name || email.split('@')[0]);
    const timestamp = new Date().toISOString();
    const { error: profileInsertError } = await admin.from('app_records').insert({
      table_name: 'users',
      record: {
        userId, email, name: displayName, roleId: ownerRole.id,
        active: true, status: 'Active', createdAt: timestamp, updatedAt: timestamp,
        onboardingCompleted: false,
      },
      scope_type: 'global',
      organisation_id: null,
    });
    if (profileInsertError) throw new Error(`Could not create the global user profile: ${profileInsertError.message}`);
  }

  const { error: membershipError } = await admin.from('organisation_members').upsert({
    organisation_id: organisation.id,
    user_id: userId,
    role_id: ownerRole.id,
    status: 'active',
    joined_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'organisation_id,user_id' });
  if (membershipError) throw new Error(`Could not provision the initial owner membership: ${membershipError.message}`);

  const { error: adminError } = await admin.from('platform_admins')
    .upsert({ user_id: userId, created_by: userId }, { onConflict: 'user_id', ignoreDuplicates: true });
  if (adminError) throw new Error(`Could not provision platform administrator: ${adminError.message}`);

  const [{ data: verifiedMembership, error: verifyMembershipError }, { data: verifiedAdmin, error: verifyAdminError }] = await Promise.all([
    admin.from('organisation_members').select('user_id,role_id,status')
      .eq('organisation_id', organisation.id).eq('user_id', userId).maybeSingle(),
    admin.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle(),
  ]);
  if (verifyMembershipError || verifyAdminError) {
    throw new Error(verifyMembershipError?.message || verifyAdminError?.message || 'Could not verify first-owner provisioning.');
  }
  if (verifiedMembership?.status !== 'active' || verifiedMembership?.role_id !== ownerRole.id || verifiedAdmin?.user_id !== userId) {
    throw new Error('First-owner provisioning did not pass its final verification.');
  }
  return { userId, organisationId: organisation.id, ownerRoleId: ownerRole.id, alreadyProvisioned: Boolean(existingProfile) };
}

async function main() {
  const config = validateBootstrapEnvironment(process.env);
  const admin = createClient(config.url, config.secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const result = await bootstrapFirstPlatformAdmin(admin, config.userId);
  console.log(`Verified first platform owner ${result.userId} in workspace ${result.organisationId}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Bootstrap failed.');
    process.exitCode = 1;
  });
}
