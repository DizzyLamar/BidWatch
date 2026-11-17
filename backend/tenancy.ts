import { supabaseAdmin, type RouterContext, error, setDatabaseScope } from './runtime';

const GLOBAL_COLLECTIONS = new Set(['users', 'opportunity_source_runs']);
const ORGANISATION_COLLECTIONS = new Set([
  'activity', 'attachments', 'bid_history', 'bid_requirements', 'bid_tasks',
  'categories', 'notifications', 'opportunity_changes', 'opportunity_updates',
  'opportunity_watchlists', 'roles', 'security_activity', 'tenders',
]);

type Scope = 'global' | 'organisation';
type RecordValue = Record<string, unknown>;
type RecordRow = { id: string; record: RecordValue };

function client() {
  if (!supabaseAdmin) throw new Error('Supabase is not configured.');
  return supabaseAdmin;
}

function assertCollection(scope: Scope, table: string) {
  const allowed = scope === 'global' ? GLOBAL_COLLECTIONS : ORGANISATION_COLLECTIONS;
  if (!allowed.has(table)) {
    throw new Error(`Collection "${table}" is not available through the ${scope} repository.`);
  }
}

function withScope(query: any, scope: Scope, organisationId?: string) {
  if (scope === 'global') return query.eq('scope_type', 'global').is('organisation_id', null);
  if (!organisationId) throw new Error('An organisation ID is required for an organisation repository.');
  return query.eq('scope_type', 'organisation').eq('organisation_id', organisationId);
}

function normaliseRecord<T>(row: RecordRow): T {
  return { ...(row.record as T), id: row.id };
}

function cleanRecord(record: RecordValue) {
  const { id: _id, scope_type: _scope, organisation_id: _organisation, ...payload } = record;
  return payload;
}

function scopedRepository(scope: Scope, organisationId?: string) {
  if (scope === 'organisation' && !organisationId?.trim()) {
    throw new Error('An organisation ID is required for an organisation repository.');
  }

  return {
    async list<T>(table: string, options: { limit?: number } = {}) {
      assertCollection(scope, table);
      const query = client().from('app_records').select('id,record')
        .eq('table_name', table).order('created_at', { ascending: false })
        .limit(Math.min(Math.max(options.limit ?? 500, 1), 5000));
      const result = await withScope(query, scope, organisationId);
      if (result.error) throw new Error(result.error.message);
      return { items: ((result.data || []) as RecordRow[]).map(row => normaliseRecord<T>(row)) };
    },

    async get<T>(table: string, ids: string[]) {
      assertCollection(scope, table);
      if (!ids.length) return [];
      const query = client().from('app_records').select('id,record')
        .eq('table_name', table).in('id', ids);
      const result = await withScope(query, scope, organisationId);
      if (result.error) throw new Error(result.error.message);
      return ((result.data || []) as RecordRow[]).map(row => normaliseRecord<T>(row));
    },

    async add(table: string, records: RecordValue[]) {
      assertCollection(scope, table);
      if (!records.length) return [];
      const rows = records.map(record => ({
        ...(typeof record.id === 'string' ? { id: record.id } : {}),
        table_name: table,
        record: cleanRecord(record),
        scope_type: scope,
        organisation_id: scope === 'organisation' ? organisationId : null,
      }));
      const result = await client().from('app_records').insert(rows).select('id');
      if (result.error) throw new Error(result.error.message);
      return (result.data || []).map((row: { id: string }) => row.id);
    },

    async update(table: string, updates: Array<{ id: string; record: RecordValue }>) {
      assertCollection(scope, table);
      if (!updates.length) return;
      const ids = updates.map(update => update.id);
      if (new Set(ids).size !== ids.length) throw new Error('A scoped update cannot contain duplicate record IDs.');

      // Validate the complete target set before the first write. This prevents a
      // mixed-tenant batch from partially updating records in the caller's tenant
      // before discovering that another requested ID is outside its scope.
      const lookup = client().from('app_records').select('id')
        .eq('table_name', table).in('id', ids);
      const visible = await withScope(lookup, scope, organisationId);
      if (visible.error) throw new Error(visible.error.message);
      const visibleIds = new Set((visible.data || []).map((row: { id: string }) => row.id));
      const missing = ids.filter(id => !visibleIds.has(id));
      if (missing.length) throw new Error(`Scoped update rejected: one or more ${table} records are unavailable in this scope.`);

      for (const update of updates) {
        const query = client().from('app_records')
          .update({ record: cleanRecord(update.record), updated_at: new Date().toISOString() })
          .eq('table_name', table).eq('id', update.id).select('id');
        const result = await withScope(query, scope, organisationId);
        if (result.error) throw new Error(result.error.message);
        if (!result.data?.length) throw new Error(`Scoped update found no ${table} record with ID ${update.id}.`);
      }
    },

    async delete(table: string, ids: string[]) {
      assertCollection(scope, table);
      if (!ids.length) return;
      if (new Set(ids).size !== ids.length) throw new Error('A scoped delete cannot contain duplicate record IDs.');

      // Preflight the full ID set so a cross-tenant or nonexistent ID cannot
      // cause an otherwise valid subset to be deleted before the mismatch is seen.
      const lookup = client().from('app_records').select('id')
        .eq('table_name', table).in('id', ids);
      const visible = await withScope(lookup, scope, organisationId);
      if (visible.error) throw new Error(visible.error.message);
      if ((visible.data || []).length !== ids.length) {
        throw new Error(`Scoped delete rejected: one or more ${table} records are unavailable in this scope.`);
      }

      const query = client().from('app_records').delete().eq('table_name', table).in('id', ids).select('id');
      const result = await withScope(query, scope, organisationId);
      if (result.error) throw new Error(result.error.message);
      if ((result.data || []).length !== ids.length) {
        throw new Error(`Scoped delete did not match every requested ${table} record.`);
      }
    },
  };
}

