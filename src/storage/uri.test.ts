import { describe, expect, it } from 'vitest';

import { parseStorageUri } from './uri.js';

const defaultBasePath = '/tmp/project/.saifctl';

describe('parseStorageUri', () => {
  it('expands local to file', () => {
    const cfg = parseStorageUri('local', defaultBasePath);
    expect(cfg.protocol).toBe('file');
    expect(cfg.pathOrBucket).toBe(defaultBasePath);
    expect(cfg.prefix).toBe('');
  });

  it('expands none to memory', () => {
    const cfg = parseStorageUri('none', defaultBasePath);
    expect(cfg.protocol).toBe('memory');
  });

  it('expands memory to memory', () => {
    const cfg = parseStorageUri('memory', defaultBasePath);
    expect(cfg.protocol).toBe('memory');
  });

  it('parses file URI', () => {
    const cfg = parseStorageUri('file:///Users/me/custom-base', defaultBasePath);
    expect(cfg.protocol).toBe('file');
    expect(cfg.pathOrBucket).toBe('/Users/me/custom-base');
  });

  it('parses s3 shorthand (no prefix)', () => {
    const orig = process.env.SAIF_DEFAULT_S3_BUCKET;
    process.env.SAIF_DEFAULT_S3_BUCKET = 'my-bucket';
    try {
      const cfg = parseStorageUri('s3', defaultBasePath);
      expect(cfg.protocol).toBe('s3');
      expect(cfg.pathOrBucket).toBe('my-bucket');
      expect(cfg.prefix).toBe('');
    } finally {
      if (orig !== undefined) process.env.SAIF_DEFAULT_S3_BUCKET = orig;
      else delete process.env.SAIF_DEFAULT_S3_BUCKET;
    }
  });

  it('parses full s3 URI with prefix and options', () => {
    const cfg = parseStorageUri(
      's3://my-bucket/runs/v1?profile=dev&region=us-west-2',
      defaultBasePath,
    );
    expect(cfg.protocol).toBe('s3');
    expect(cfg.pathOrBucket).toBe('my-bucket');
    expect(cfg.prefix).toBe('runs/v1');
    expect(cfg.options.profile).toBe('dev');
    expect(cfg.options.region).toBe('us-west-2');
  });

  it('throws for s3 shorthand without SAIF_DEFAULT_S3_BUCKET', () => {
    const orig = process.env.SAIF_DEFAULT_S3_BUCKET;
    delete process.env.SAIF_DEFAULT_S3_BUCKET;
    try {
      expect(() => parseStorageUri('s3', defaultBasePath)).toThrow(/SAIF_DEFAULT_S3_BUCKET/);
    } finally {
      if (orig !== undefined) process.env.SAIF_DEFAULT_S3_BUCKET = orig;
    }
  });
});
