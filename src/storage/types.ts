/**
 * Generic storage types for backend implementations.
 *
 * Storage implementations (local, memory, s3) are domain-agnostic.
 * Domain-specific wrappers (e.g. `RunStorage`) pass namespace and filters.
 */

/** Supported storage DB keys. Extend as new storage types are added. */
export const SUPPORTED_STORAGE_KEYS = ['runs', 'tasks'] as const;
export type StorageKey = (typeof SUPPORTED_STORAGE_KEYS)[number];

const SUPPORTED_STORAGE_KEYS_SET = new Set<string>(SUPPORTED_STORAGE_KEYS);

export function isSupportedStorageKey(name: string): boolean {
  return SUPPORTED_STORAGE_KEYS_SET.has(name);
}

/**
 * Parsed --storage overrides (mirrors layered-merge pattern used for LLM config).
 * Global applies when a DB has no specific override.
 */
export interface StorageOverrides {
  /** Global default — bare value like `local` or `s3://bucket/prefix`. */
  globalStorage?: string;
  /** Per-DB overrides: runs=local, tasks=s3, etc. */
  storages?: Record<string, string>;
}

/** Generic filter for list/clear operations. Domain logic builds these. */
export interface StorageFilter {
  type: 'match';
  field: string;
  value: string | number | boolean;
}

/**
 * Generic key-value storage interface.
 * Implementations receive a namespace (e.g. "runs") and handle filtering in their own way.
 */
export interface StorageImpl<T> {
  save(id: string, data: T): Promise<void>;
  get(id: string): Promise<T | null>;
  list(filters?: StorageFilter[]): Promise<T[]>;
  delete(id: string): Promise<void>;
  clear(filters?: StorageFilter[]): Promise<void>;
}
