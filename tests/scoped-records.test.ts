import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertOrganisationStoragePath,
  createScopedRecordRepository,
  type DatabaseScope,
} from '../backend/scoped-records';

type Row = {
  id: string;
  table_name: string;
  record: Record<string, unknown>;
  scope_type: 'global' | 'organisation';
  organisation_id: string | null;
  created_at: string;
  updated_at?: string;
};

type Result = { data: Array<Record<string, unknown>> | null; error: null };

class MemoryQuery {
  private action: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private filters: Array<(row: Row) => boolean> = [];
  private inserted: Array<Record<string, unknown>> = [];
  private patch: Record<string, unknown> = {};
  private maxRows = Number.POSITIVE_INFINITY;

  constructor(private rows: Row[]) {}

  select(_columns: string) { return this; }
  order(_column: string, _options: unknown) { return this; }
  limit(value: number) { this.maxRows = value; return this; }
  eq(column: string, value: unknown) {
    this.filters.push(row => (row as unknown as Record<string, unknown>)[column] === value);
    return this;
  }
  is(column: string, value: unknown) {
    this.filters.push(row => (row as unknown as Record<string, unknown>)[column] === value);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push(row => values.includes((row as unknown as Record<string, unknown>)[column]));
    return this;
  }
  insert(rows: Array<Record<string, unknown>>) { this.action = 'insert'; this.inserted = rows; return this; }
  update(patch: Record<string, unknown>) { this.action = 'update'; this.patch = patch; return this; }
  delete() { this.action = 'delete'; return this; }

  private execute(): Result {
    if (this.action === 'insert') {
      const inserted = this.inserted.map((value, index) => {
        const row = {
          id: String(value.id || `generated-${this.rows.length + index + 1}`),
          table_name: String(value.table_name),
          record: value.record as Record<string, unknown>,
          scope_type: value.scope_type as Row['scope_type'],
          organisation_id: value.organisation_id as string | null,
          created_at: new Date().toISOString(),
        };
        this.rows.push(row);
        return { id: row.id };
      });
      return { data: inserted, error: null };
    }

    const matches = this.rows.filter(row => this.filters.every(filter => filter(row)));
    if (this.action === 'select') {
      return { data: matches.slice(0, this.maxRows).map(row => ({ ...row, record: { ...row.record } })), error: null };
    }
    if (this.action === 'update') {
      for (const row of matches) Object.assign(row, this.patch);
      return { data: matches.map(row => ({ id: row.id })), error: null };
    }
    const removed = new Set(matches.map(row => row.id));
    this.rows.splice(0, this.rows.length, ...this.rows.filter(row => !removed.has(row.id)));
    return { data: matches.map(row => ({ id: row.id })), error: null };
  }

  then(resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) {
    return Promise.resolve().then(() => this.execute()).then(resolve, reject);
  }
}

function fixture() {
  const rows: Row[] = [
    { id: 'tender-a', table_name: 'tenders', record: { title: 'A confidential bid' }, scope_type: 'organisation', organisation_id: 'org-a', created_at: '2026-01-01' },
    { id: 'tender-b', table_name: 'tenders', record: { title: 'B confidential bid' }, scope_type: 'organisation', organisation_id: 'org-b', created_at: '2026-01-02' },
    { id: 'user-a', table_name: 'users', record: { email: 'a@example.test' }, scope_type: 'global', organisation_id: null, created_at: '2026-01-03' },
  ];
  const client = { from: (_table: string) => new MemoryQuery(rows) };
  let scope: DatabaseScope | null = { kind: 'organisation', organisationId: 'org-a' };
  const repository = createScopedRecordRepository(client, () => scope);
  return { rows, repository, setScope: (next: DatabaseScope | null) => { scope = next; } };
}

test('organisation reads are constrained to the active organisation', async () => {
  const { repository } = fixture();
  const result = await repository.list<{ title: string }>('tenders');
  assert.deepEqual(result.items.map(item => item.id), ['tender-a']);
  assert.deepEqual(await repository.get('tenders', ['tender-b']), []);
});

test('cross-organisation update and delete attempts are rejected without mutation', async () => {
  const { rows, repository } = fixture();

  await assert.rejects(
    repository.update('tenders', [{ id: 'tender-b', record: { title: 'stolen' } }]),
    /Scoped update rejected/,
  );
  await assert.rejects(repository.delete('tenders', ['tender-b']), /Scoped delete rejected/);

  assert.equal(rows.find(row => row.id === 'tender-b')?.record.title, 'B confidential bid');
  assert.ok(rows.some(row => row.id === 'tender-b'));
});

