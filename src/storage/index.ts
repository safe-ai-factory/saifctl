/**
 * Generic storage — create backend implementations from URIs.
 *
 * Storage implementations are domain-agnostic. Pass a namespace (e.g. "runs")
 * so each domain stores data under its own path/prefix.
 *
 * URIs:
 *   local  → file://{projectDir}/.saifctl
 *   none   → null (no persistence)
 *   s3     → s3://{SAIF_DEFAULT_S3_BUCKET}
 *   file:///path  → custom local directory
 *   s3://bucket/prefix?profile=x  → S3 with options
 */

import { join } from 'node:path';

import { LocalStorage } from './storages/local.js';
import { S3Storage } from './storages/s3.js';
import type { StorageImpl } from './types.js';
import { parseStorageUri, type StorageConfig } from './uri.js';

export interface CreateStorageOptions {
  /** "local" | "none" | "file:///path" | "s3" | "s3://bucket/prefix" */
  uriOrShorthand: string;
  /** Used for default local path when uri is "local" */
  projectDir: string;
  /** Table/DB name (e.g. "runs") — appended to base path */
  namespace: string;
  /** Field on T used as storage key (default: "runId") */
  idField?: string;
}

/**
 * Creates a generic storage from a URI or shorthand.
 *
 * @returns StorageImpl instance, or null for "none" (no persistence)
 */
export function createStorage<T>({
  uriOrShorthand,
  projectDir,
  namespace,
  idField = 'runId',
}: CreateStorageOptions): StorageImpl<T> | null {
  const defaultBasePath = join(projectDir, '.saifctl');
  const config = parseStorageUri(uriOrShorthand, defaultBasePath);

  switch (config.protocol) {
    case 'file':
      return new LocalStorage<T>({
        baseDir: config.pathOrBucket,
        namespace,
        idField,
      });
    case 's3':
      return new S3Storage<T>({
        bucket: config.pathOrBucket,
        prefix: config.prefix || undefined,
        namespace,
        region: config.options.region || undefined,
        profile: config.options.profile || undefined,
        idField,
      });
    case 'memory':
      return null;
    default:
      throw new Error(`Unknown storage protocol: ${(config as StorageConfig).protocol}`);
  }
}

export type { StorageFilter, StorageImpl, StorageOverrides } from './types.js';
export type { StorageConfig } from './uri.js';
