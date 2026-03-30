import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  /**
   * CLI must be built in its own pass with `splitting: false`. If `cli` shares a
   * chunk with `index`, `import.meta.url` in the guard at `src/cli/index.ts`
   * points at `chunk-*.js` while `process.argv[1]` is `dist/cli.js`, so the
   * binary never runs (silent no-op).
   */
  {
    entry: { cli: 'src/cli/index.ts' },
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: true,
    splitting: false,
  },
]);
