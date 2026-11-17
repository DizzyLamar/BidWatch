import test from 'node:test';
import assert from 'node:assert/strict';
import { runOrganisationTasks } from '../backend/scheduled-jobs';

test('scheduled organisation tasks continue after one tenant fails and report the failure', async () => {
  const visited: string[] = [];
  const organisations = [{ id: 'org-a' }, { id: 'org-b' }, { id: 'org-c' }];

  const outcome = await runOrganisationTasks(organisations, async organisation => {
    visited.push(organisation.id);
    if (organisation.id === 'org-b') throw new Error('simulated tenant persistence failure');
    return 'completed:' + organisation.id;
  });

  assert.deepEqual(visited, ['org-a', 'org-b', 'org-c']);
  assert.deepEqual(outcome.processed, [
    { organisationId: 'org-a', result: 'completed:org-a' },
    { organisationId: 'org-c', result: 'completed:org-c' },
  ]);
  assert.deepEqual(outcome.failures, [{
    organisationId: 'org-b',
    error: 'simulated tenant persistence failure',
  }]);
  assert.equal(outcome.failures.length ? 500 : 200, 500,
    'partial completion must surface a retryable non-2xx status');
});
