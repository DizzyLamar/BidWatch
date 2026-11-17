import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const CONFIRMATION = 'I_UNDERSTAND_THIS_GRANTS_PLATFORM_ADMIN';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  if (!authResult?.user || authResult.user.id !== userId) {
    throw new Error('The specified Auth identity does not exist.');
  }

  const { data: existing, error: existingError } = await admin
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (existingError) throw new Error(`Could not inspect platform administrator state: ${existingError.message}`);

  const { error: insertError } = await admin
    .from('platform_admins')
    .upsert({ user_id: userId, created_by: userId }, { onConflict: 'user_id', ignoreDuplicates: true });
  if (insertError) throw new Error(`Could not provision platform administrator: ${insertError.message}`);

  const { data: row, error: readError } = await admin
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (readError) throw new Error(`Could not verify platform administrator: ${readError.message}`);
  if (row?.user_id !== userId) throw new Error('Platform administrator provisioning could not be verified.');
  return { userId, alreadyProvisioned: Boolean(existing) };
}

async function main() {
  const config = validateBootstrapEnvironment(process.env);
  const admin = createClient(config.url, config.secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const { userId } = await bootstrapFirstPlatformAdmin(admin, config.userId);
  console.log(`Verified platform administrator: ${userId}`);
  console.log('No organisation memberships or application records were changed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Bootstrap failed.');
    process.exitCode = 1;
  });
}
