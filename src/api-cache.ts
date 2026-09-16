import { api } from '@appdeploy/client';

type CacheEntry = {
  data: any;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<{ data: any }>>();

export async function cachedGet<T = any>(url: string, ttlMs: number): Promise<{ data: T }> {
  const now = Date.now();
  const existing = cache.get(url);
  if (existing && existing.expiresAt > now) return { data: existing.data as T };

  const running = inflight.get(url);
  if (running) return running as Promise<{ data: T }>;

  const request = api.get(url)
    .then(response => {
      cache.set(url, { data: response.data, expiresAt: Date.now() + ttlMs });
      return response;
    })
    .finally(() => {
      inflight.delete(url);
    });

  inflight.set(url, request);
  return request as Promise<{ data: T }>;
}

export function invalidateApiCache(prefixes?: string[]) {
  if (!prefixes?.length) {
    cache.clear();
    return;
  }

  for (const key of cache.keys()) {
    if (prefixes.some(prefix => key === prefix || key.startsWith(prefix))) cache.delete(key);
  }
}

export function clearApiCache() {
  cache.clear();
}
