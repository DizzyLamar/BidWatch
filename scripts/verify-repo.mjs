import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const failures = [];

const tests = JSON.parse(read('tests/tests.json'));
if (!Array.isArray(tests) || tests.length < 3 || tests.length > 5) failures.push('tests/tests.json must contain 3-5 tests.');
if (tests.filter(test => test.sanity === true).length !== 1) failures.push('Exactly one AppDeploy QA test must have sanity: true.');
for (const test of tests) {
  if (!test.name || !test.viewport || !Array.isArray(test.covers) || !test.covers.length || !test.description || !Array.isArray(test.steps) || !test.steps.length || !test.expected) failures.push(`Invalid test definition: ${test.name || '<unnamed>'}`);
}

const frontend = read('src/App.tsx');
const backend = read('backend/index.ts');
const css = read('src/index.css');
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
  ['storageService.delete', 'managed storage deletion'],
]) {
  if (!backend.includes(pattern)) failures.push(`Backend security/lifecycle regression: ${description} missing.`);
}

if (!uiCss.includes('.modal-backdrop')) failures.push('Confirmation modal styling is missing from the UI system.');
if (!css.includes('.form-error')) failures.push('Inline production error styling is missing.');

if (failures.length) {
  console.error('BidWatch repository verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`BidWatch repository verification passed: ${tests.length} QA scenarios and required security/UX guardrails are present.`);