export const platformDb = scopedRepository('global');

export function organisationDb(organisationId: string) {
  if (!organisationId?.trim()) throw new Error('An organisation ID is required.');
  return scopedRepository('organisation', organisationId);
}

export function requireOrganisation() {
  return async (ctx: RouterContext) => {
    if (!ctx.user) return error('Authentication required.', 401);
    const organisationId = String(ctx.req.headers['x-organisation-id'] || '').trim();
    if (!organisationId) return error('Select an organisation to continue.', 400);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organisationId)) {
      return error('The selected organisation is invalid.', 400);
    }

    const db = client();
    const { data: membership, error: membershipError } = await db
      .from('organisation_members')
      .select('id, organisation_id, role_id, status')
      .eq('organisation_id', organisationId)
      .eq('user_id', ctx.user.userId)
      .eq('status', 'active')
      .maybeSingle();

    if (membershipError) {
      console.error('Organisation membership lookup failed:', membershipError.message);
      return error('Could not verify organisation access.', 503);
    }
    if (!membership) return error('You are not an active member of this organisation.', 403);

    const [{ data: organisation, error: organisationError }, { data: role, error: roleError }, { data: platformAdmin, error: adminError }] = await Promise.all([
      db.from('organisations').select('id,name,slug,status').eq('id', organisationId).maybeSingle(),
      db.from('organisation_roles').select('id,key,name,permissions').eq('id', membership.role_id).eq('organisation_id', organisationId).maybeSingle(),
      db.from('platform_admins').select('user_id').eq('user_id', ctx.user.userId).maybeSingle(),
    ]);

    if (organisationError || roleError || adminError) {
      console.error('Organisation context lookup failed:', organisationError?.message || roleError?.message || adminError?.message);
      return error('Could not resolve organisation access.', 503);
    }
    if (!organisation || organisation.status !== 'active' || !role) {
      return error('The selected organisation or membership role is unavailable.', 403);
    }

    const permissions = Array.isArray(role.permissions)
      ? role.permissions.filter((value: unknown): value is string => typeof value === 'string')
      : [];

    ctx.organisation = {
      id: organisation.id,
      slug: organisation.slug,
      name: organisation.name,
      membershipId: membership.id,
      roleId: role.id,
      roleKey: role.key,
      roleName: role.name,
      permissions,
      isPlatformAdmin: Boolean(platformAdmin),
    };
    setDatabaseScope({ kind: 'organisation', organisationId: organisation.id });
  };
}

export function requireLegacyOrganisation() {
  return async (_ctx: RouterContext) => {
    const { data, error: lookupError } = await client()
      .from('organisations').select('id,status').eq('slug', 'legacy-bidwatch-workspace').maybeSingle();
    if (lookupError) {
      console.error('Legacy workspace lookup failed:', lookupError.message);
      return error('Could not resolve the scheduled workspace.', 503);
    }
    if (!data || data.status !== 'active') return error('The scheduled workspace is unavailable.', 503);
    setDatabaseScope({ kind: 'organisation', organisationId: data.id });
  };
}

export function requireOrganisationPermission(permission: string) {
  return async (ctx: RouterContext) => {
    if (!ctx.organisation) return error('Organisation context is required.', 403);
    if (!ctx.organisation.permissions.includes(permission)) {
      return error('You do not have permission to perform this action.', 403);
    }
  };
}

export function requirePlatformAdmin() {
  return async (ctx: RouterContext) => {
    if (!ctx.user) return error('Authentication required.', 401);
    const { data, error: lookupError } = await client()
      .from('platform_admins').select('user_id')
      .eq('user_id', ctx.user.userId).maybeSingle();
    if (lookupError) {
      console.error('Platform administrator lookup failed:', lookupError.message);
      return error('Could not verify platform administrator access.', 503);
    }
    if (!data) return error('Platform administrator access required.', 403);
  };
}
