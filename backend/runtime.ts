import express, { type Request, type Response } from 'express';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const STORAGE_BUCKET = process.env.BIDWATCH_STORAGE_BUCKET || 'bidwatch';

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required.');

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

export type RouterContext = {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, unknown>;
  user?: { userId: string; email: string; name: string };
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
    const handler = async (req: Request, res: Response) => {
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
    };
    (r as any)[method](routePath, handler);
  }
  return r;
}

export function requireAuth() {
  return async (ctx: RouterContext) => {
    const header = ctx.req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return error('Authentication required.', 401);
    const { data, error: authError } = await supabase.auth.getUser(match[1]);
    if (authError || !data.user) return error('Authentication required.', 401);
    const email = String(data.user.email || '').toLowerCase();
    const name = String(data.user.user_metadata?.full_name || data.user.user_metadata?.name || email.split('@')[0] || 'User');
    ctx.user = { userId: data.user.id, email, name };
  };
}

type RecordRow = { id: string; table_name: string; record: Record<string, unknown> };

async function checked<T>(result: { data: T | null; error: any }) {
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}

export const db = {
  async list<T>(table: string, options: { limit?: number } = {}) {
    const result = await supabase.from('app_records').select('id,table_name,record')
      .eq('table_name', table).order('created_at', { ascending: true })
      .limit(Math.min(options.limit ?? 500, 5000));
    const rows = await checked<RecordRow[]>(result);
    return { items: rows.map(row => ({ ...(row.record as T), id: row.id })) };
  },
  async get<T>(table: string, ids: string[]) {
    if (!ids.length) return [];
    const result = await supabase.from('app_records').select('id,record').eq('table_name', table).in('id', ids);
    const rows = await checked<Array<{ id: string; record: T }>>(result);
    return rows.map(row => ({ ...(row.record as T), id: row.id }));
  },
  async add(table: string, records: Record<string, unknown>[]) {
    if (!records.length) return [];
    const rows = records.map(record => {
      const { id: suppliedId, ...payload } = record as Record<string, unknown> & { id?: string };
      return { ...(suppliedId ? { id: suppliedId } : {}), table_name: table, record: payload };
    });
    const result = await supabase.from('app_records').insert(rows).select('id');
    const inserted = await checked<Array<{ id: string }>>(result);
    return inserted.map(row => row.id);
  },
  async update(table: string, updates: Array<{ id: string; record: object }>) {
    for (const update of updates) {
      const result = await supabase.from('app_records')
        .update({ record: update.record, updated_at: new Date().toISOString() })
        .eq('table_name', table).eq('id', update.id);
      await checked(result);
    }
  },
  async delete(table: string, ids: string[]) {
    if (!ids.length) return;
    const result = await supabase.from('app_records').delete().eq('table_name', table).in('id', ids);
    await checked(result);
  },
};

export const storageService = {
  async put(path: string, content: string, contentType: string) {
    const result = await supabase.storage.from(STORAGE_BUCKET).upload(path, Buffer.from(content, 'base64'), {
      contentType, upsert: false,
    });
    return !result.error;
  },
  async getUrl(path: string) {
    const result = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(path, 3600);
    if (result.error || !result.data?.signedUrl) throw new Error(result.error?.message || 'Could not create file URL.');
    return result.data.signedUrl;
  },
  async delete(paths: string[]) {
    if (!paths.length) return [];
    const result = await supabase.storage.from(STORAGE_BUCKET).remove(paths);
    if (result.error) return paths.map(() => false);
    return paths.map(() => true);
  },
  async listAll(prefix: string, maxFiles: number) {
    const root = prefix.replace(/^\/+|\/+$/g, '');
    const paths: string[] = [];
    async function walk(folder: string): Promise<void> {
      if (paths.length >= maxFiles) return;
      const { data, error: listError } = await supabase.storage.from(STORAGE_BUCKET).list(folder, {
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
