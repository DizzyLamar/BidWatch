import express, { type Request, type Response } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const STORAGE_BUCKET = process.env.BIDWATCH_STORAGE_BUCKET || 'bidwatch';

// Keep the process bootable so Render's /healthz can report configuration problems.
// Protected application routes fail explicitly through requireAuth/db operations.
const supabase = SUPABASE_URL && SUPABASE_SECRET_KEY ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
}) : null;

export type RouterContext = {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, unknown>;
  user?: { userId: string; email: string; name: string };
  organisation?: { id: string; slug: string; name: string; membershipId: string; roleId: string; roleKey: string; roleName: string; permissions: string[]; isPlatformAdmin: boolean };
  req: Request;
  res: Response;
};

type RouteMiddleware = (ctx: RouterContext) => Promise<unknown> | unknown;
type RouteMap = Record<string, RouteMiddleware[]>;

export function json(data: unknown, status = 200) {
  return { __response: true, status, data };
}

export function error(message: string, status = 400) {
  return { __response: true, status, data: { error: message } };
}

function isResponse(value: any): value is { __response: true; status: number; data: unknown } {
  return Boolean(value && value.__response === true);
}

export function router(routes: RouteMap) {
  const r = express.Router();
  for (const [definition, middlewares] of Object.entries(routes)) {
    const split = definition.indexOf(' ');
    const method = definition.slice(0, split).toLowerCase();
    const routePath = definition.slice(split + 1);
    const handler = async (req: Request, res: Response) => databaseScopeStorage.run({ scope: null }, async () => {
      const ctx: RouterContext = {
        body: req.body,
        params: req.params as Record<string, string>,
        query: req.query as Record<string, unknown>,
        req,
        res,
      };
      try {
        for (const middleware of middlewares) {
          const result = await middleware(ctx);
          if (isResponse(result)) {
            res.status(result.status).json(result.data);
            return;
          }
        }
        if (!res.headersSent) res.status(204).end();
      } catch (err) {
        console.error(err);
        if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
      }
    });
    (r as any)[method](routePath, handler);
  }
  return r;
}

export function requireAuth() {
  return async (ctx: RouterContext) => {
    if (!supabase) return error('BidWatch server is missing its Supabase configuration.', 503);
    const header = ctx.req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return error('Authentication required.', 401);
    const { data, error: authError } = await supabase!.auth.getUser(match[1]);
    if (authError || !data.user) return error('Authentication required.', 401);
    const email = String(data.user.email || '').toLowerCase();
    const name = String(data.user.user_metadata?.full_name || data.user.user_metadata?.name || email.split('@')[0] || 'User');
    ctx.user = { userId: data.user.id, email, name };
  };
}

type RecordRow = { id: string; table_name: string; record: Record<string, unknown> };
type DatabaseScope = { kind: 'global' } | { kind: 'organisation'; organisationId: string; legacyStorage?: boolean };
const databaseScopeStorage = new AsyncLocalStorage<{ scope: DatabaseScope | null }>();
const GLOBAL_COLLECTIONS = new Set(['users', 'opportunity_source_runs']);
const ORGANISATION_COLLECTIONS = new Set([
  'activity', 'attachments', 'bid_history', 'bid_requirements', 'bid_tasks',
  'categories', 'notifications', 'opportunity_changes', 'opportunity_updates',
  'opportunity_watchlists', 'roles', 'security_activity', 'tenders',
]);

export function setDatabaseScope(scope: DatabaseScope) {
  const store = databaseScopeStorage.getStore();
  if (!store) throw new Error('Database scope can only be set during an API request.');
  store.scope = scope;
}

function applyDatabaseScope(table: string, query: any) {
  const scope = databaseScopeStorage.getStore()?.scope;
  if (!scope) throw new Error('A verified database scope is required for every record operation.');
  if (GLOBAL_COLLECTIONS.has(table)) return query.eq('scope_type', 'global').is('organisation_id', null);
  if (ORGANISATION_COLLECTIONS.has(table)) {
    if (scope.kind !== 'organisation') throw new Error(`An organisation context is required to access ${table}.`);
    return query.eq('scope_type', 'organisation').eq('organisation_id', scope.organisationId);
  }
  throw new Error(`Collection "${table}" is not registered for scoped access.`);
}

function cleanScopedRecord(record: Record<string, unknown>) {
  const { id: _id, scope_type: _scope, organisation_id: _organisation, ...payload } = record;
  return payload;
}

async function checked<T>(result: { data: T | null; error: any }) {
  if (!supabase) throw new Error('Supabase is not configured.');
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}

function assertStoragePath(path: string, allowLegacy = true) {
  const scope = databaseScopeStorage.getStore()?.scope;
  if (!scope || scope.kind !== 'organisation') throw new Error('An organisation context is required for storage access.');
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.')) {
    throw new Error('The storage path is invalid.');
  }
  const organisationPrefix = `organisations/${scope.organisationId}/`;
  const legacyPrefixAllowed = allowLegacy && scope.legacyStorage === true && path.startsWith('tenders/');
  if (!path.startsWith(organisationPrefix) && !legacyPrefixAllowed) {
    throw new Error('The storage path is outside the active organisation.');
  }
}

