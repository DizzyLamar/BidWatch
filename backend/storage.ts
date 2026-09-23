export { storageService } from './runtime';

export interface StorageService {
  put(path: string, content: string, contentType: string): Promise<boolean>;
  getUrl(path: string): Promise<string>;
  delete(paths: string[]): Promise<boolean[]>;
  listAll(prefix: string, maxFiles: number): Promise<{ paths: string[]; nextToken?: string }>;
}
