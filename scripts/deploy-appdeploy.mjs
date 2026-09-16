import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const endpoint = process.env.APPDEPLOY_MCP_URL || 'https://api-v2.appdeploy.ai/mcp';
const apiKey = process.env.APPDEPLOY_API_KEY;
const appId = process.env.APPDEPLOY_APP_ID || 'bidwatch-q2u0th';
const sha = process.env.GITHUB_SHA || 'HEAD';
const before = process.env.GITHUB_EVENT_BEFORE;

if (!apiKey) {
  console.error('APPDEPLOY_API_KEY is not configured. Add it as a GitHub Actions secret before enabling production deployment.');
  process.exit(1);
}

const allowed = file => /^(appdeploy\.auth-login\.json|backend\/|cron\.json|index\.html|package\.json|postcss\.config\.js|src\/|tailwind\.config\.js|tests\/tests\.json|tsconfig\.json|vite\.config\.ts)/.test(file);
const diffBase = before && !/^0+$/.test(before) ? before : `${sha}^`;
let changed = [];
try {
  changed = execFileSync('git', ['diff', '--name-only', diffBase, sha], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).filter(allowed);
} catch {
  changed = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).filter(allowed);
}

const deleted = [];
const files = [];
for (const file of changed) {
  if (!fs.existsSync(file)) {
    deleted.push(file);
    continue;
  }
  files.push({ filename: file, content: fs.readFileSync(file, 'utf8') });
}
if (!files.length && !deleted.length) {
  console.log('No AppDeploy application files changed; skipping deployment.');
  process.exit(0);
}

async function rpc(method, args) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: method, arguments: args } }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`AppDeploy HTTP ${response.status}: ${text.slice(0, 500)}`);
  const dataLines = text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean);
  const payload = dataLines.length ? JSON.parse(dataLines.at(-1)) : JSON.parse(text);
  if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
  return payload.result || payload;
}

const deploy = await rpc('deploy_app', {
  app_id: appId,
  app_name: 'BidWatch',
  app_type: 'frontend+backend',
  description: 'Internal bid tracker for an ICT and cybersecurity team.',
  model: 'github-actions',
  intent: 'automated production deployment from main after CI passes',
  initiator: 'user',
  type: 'feature',
  files,
  deletePaths: deleted.length ? deleted : null,
});
console.log(JSON.stringify(deploy, null, 2));

for (let attempt = 0; attempt < 24; attempt += 1) {
  const status = await rpc('get_app_status', { app_id: appId, limit: 50 });
  const deployment = status.deployment || {};
  console.log(`Deployment status: ${deployment.status || 'unknown'}`);
  if (deployment.status === 'ready') {
    if (status.errors?.frontend?.length || status.errors?.backend?.length) throw new Error('AppDeploy reported runtime errors after deployment.');
    console.log(status.message || `BidWatch deployed: ${process.env.APPDEPLOY_APP_URL || 'https://bidwatch-q2u0th.v2.appdeploy.ai/'}`);
    process.exit(0);
  }
  if (deployment.status === 'failed' || deployment.status === 'deleted') throw new Error(status.message || `Deployment ended in ${deployment.status}.`);
  await new Promise(resolve => setTimeout(resolve, 5000));
}
throw new Error('Deployment did not reach a terminal state within the workflow timeout window.');
