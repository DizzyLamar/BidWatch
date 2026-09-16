import { storage } from '@appdeploy/sdk';

export interface StorageService {
  put(path: string, content: string, contentType: string): Promise<boolean>;
  getUrl(path: string): Promise<string>;
  delete(paths: string[]): Promise<boolean[]>;
  listAll(prefix: string, maxFiles: number): Promise<{ paths: string[]; nextToken?: string }>;
}

export const storageService: StorageService = {
  async put(path, content, contentType) {
    const [ok] = await storage.write([{ path, content, contentType }]);
    return Boolean(ok);
  },
  async getUrl(path) {
    const [{ url }] = await storage.url([path]);
    return url;
  },
  async delete(paths) {
    return storage.delete(paths);
  },
  async listAll(prefix, maxFiles) {
    const paths: string[] = [];
    let nextToken: string | undefined;
    do {
      const page = await storage.list({ prefix, limit: Math.min(1000, maxFiles - paths.length), nextToken });
      paths.push(...page.paths);
      nextToken = page.nextToken;
    } while (nextToken && paths.length < maxFiles);
    return { paths, nextToken };
  },
};
