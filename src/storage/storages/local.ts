/**
 * Local filesystem-backed storage.
 *
 * Stores JSON files under baseDir/namespace/. Domain-agnostic.
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { StorageFilter, StorageImpl } from '../types.js';

function applyFilters<T>(items: T[], filters?: StorageFilter[]): T[] {
  if (!filters?.length) return items;
  return items.filter((item) => {
    const record = item as Record<string, unknown>;
    for (const f of filters) {
      if (f.type === 'match' && record[f.field] !== f.value) return false;
    }
    return true;
  });
}

const DEFAULT_ID_FIELD = 'runId';

export interface LocalStorageOpts {
  /** Base directory (e.g. projectDir/.saifctl) */
  baseDir: string;
  /** Namespace/table (e.g. "runs") — appended to baseDir */
  namespace: string;
  /** Field name on T used as storage key (default: "runId") */
  idField?: string;
}

export class LocalStorage<T> implements StorageImpl<T> {
  private readonly dir: string;
  private readonly idField: string;

  constructor(opts: LocalStorageOpts) {
    this.dir = join(opts.baseDir, opts.namespace);
    this.idField = opts.idField ?? DEFAULT_ID_FIELD;
  }

  private itemPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async save(id: string, data: T): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.itemPath(id), JSON.stringify(data, null, 2), 'utf8');
  }

  async get(id: string): Promise<T | null> {
    try {
      const data = await readFile(this.itemPath(id), 'utf8');
      return JSON.parse(data) as T;
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async list(filters?: StorageFilter[]): Promise<T[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const results: T[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const id = f.replace(/\.json$/, '');
      const item = await this.get(id);
      if (item != null) results.push(item);
    }
    return applyFilters(results, filters);
  }

  async delete(id: string): Promise<void> {
    try {
      await unlink(this.itemPath(id));
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return;
      }
      throw err;
    }
  }

  async clear(filters?: StorageFilter[]): Promise<void> {
    const items = await this.list(filters);
    for (const item of items) {
      const record = item as Record<string, unknown>;
      const id = record[this.idField];
      if (typeof id === 'string') await this.delete(id);
    }
  }
}