test('mixed-organisation batches fail before changing any in-scope row', async () => {
  const { rows, repository } = fixture();

  await assert.rejects(
    repository.update('tenders', [
      { id: 'tender-a', record: { title: 'partially changed' } },
      { id: 'tender-b', record: { title: 'cross-tenant change' } },
    ]),
    /Scoped update rejected/,
  );
  await assert.rejects(repository.delete('tenders', ['tender-a', 'tender-b']), /Scoped delete rejected/);

  assert.equal(rows.find(row => row.id === 'tender-a')?.record.title, 'A confidential bid');
  assert.equal(rows.find(row => row.id === 'tender-b')?.record.title, 'B confidential bid');
  assert.equal(rows.length, 3);
});

test('tenant inserts stamp the verified tenant and strip caller-supplied scope fields', async () => {
  const { rows, repository } = fixture();
  const [id] = await repository.add('tenders', [{
    title: 'New A bid',
    scope_type: 'global',
    organisation_id: 'org-b',
  }]);

  const inserted = rows.find(row => row.id === id);
  assert.equal(inserted?.scope_type, 'organisation');
  assert.equal(inserted?.organisation_id, 'org-a');
  assert.deepEqual(inserted?.record, { title: 'New A bid' });
});

test('global identity records remain global while tenant collections require a tenant scope', async () => {
  const { repository, setScope } = fixture();
  assert.deepEqual((await repository.list<{ email: string }>('users')).items.map(user => user.id), ['user-a']);

  setScope({ kind: 'global' });
  await assert.rejects(repository.list('tenders'), /organisation context is required/);
  await assert.rejects(repository.add('tenders', [{ title: 'invalid global tender' }]), /organisation context is required/);
});

test('unregistered collections and duplicate mutation IDs are rejected', async () => {
  const { repository } = fixture();
  await assert.rejects(repository.list('unregistered_collection'), /not registered/);
  await assert.rejects(repository.update('tenders', [
    { id: 'tender-a', record: { title: 'one' } },
    { id: 'tender-a', record: { title: 'two' } },
  ]), /duplicate record IDs/);
  await assert.rejects(repository.delete('tenders', ['tender-a', 'tender-a']), /duplicate record IDs/);
});

test('storage paths cannot cross organisations or escape their namespace', () => {
  const orgA: DatabaseScope = { kind: 'organisation', organisationId: 'org-a' };
  const orgB: DatabaseScope = { kind: 'organisation', organisationId: 'org-b' };

  assert.doesNotThrow(() => assertOrganisationStoragePath('organisations/org-a/tenders/123/file.pdf', orgA, false));
  assert.doesNotThrow(() => assertOrganisationStoragePath('organisations/org-a/tenders/', orgA, true));
  assert.throws(() => assertOrganisationStoragePath('organisations/org-b/tenders/123/file.pdf', orgA), /outside the active organisation/);
  assert.throws(() => assertOrganisationStoragePath('organisations/org-a/../org-b/file.pdf', orgA), /path is invalid/);
  assert.throws(() => assertOrganisationStoragePath('/organisations/org-a/file.pdf', orgA), /path is invalid/);
  assert.throws(() => assertOrganisationStoragePath('organisations/org-a\\file.pdf', orgA), /path is invalid/);
  assert.throws(() => assertOrganisationStoragePath('organisations/org-a//file.pdf', orgA), /path is invalid/);
  assert.throws(() => assertOrganisationStoragePath('organisations/org-a/file.pdf', orgB), /outside the active organisation/);
});

test('legacy storage paths are available only to the legacy workspace and never for new uploads', () => {
  const legacy: DatabaseScope = { kind: 'organisation', organisationId: 'legacy-id', legacyStorage: true };
  const ordinary: DatabaseScope = { kind: 'organisation', organisationId: 'org-a', legacyStorage: false };

  assert.doesNotThrow(() => assertOrganisationStoragePath('tenders/old-file.pdf', legacy, true));
  assert.throws(() => assertOrganisationStoragePath('tenders/old-file.pdf', legacy, false), /outside the active organisation/);
  assert.throws(() => assertOrganisationStoragePath('tenders/old-file.pdf', ordinary, true), /outside the active organisation/);
});
