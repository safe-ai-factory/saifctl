/**
 * In-memory storage — ephemeral, no persistence.
 *
 * Use for --storage none. Data is lost when the process exits.
 */

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

/** Constructor options for {@link MemoryStorage}: optional namespace plus the id field on T. */
export interface MemoryStorageOpts {
  /** Optional namespace for logical separation when sharing a single instance. Unused for now. */
  namespace?: string;
  /** Field name on T used as storage key (default: "runId") */
  idField?: string;
}

/** Ephemeral in-process {@link StorageImpl} backed by a `Map`; used for `--storage none` and tests. */
export class MemoryStorage<T> implements StorageImpl<T> {
  private readonly store = new Map<string, T>();
  private readonly idField: string;

  constructor(opts?: MemoryStorageOpts) {
    this.idField = opts?.idField ?? DEFAULT_ID_FIELD;
  }

  async save(id: string, data: T): Promise<void> {
    this.store.set(id, data);
  }

  async get(id: string): Promise<T | null> {
    return this.store.get(id) ?? null;
  }

  async list(filters?: StorageFilter[]): Promise<T[]> {
    const items = Array.from(this.store.values());
    return applyFilters(items, filters);
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  async clear(filters?: StorageFilter[]): Promise<void> {
    const items = await this.list(filters);
    for (const item of items) {
      const record = item as Record<string, unknown>;
      const id = record[this.idField];
      if (typeof id === 'string') this.store.delete(id);
    }
  }
}