export const db = {
  async list<T>(table: string, options: { limit?: number } = {}) {
    const query = supabase!.from('app_records').select('id,table_name,record')
      .eq('table_name', table).order('created_at', { ascending: false })
      .limit(Math.min(options.limit ?? 500, 5000));
    const result = await applyDatabaseScope(table, query);
    const rows = await checked<RecordRow[]>(result);
    return { items: rows.map(row => ({ ...(row.record as T), id: row.id })) };
  },
  async get<T>(table: string, ids: string[]) {
    if (!ids.length) return [];
    const query = supabase!.from('app_records').select('id,record').eq('table_name', table).in('id', ids);
    const result = await applyDatabaseScope(table, query);
    const rows = await checked<Array<{ id: string; record: T }>>(result);
    return rows.map(row => ({ ...(row.record as T), id: row.id }));
  },
  async add(table: string, records: Record<string, unknown>[]) {
    if (!records.length) return [];
    const scope = databaseScopeStorage.getStore()?.scope;
    if (!scope) throw new Error('A verified database scope is required for every record operation.');
    // Validate collection and scope before constructing the insert payload.
    applyDatabaseScope(table, supabase!.from('app_records').select('id'));
    const rows = records.map(record => ({
      ...(typeof record.id === 'string' ? { id: record.id } : {}),
      table_name: table,
      record: cleanScopedRecord(record),
      scope_type: GLOBAL_COLLECTIONS.has(table) ? 'global' : 'organisation',
      organisation_id: GLOBAL_COLLECTIONS.has(table) ? null : scope.kind === 'organisation' ? scope.organisationId : null,
    }));
    if (ORGANISATION_COLLECTIONS.has(table) && scope.kind !== 'organisation') {
      throw new Error(`An organisation context is required to insert ${table}.`);
    }
    const result = await supabase!.from('app_records').insert(rows).select('id');
    const inserted = await checked<Array<{ id: string }>>(result);
    return inserted.map(row => row.id);
  },
  async update(table: string, updates: Array<{ id: string; record: object }>) {
    if (!updates.length) return;
    const ids = updates.map(item => item.id);
    if (new Set(ids).size !== ids.length) throw new Error('A scoped update cannot contain duplicate record IDs.');
    const lookup = supabase!.from('app_records').select('id').eq('table_name', table).in('id', ids);
    const visible = await checked<Array<{ id: string }>>(applyDatabaseScope(table, lookup));
    const visibleIds = new Set(visible.map(row => row.id));
    if (ids.some(id => !visibleIds.has(id))) throw new Error(`Scoped update rejected: one or more ${table} records are unavailable in this scope.`);
    for (const update of updates) {
      const query = supabase!.from('app_records')
        .update({ record: cleanScopedRecord(update.record as Record<string, unknown>), updated_at: new Date().toISOString() })
        .eq('table_name', table).eq('id', update.id).select('id');
      const result = await checked<Array<{ id: string }>>(applyDatabaseScope(table, query));
      if (!result.length) throw new Error(`Scoped update found no ${table} record with ID ${update.id}.`);
    }
  },
  async delete(table: string, ids: string[]) {
    if (!ids.length) return;
    if (new Set(ids).size !== ids.length) throw new Error('A scoped delete cannot contain duplicate record IDs.');
    const lookup = supabase!.from('app_records').select('id').eq('table_name', table).in('id', ids);
    const visible = await checked<Array<{ id: string }>>(applyDatabaseScope(table, lookup));
    if (visible.length !== ids.length) throw new Error(`Scoped delete rejected: one or more ${table} records are unavailable in this scope.`);
    const query = supabase!.from('app_records').delete().eq('table_name', table).in('id', ids).select('id');
    const deleted = await checked<Array<{ id: string }>>(applyDatabaseScope(table, query));
    if (deleted.length !== ids.length) throw new Error(`Scoped delete did not match every requested ${table} record.`);
  },
};

export const storageService = {
  async put(path: string, content: string, contentType: string) {
    assertStoragePath(path, false);
    if (!supabase) throw new Error('Supabase is not configured.');
    const result = await supabase!.storage.from(STORAGE_BUCKET).upload(path, Buffer.from(content, 'base64'), {
      contentType, upsert: false,
    });
    return !result.error;
  },
  async getUrl(path: string) {
    assertStoragePath(path);
    if (!supabase) throw new Error('Supabase is not configured.');
    const result = await supabase!.storage.from(STORAGE_BUCKET).createSignedUrl(path, 3600);
    if (result.error || !result.data?.signedUrl) throw new Error(result.error?.message || 'Could not create file URL.');
    return result.data.signedUrl;
  },
  async delete(paths: string[]) {
    paths.forEach(path => assertStoragePath(path));
    if (!supabase) return paths.map(() => false);
    if (!paths.length) return [];
    const result = await supabase!.storage.from(STORAGE_BUCKET).remove(paths);
    if (result.error) return paths.map(() => false);
    return paths.map(() => true);
  },
  async listAll(prefix: string, maxFiles: number) {
    assertStoragePath(prefix);
    if (!supabase) throw new Error('Supabase is not configured.');
    const root = prefix.replace(/^\/+|\/+$/g, '');
    const paths: string[] = [];
    async function walk(folder: string): Promise<void> {
      if (paths.length >= maxFiles) return;
      const { data, error: listError } = await supabase!.storage.from(STORAGE_BUCKET).list(folder, {
        limit: Math.min(1000, maxFiles - paths.length), offset: 0,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (listError) throw new Error(listError.message);
      for (const item of data || []) {
        const itemPath = folder ? folder + '/' + item.name : item.name;
        if (item.id) paths.push(itemPath);
        else await walk(itemPath);
        if (paths.length >= maxFiles) break;
      }
    }
    await walk(root);
    return { paths };
  },
};

export const supabaseAdmin = supabase;
