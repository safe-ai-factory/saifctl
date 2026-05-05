/**
 * Parse storage URIs into structured config for backend instantiation.
 *
 * Returns base paths/buckets only. Storage implementations append the namespace.
 *
 * Shorthands:
 *   local  → file://{defaultBasePath}  (e.g. projectDir/.saifctl)
 *   none   → memory (ephemeral, no persistence)
 *   s3     → s3://{SAIF_DEFAULT_S3_BUCKET}
 *
 * Full URIs:
 *   file:///absolute/path     → LocalStorage
 *   s3://bucket/prefix        → S3Storage
 *   s3://bucket?profile=dev   → S3Storage with AWS profile override
 */

export interface StorageConfig {
  protocol: 'file' | 's3' | 'memory';
  /** For file: absolute base directory (e.g. projectDir/.saifctl). For s3: bucket name. For memory: unused. */
  pathOrBucket: string;
  /** For s3: optional key prefix before namespace. For file: unused. */
  prefix: string;
  /** Query params (e.g. profile, region for S3) */
  options: Record<string, string>;
}

/**
 * Expands shorthand values to full URIs before parsing.
 * Uses defaultBasePath for local, env SAIF_DEFAULT_S3_BUCKET for s3 shorthand.
 */
function expandShorthand(value: string, defaultBasePath: string): string {
  const v = value.trim().toLowerCase();
  if (v === 'local') return `file://${defaultBasePath}`;
  if (v === 'none' || v === 'memory') return 'memory:';
  if (v === 's3') {
    const bucket = process.env.SAIF_DEFAULT_S3_BUCKET;
    if (!bucket?.trim()) {
      throw new Error(
        'Storage s3 requires SAIF_DEFAULT_S3_BUCKET environment variable. ' +
          'Set it to your bucket name, or use a full URI: --storage s3://your-bucket',
      );
    }
    return `s3://${bucket.trim()}`;
  }
  return value.trim();
}

/**
 * Parses a storage URI (or shorthand) into StorageConfig.
 * @param uriOrShorthand - e.g. "local", "none", "file:///tmp/.saifctl", "s3://bucket/prefix"
 * @param defaultBasePath - e.g. join(projectDir, '.saifctl') — base dir before namespace
 */
export function parseStorageUri(uriOrShorthand: string, defaultBasePath: string): StorageConfig {
  const expanded = expandShorthand(uriOrShorthand, defaultBasePath);

  if (expanded === 'memory:') {
    return { protocol: 'memory', pathOrBucket: '', prefix: '', options: {} };
  }

  try {
    const url = new URL(expanded);
    const options = Object.fromEntries(url.searchParams.entries());

    if (url.protocol === 'file:') {
      const pathname = decodeURIComponent(url.pathname);
      return { protocol: 'file', pathOrBucket: pathname, prefix: '', options };
    }

    if (url.protocol === 's3:') {
      const bucket = url.hostname;
      const prefix = url.pathname.replace(/^\//, '').replace(/\/$/, '');
      return { protocol: 's3', pathOrBucket: bucket, prefix, options };
    }

    throw new Error(`Unsupported storage protocol: ${url.protocol}`);
  } catch (err) {
    if (err instanceof TypeError && expanded.includes(':')) {
      throw new Error(`Invalid storage URI: ${uriOrShorthand}`);
    }
    throw err;
  }
}
