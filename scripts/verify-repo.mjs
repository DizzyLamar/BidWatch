import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const failures = [];

const tests = JSON.parse(read('tests/tests.json'));
if (!Array.isArray(tests) || tests.length < 3 || tests.length > 5) failures.push('tests/tests.json must contain 3-5 tests.');
if (tests.filter(test => test.sanity === true).length !== 1) failures.push('Exactly one sanity QA test must have sanity: true.');
for (const test of tests) {
  if (!test.name || !test.viewport || !Array.isArray(test.covers) || !test.covers.length || !test.description || !Array.isArray(test.steps) || !test.steps.length || !test.expected) failures.push(`Invalid test definition: ${test.name || '<unnamed>'}`);
}

const frontend = read('src/App.tsx');
const platform = read('src/platform.ts');
const backend = read('backend/index.ts');
const css = read('src/index.css');
const tenancy = read('backend/tenancy.ts');
const runtime = read('backend/runtime.ts');
const scopedRecords = read('backend/scoped-records.ts');
const uiCss = read('src/ui-system.css');

for (const [pattern, description] of [
  ['dangerouslySetInnerHTML', 'raw HTML rendering'],
  ['innerHTML', 'direct DOM HTML injection'],
  ['javascript:', 'javascript URL'],
]) {
  if (frontend.includes(pattern)) failures.push(`Frontend security regression: ${description} detected.`);
}

for (const [pattern, description] of [
  ["requirePermission('bids.delete')", 'server-side delete authorization'],
  ["requirePermission('bids.apply')", 'server-side Applied authorization'],
  ["requirePermission('bids.decline')", 'server-side Declined authorization'],
  ["'PUT /api/tenders/:id': [requireAuth()", 'server-side ordinary bid edit authentication'],
  ["u.permissions.includes('bids.edit')", 'server-side ordinary bid edit authorization'],
  ["u.permissions.includes('bids.assign')", 'server-side assignment authorization'],
  ["timingSafeEqual(expectedBytes, suppliedBytes)", 'constant-time cron secret comparison'],
  ["'POST /api/internal/reminders'", 'scheduled reminder endpoint'],
  ["'POST /api/internal/opportunity-scan'", 'scheduled opportunity scan endpoint'],
  ['storageService.delete', 'managed storage deletion'],
]) {
  if (!backend.includes(pattern)) failures.push(`Backend security/lifecycle regression: ${description} missing.`);
}

for (const [pattern, description] of [
  ['GLOBAL_COLLECTIONS', 'explicit global collection allowlist'],
  ['ORGANISATION_COLLECTIONS', 'explicit organisation collection allowlist'],
  ["eq('scope_type', 'global')", 'global scope filtering'],
  ["eq('scope_type', 'organisation')", 'organisation scope filtering'],
  ["eq('organisation_id', organisationId)", 'organisation ID filtering'],
  ["eq('user_id', ctx.user.userId)", 'membership identity verification'],
  ["eq('status', 'active')", 'active membership verification'],
  ["from('platform_admins')", 'database-backed platform administrator lookup'],
  ['ctx.organisation =', 'verified organisation request context'],
  ['new Set(ids).size !== ids.length', 'duplicate-ID rejection for scoped batch mutations'],
  ['Scoped update rejected:', 'complete target-set validation before scoped updates'],
  ['Scoped delete rejected:', 'complete target-set validation before scoped deletes'],
]) {
  if (!tenancy.includes(pattern)) failures.push(`Tenant isolation regression: ${description} missing.`);
}
if (!runtime.includes('organisation?:')) failures.push('Router context is missing the verified organisation context.');
if (!runtime.includes('AsyncLocalStorage')) failures.push('Database access is not bound to an isolated request context.');
if (!runtime.includes('A verified database scope is required')) failures.push('Unscoped app-record access is not rejected.');
if (!runtime.includes("eq('scope_type', 'global').is('organisation_id', null)")) failures.push('Global records are not explicitly filtered.');
if (!runtime.includes('scope_type: GLOBAL_COLLECTIONS.has(table) ? \'global\' : \'organisation\'')) failures.push('New app records are not assigned an explicit scope.');

const routeLines = backend.split('\n').filter(line => /^\s*['"](GET|POST|PUT|DELETE) /.test(line));
for (const line of routeLines) {
  if (line.includes('requireAuth()') && !line.includes('requireOrganisation()') && !line.includes("'GET /api/organisations'")) {
    failures.push('An authenticated API route is missing organisation membership middleware.');
  }
  if (line.includes('/api/internal/') && !line.includes('requireLegacyOrganisation()')) {
    failures.push('An internal scheduled route is missing its explicit legacy workspace scope.');
  }
}
if (!backend.includes('listCurrentOrganisationMembers(ctx)')) failures.push('Organisation member administration is not membership-scoped.');
if (!backend.includes('listCurrentOrganisationRoles(ctx)')) failures.push('Organisation role reads are not relational and tenant-scoped.');
if (!backend.includes('activeOrganisationProfileIds(ctx)')) failures.push('Tender assignments are not restricted to active organisation members.');
if (!backend.includes('requireLegacyOrganisation()')) failures.push('Scheduled jobs do not have an explicit tenant execution scope.');
if (!backend.includes("eq('status', 'active')")) failures.push('Scheduled reminders do not verify active organisation memberships.');
if (!backend.includes("Member invitations are temporarily unavailable")) failures.push('Legacy global identity provisioning has not been disabled during the membership cutover.');
if (!backend.includes("from('organisation_roles')")) failures.push('Organisation role management is not backed by relational roles.');
if (!backend.includes('Only a platform administrator can allocate sensitive permissions.')) failures.push('Sensitive role permissions are not protected by platform-admin authorization.');
if (!backend.includes("This role is assigned to organisation members.")) failures.push('Assigned organisation roles are not protected from deletion.');
if (!backend.includes("'GET /api/organisations': [requireAuth()")) failures.push('Authenticated organisation discovery is missing.');
if (!platform.includes("'X-Organisation-Id'")) failures.push('The API client does not send the explicitly selected organisation context.');
if (!platform.includes('setOrganisationId(id: string | null)')) failures.push('The API client cannot persist an explicit organisation selection.');
if (!backend.includes('organisations/\u0024{ctx.organisation!.id}/tenders/')) failures.push('New attachment uploads are not organisation-prefixed.');
if (!backend.includes("eq('status', 'active')")) failures.push('Reminder delivery does not filter active organisation memberships.');

if (!uiCss.includes('.modal-backdrop')) failures.push('Confirmation modal styling is missing from the UI system.');
if (!css.includes('.form-error')) failures.push('Inline production error styling is missing.');

if (failures.length) {
  console.error('BidWatch repository verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`BidWatch repository verification passed: ${tests.length} QA scenarios and required security/UX guardrails are present.`);
