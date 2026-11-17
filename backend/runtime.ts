import express, { type Request, type Response } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient } from '@supabase/supabase-js';
import { assertOrganisationStoragePath, createScopedRecordRepository, type DatabaseScope } from './scoped-records';

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
  user?: { userId: string; email: string; name: string; emailVerified: boolean };
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
    ctx.user = { userId: data.user.id, email, name, emailVerified: Boolean(data.user.email_confirmed_at || data.user.confirmed_at) };
  };
}

const databaseScopeStorage = new AsyncLocalStorage<{ scope: DatabaseScope | null }>();

export function setDatabaseScope(scope: DatabaseScope) {
  const store = databaseScopeStorage.getStore();
  if (!store) throw new Error('Database scope can only be set during an API request.');
  store.scope = scope;
}

export const db = createScopedRecordRepository(
  supabase,
  () => databaseScopeStorage.getStore()?.scope ?? null,
);

function assertStoragePath(path: string, allowLegacy = true) {
  assertOrganisationStoragePath(
    path,
    databaseScopeStorage.getStore()?.scope ?? null,
    allowLegacy,
  );
}

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
