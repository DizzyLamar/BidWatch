export type DatabaseScope =
  | { kind: 'global' }
  | { kind: 'organisation'; organisationId: string; legacyStorage?: boolean };

type RecordRow = { id: string; table_name: string; record: Record<string, unknown> };

const GLOBAL_COLLECTIONS = new Set(['users', 'opportunity_source_runs']);
const ORGANISATION_COLLECTIONS = new Set([
  'activity', 'attachments', 'bid_history', 'bid_requirements', 'bid_tasks',
  'categories', 'notifications', 'opportunity_changes', 'opportunity_updates',
  'opportunity_watchlists', 'roles', 'security_activity', 'tenders',
]);

function cleanScopedRecord(record: Record<string, unknown>) {
  const { id: _id, scope_type: _scope, organisation_id: _organisation, ...payload } = record;
  return payload;
}

/**
 * Build the app_records repository around a Supabase-compatible client.
 * getScope is request-local (AsyncLocalStorage in production), not a mutable
 * process-wide tenant setting. The injectable boundary also lets tests execute
 * the exact repository logic against an isolated in-memory PostgREST double.
 */
export function createScopedRecordRepository(
  supabase: any,
  getScope: () => DatabaseScope | null,
) {
  function client() {
    if (!supabase) throw new Error('Supabase is not configured.');
    return supabase;
  }

  function applyDatabaseScope(table: string, query: any) {
    const scope = getScope();
    if (!scope) throw new Error('A verified database scope is required for every record operation.');
    if (GLOBAL_COLLECTIONS.has(table)) {
      return query.eq('scope_type', 'global').is('organisation_id', null);
    }
    if (ORGANISATION_COLLECTIONS.has(table)) {
      if (scope.kind !== 'organisation') {
        throw new Error(`An organisation context is required to access ${table}.`);
      }
      return query.eq('scope_type', 'organisation').eq('organisation_id', scope.organisationId);
    }
    throw new Error(`Collection "${table}" is not registered for scoped access.`);
  }

  async function checked<T>(
    pending: PromiseLike<{ data: T | null; error: { message: string } | null }> |
      { data: T | null; error: { message: string } | null },
  ) {
    // Supabase query builders are PromiseLike. Await them here rather than
    // reading their data/error fields before the request has executed.
    const result = await pending;
    if (result.error) throw new Error(result.error.message);
    return result.data as T;
  }

  return {
    async list<T>(table: string, options: { limit?: number } = {}) {
      const query = client().from('app_records').select('id,table_name,record')
        .eq('table_name', table).order('created_at', { ascending: false })
        .limit(Math.min(options.limit ?? 500, 5000));
      const rows = await checked<RecordRow[]>(applyDatabaseScope(table, query));
      return { items: rows.map(row => ({ ...(row.record as T), id: row.id })) };
    },

    async get<T>(table: string, ids: string[]) {
      if (!ids.length) return [];
      const query = client().from('app_records').select('id,record')
        .eq('table_name', table).in('id', ids);
      const rows = await checked<Array<{ id: string; record: T }>>(applyDatabaseScope(table, query));
      return rows.map(row => ({ ...(row.record as T), id: row.id }));
    },

    async add(table: string, records: Record<string, unknown>[]) {
      if (!records.length) return [];
      const scope = getScope();
      if (!scope) throw new Error('A verified database scope is required for every record operation.');
      // Validate collection and scope before constructing the insert payload.
      applyDatabaseScope(table, client().from('app_records').select('id'));
      if (ORGANISATION_COLLECTIONS.has(table) && scope.kind !== 'organisation') {
        throw new Error(`An organisation context is required to insert ${table}.`);
      }
      const rows = records.map(record => ({
        ...(typeof record.id === 'string' ? { id: record.id } : {}),
        table_name: table,
        record: cleanScopedRecord(record),
        scope_type: GLOBAL_COLLECTIONS.has(table) ? 'global' : 'organisation',
        organisation_id: GLOBAL_COLLECTIONS.has(table) ? null : scope.kind === 'organisation' ? scope.organisationId : null,
      }));
      const inserted = await checked<Array<{ id: string }>>(
        client().from('app_records').insert(rows).select('id'),
      );
      return inserted.map(row => row.id);
    },

    async update(table: string, updates: Array<{ id: string; record: object }>) {
      if (!updates.length) return;
      const ids = updates.map(item => item.id);
      if (new Set(ids).size !== ids.length) {
        throw new Error('A scoped update cannot contain duplicate record IDs.');
      }
      const lookup = client().from('app_records').select('id')
        .eq('table_name', table).in('id', ids);
      const visible = await checked<Array<{ id: string }>>(applyDatabaseScope(table, lookup));
      const visibleIds = new Set(visible.map(row => row.id));
      if (ids.some(id => !visibleIds.has(id))) {
        throw new Error(`Scoped update rejected: one or more ${table} records are unavailable in this scope.`);
      }
      for (const update of updates) {
        const query = client().from('app_records')
          .update({
            record: cleanScopedRecord(update.record as Record<string, unknown>),
            updated_at: new Date().toISOString(),
          })
          .eq('table_name', table).eq('id', update.id).select('id');
        const result = await checked<Array<{ id: string }>>(applyDatabaseScope(table, query));
        if (!result.length) throw new Error(`Scoped update found no ${table} record with ID ${update.id}.`);
      }
    },

    async delete(table: string, ids: string[]) {
      if (!ids.length) return;
      if (new Set(ids).size !== ids.length) {
        throw new Error('A scoped delete cannot contain duplicate record IDs.');
      }
      const lookup = client().from('app_records').select('id')
        .eq('table_name', table).in('id', ids);
      const visible = await checked<Array<{ id: string }>>(applyDatabaseScope(table, lookup));
      if (visible.length !== ids.length) {
        throw new Error(`Scoped delete rejected: one or more ${table} records are unavailable in this scope.`);
      }
      const query = client().from('app_records').delete()
        .eq('table_name', table).in('id', ids).select('id');
      const deleted = await checked<Array<{ id: string }>>(applyDatabaseScope(table, query));
      if (deleted.length !== ids.length) {
        throw new Error(`Scoped delete did not match every requested ${table} record.`);
      }
    },
  };
}

export function assertOrganisationStoragePath(
  path: string,
  scope: DatabaseScope | null,
  allowLegacy = true,
) {
  if (!scope || scope.kind !== 'organisation') {
    throw new Error('An organisation context is required for storage access.');
  }
  const segments = path.split('/');
  if (!path || path.startsWith('/') || path.includes('\\') ||
      segments.some((part, index) => part === '..' || part === '.' || (part === '' && index < segments.length - 1))) {
    throw new Error('The storage path is invalid.');
  }
  const organisationPrefix = `organisations/${scope.organisationId}/`;
  const legacyPrefixAllowed = allowLegacy && scope.legacyStorage === true && path.startsWith('tenders/');
  if (!path.startsWith(organisationPrefix) && !legacyPrefixAllowed) {
    throw new Error('The storage path is outside the active organisation.');
  }
}
