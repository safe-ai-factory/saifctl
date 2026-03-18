import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: 'export',
  images: {
    unoptimized: true,
  },
  // Required for GitHub Pages when deployed from a project repo (e.g. owner.github.io/repo-name)
  // Set to '' or remove if using a custom domain or username.github.io repo
  basePath: process.env.NODE_ENV === 'production' ? '' : '',
  // Pin workspace root to web/ to avoid monorepo lockfile confusion
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
