/**
 * S3-backed storage.
 *
 * Stores JSON objects. Uses standard AWS credential chain.
 * Supports ?profile=name and ?region=... in the URI.
 * Keys: {prefix}/{namespace}/{id}.json
 *
 * Example: s3://my-bucket/prod/runs/abc123.json
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { fromIni } from '@aws-sdk/credential-providers';

import type { StorageFilter, StorageImpl } from '../types.js';

function createS3Client(opts: { region?: string; profile?: string }): S3Client {
  const region = opts.region ?? process.env.AWS_REGION ?? 'us-east-1';
  const base = { region };

  if (opts.profile?.trim()) {
    return new S3Client({
      ...base,
      credentials: fromIni({ profile: opts.profile.trim() }),
    });
  }

  return new S3Client(base);
}

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

export interface S3StorageOpts {
  bucket: string;
  /** Optional prefix before namespace (e.g. "prod" → prod/runs/) */
  prefix?: string;
  /** Namespace/table (e.g. "runs") */
  namespace: string;
  region?: string;
  profile?: string;
  /** Field name on T used as storage key (default: "runId") */
  idField?: string;
}

export class S3Storage<T> implements StorageImpl<T> {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly keyPrefix: string;
  private readonly idField: string;

  constructor(opts: S3StorageOpts) {
    this.client = createS3Client({ region: opts.region, profile: opts.profile });
    this.bucket = opts.bucket;
    const prefix = opts.prefix?.replace(/\/$/, '') ?? '';
    this.keyPrefix = prefix ? `${prefix}/${opts.namespace}` : opts.namespace;
    this.idField = opts.idField ?? DEFAULT_ID_FIELD;
  }

  private key(id: string): string {
    return `${this.keyPrefix}/${id}.json`;
  }

  async save(id: string, data: T): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(id),
        Body: JSON.stringify(data, null, 2),
        ContentType: 'application/json',
      }),
    );
  }

  async get(id: string): Promise<T | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.key(id),
        }),
      );
      const body = res.Body;
      if (!body) return null;
      const text = await body.transformToString();
      return JSON.parse(text) as T;
    } catch (err) {
      const e = err as { name?: string };
      if (e?.name === 'NoSuchKey') return null;
      throw err;
    }
  }

  async list(filters?: StorageFilter[]): Promise<T[]> {
    const listPrefix = `${this.keyPrefix}/`;
    const results: T[] = [];
    let continuationToken: string | undefined;

    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: listPrefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of res.Contents ?? []) {
        const key = obj.Key;
        if (!key?.endsWith('.json')) continue;
        const id =
          key
            .replace(/\.json$/, '')
            .split('/')
            .pop() ?? '';
        const item = await this.get(id);
        if (item != null) results.push(item);
      }

      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);

    return applyFilters(results, filters);
  }

  async delete(id: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: this.key(id),
        }),
      );
    } catch (err) {
      const e = err as { name?: string };
      if (e?.name === 'NoSuchKey') return;
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
