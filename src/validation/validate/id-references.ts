import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { consola } from '../../logger.js';
import { spawnCapture } from '../../utils/io.js';

/**
 * Enforces the citation rules from release-readiness/specification.md
 * Appendix C: any reference to one of that feature's IDs (D-NN, Q-NN,
 * NPM-NN, X-NN, X-NN-PN, etc.) outside the spec itself must be
 * qualified with a `release-readiness/` prefix.
 *
 * The deprecated `X08-P<N>` form (without the inner dash) is also
 * rejected — see Appendix C.1.
 */

const PREFIXES = ['CLM', 'DCK', 'DOC', 'NPM', 'PRE', 'SDR', 'VND', 'VSX', 'WEB'];

const BARE_ID_RE = new RegExp(
  String.raw`(?<!release-readiness/)\b(?:` +
    PREFIXES.join('|') +
    String.raw`|D|Q)-\d{2,3}\b|(?<!release-readiness/)\bX-\d{2}(?:-P\d{1,2})?\b`,
  'g',
);

const DEPRECATED_X08_RE = /\bX08-P\d{1,2}\b/g;

const SCANNED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.sh',
  '.md',
  '.yml',
  '.yaml',
  '.json',
]);

const SCANNED_BASENAMES = new Set(['Dockerfile', 'Dockerfile.coder']);

const EXCLUDED_PATHS = new Set<string>([
  'saifctl/features/release-readiness/specification.md',
  'SKILL.md',
  'src/validation/validate/id-references.ts',
]);

const TEST_NAME_CALL_RE = /\b(?:describe|describeIntegration|it|itWithLLM|test)\s*\(/;

interface Violation {
  file: string;
  line: number;
  col: number;
  match: string;
  reason: 'bare' | 'deprecated-x08';
}

function shouldScan(path: string): boolean {
  if (EXCLUDED_PATHS.has(path)) return false;
  if (path.startsWith('saifctl/features/release-readiness/phases/')) return false;
  const basename = path.split('/').pop() ?? path;
  if (SCANNED_BASENAMES.has(basename)) return true;
  const dot = basename.lastIndexOf('.');
  if (dot < 0) return false;
  return SCANNED_EXTENSIONS.has(basename.slice(dot));
}

function isInTestNameString(line: string, col: number): boolean {
  if (!TEST_NAME_CALL_RE.test(line)) return false;
  const before = line.slice(0, col);
  const quotes = before.match(/['"`]/g);
  // Inside an open string literal opened in the same line — heuristic
  // catches `describe('… X-08-P2 …', () => {` but not multi-line tags.
  return quotes !== null && quotes.length % 2 === 1;
}

async function scanFile(path: string): Promise<Violation[]> {
  const content = await readFile(path, 'utf-8');
  const violations: Violation[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(BARE_ID_RE)) {
      const col = m.index ?? 0;
      if (isInTestNameString(line, col)) continue;
      violations.push({
        file: path,
        line: i + 1,
        col: col + 1,
        match: m[0],
        reason: 'bare',
      });
    }
    for (const m of line.matchAll(DEPRECATED_X08_RE)) {
      const col = m.index ?? 0;
      violations.push({
        file: path,
        line: i + 1,
        col: col + 1,
        match: m[0],
        reason: 'deprecated-x08',
      });
    }
  }
  return violations;
}

export default async function validateIdReferences() {
  const cwd = process.cwd();
  const output = await spawnCapture({
    command: 'git',
    args: ['ls-files'],
    cwd,
  });
  const files = output.split('\n').filter((f) => f.trim() !== '' && shouldScan(f));

  const allViolations: Violation[] = [];
  for (const f of files) {
    const path = join(cwd, f);
    const found = await scanFile(path).catch(() => [] as Violation[]);
    for (const v of found) {
      allViolations.push({ ...v, file: f });
    }
  }

  if (allViolations.length === 0) return;

  const bare = allViolations.filter((v) => v.reason === 'bare');
  const deprecated = allViolations.filter((v) => v.reason === 'deprecated-x08');

  consola.error('❌ release-readiness ID citation violations found.');
  consola.error('');
  consola.error('   Rule: Appendix C of saifctl/features/release-readiness/specification.md.');
  consola.error('   IDs from that spec (D-NN, NPM-NN, X-NN, X-NN-PN, etc.) must be cited');
  consola.error('   as `release-readiness/<ID>` outside the spec itself.');
  consola.error('');

  if (bare.length > 0) {
    consola.error(`   ${bare.length} bare reference(s):`);
    for (const v of bare) {
      consola.error(`     ${v.file}:${v.line}:${v.col}  ${v.match}`);
    }
    consola.error('');
  }
  if (deprecated.length > 0) {
    consola.error(`   ${deprecated.length} deprecated X08-P<N> form(s) (use X-08-P<N>):`);
    for (const v of deprecated) {
      consola.error(`     ${v.file}:${v.line}:${v.col}  ${v.match}`);
    }
    consola.error('');
  }

  throw new Error(
    `${allViolations.length} release-readiness ID citation violation(s). ` +
      'See saifctl/features/release-readiness/specification.md Appendix C.',
  );
}
