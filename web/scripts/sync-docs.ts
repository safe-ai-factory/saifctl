/**
 * Sync saifdocs-generated Markdown from repo docs trees into web/src/content/docs/
 * for static rendering. Run before `next build` / `next dev`.
 *
 * Usage (from web/): npx tsx scripts/sync-docs.ts
 * Usage (from repo root): npx tsx web/scripts/sync-docs.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type ManifestEntryType = 'references' | 'concepts' | 'how-tos' | 'tutorials' | 'landing-pages';

type ManifestEntry = {
  id: string;
  type: ManifestEntryType;
  output: string;
  productId: string | null;
  personaId: string | null;
  taskIds: string[];
  conceptId: string | null;
  tutorialPosition: number | null;
  tutorialThreadLength: number | null;
  generatedAt: string | null;
};

type Manifest = {
  version: number;
  outputDir: string;
  projectDir: string;
  entries: ManifestEntry[];
};

type ProductId = 'saifctl' | 'saifbox' | 'saifdocs';

type DocSource = {
  product: ProductId;
  manifestPath: string;
  docsRoot: string;
};

const REPO_ROOT = path.resolve(__dirname, '../..');
const WEB_CONTENT_DOCS = path.resolve(__dirname, '../src/content/docs');

const SECTION_ORDER: ManifestEntryType[] = [
  'landing-pages',
  'tutorials',
  'how-tos',
  'concepts',
  'references',
];

const SECTION_LABELS: Record<ManifestEntryType, string> = {
  'landing-pages': 'Overview',
  tutorials: 'Tutorials',
  'how-tos': 'How-tos',
  concepts: 'Concepts',
  references: 'Reference',
};

const SOURCES: DocSource[] = [
  {
    product: 'saifctl',
    manifestPath: path.resolve(REPO_ROOT, 'docspec/.manifest.json'),
    docsRoot: path.resolve(REPO_ROOT, 'docs'),
  },
  {
    product: 'saifbox',
    manifestPath: path.resolve(REPO_ROOT, 'vendor/saifbox/docs/.manifest.json'),
    docsRoot: path.resolve(REPO_ROOT, 'vendor/saifbox/docs'),
  },
  {
    product: 'saifdocs',
    manifestPath: path.resolve(REPO_ROOT, 'vendor/saifdocs/docspec/.manifest.json'),
    docsRoot: path.resolve(REPO_ROOT, 'vendor/saifdocs/docs'),
  },
];

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Rewrite fenced code blocks in Markdown into <DocCodeBlock> JSX so the output
 * can be treated as MDX and rendered with the real React component.
 *
 * Input:
 *   ```bash
 *   echo hello
 *   ```
 *
 * Output:
 *   <DocCodeBlock lang="bash" code="aGVsbG8gd29ybGQ=" />
 *
 * The code body is base64-encoded and passed as a plain string attribute.
 *
 * Why base64: MDX uses acorn to parse JSX attribute expressions. Characters
 * like `#`, `|`, `├`, `└` inside a `{"..."}` expression cause acorn to throw
 * a parse error. Template literals in attribute position are silently dropped
 * by the MDX compiler. A base64 string is pure ASCII and survives both issues.
 * The component decodes it with atob() / Buffer.from(..., 'base64').
 */
function transformCodeBlocks(content: string): string {
  // Match fenced blocks: ```[lang]\n<body>\n``` (non-greedy, handles empty lang)
  return content.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (...args: string[]) => {
    const [, lang, body] = args;
    const safeLang = lang.trim();
    // Strip the trailing newline the fence always adds, then base64-encode
    const b64 = Buffer.from(body.replace(/\n$/, '')).toString('base64');
    const langAttr = safeLang ? ` lang="${safeLang}"` : '';
    return `<DocCodeBlock${langAttr} code="${b64}" />`;
  });
}

// next-mdx-remote injects components via the `components` map at compile time,
// so no explicit import is needed in the MDX source files.
const MDX_IMPORT = '';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/**
 * Resolve manifest `output` to an absolute path. Relative paths are resolved from
 * REPO_ROOT (the safe-ai-factory checkout). Saifdocs manifests may use repo-relative
 * strings (e.g. `vendor/saifdocs/docs/...`) or absolute paths; both work in CI and locally.
 */
function resolveOutputPath(entry: ManifestEntry): string {
  if (path.isAbsolute(entry.output)) {
    return path.normalize(entry.output);
  }
  return path.resolve(REPO_ROOT, entry.output);
}

function computeDestRelative(opts: {
  product: ProductId;
  entry: ManifestEntry;
  resolvedAbs: string;
  docsRoot: string;
}): string {
  const { product, entry, resolvedAbs, docsRoot } = opts;

  if (entry.type === 'landing-pages') {
    return 'index.mdx';
  }
  const rel = path.relative(docsRoot, resolvedAbs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    fail(`Entry output is outside docs root for ${product}: ${resolvedAbs} (docsRoot=${docsRoot})`);
  }
  const posixRel = toPosix(rel);
  const prefix = `products/${product}/`;
  if (posixRel.startsWith(prefix)) {
    return posixRel.slice(prefix.length);
  }
  return posixRel;
}

function slugFromDestRelative(destRelative: string): string {
  if (destRelative === 'index.mdx' || destRelative === 'index.md' || destRelative === 'index') {
    return '';
  }
  const withoutExt = destRelative.replace(/\.(mdx|md)$/i, '');
  return toPosix(withoutExt);
}

function webPathForSlug(product: ProductId, slug: string): string {
  return `/product/${product}${slug ? `/${slug}` : ''}`;
}

function extractTitle(markdown: string, fallback: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function slugToTitle(slug: string): string {
  const name = slug.split('/').pop() ?? slug;
  return name
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Map an absolute path to a repo .md file to its public URL under /product/{product}/...
 */
function absPathToWebUrl(absMdPath: string): string | null {
  const resolved = path.resolve(absMdPath);
  const withoutMd = resolved.endsWith('.md') ? resolved.slice(0, -3) : resolved;

  const docsRoot = path.resolve(REPO_ROOT, 'docs');
  let r = path.relative(docsRoot, withoutMd);
  if (!r.startsWith('..') && r !== '') {
    const posix = toPosix(r);
    if (posix === 'products/saifctl/index') {
      return '/product/saifctl';
    }
    if (posix.startsWith('products/saifctl/')) {
      const slug = posix.replace(/^products\/saifctl\//, '');
      return `/product/saifctl/${slug}`;
    }
    if (posix === 'products/saifbox/index') {
      return '/product/saifbox';
    }
    if (posix.startsWith('products/saifbox/')) {
      const slug = posix.replace(/^products\/saifbox\//, '');
      return `/product/saifbox/${slug}`;
    }
    if (posix.startsWith('references/')) {
      return `/product/saifctl/${posix}`;
    }
  }

  const saifdocsRoot = path.resolve(REPO_ROOT, 'vendor/saifdocs/docs');
  r = path.relative(saifdocsRoot, withoutMd);
  if (!r.startsWith('..') && r !== '') {
    const posix = toPosix(r);
    if (posix === 'products/saifdocs/index') {
      return '/product/saifdocs';
    }
    if (posix.startsWith('products/saifdocs/')) {
      const slug = posix.replace(/^products\/saifdocs\//, '');
      return `/product/saifdocs/${slug}`;
    }
    if (posix.startsWith('references/')) {
      return `/product/saifdocs/${posix}`;
    }
  }

  const saifboxRoot = path.resolve(REPO_ROOT, 'vendor/saifbox/docs');
  r = path.relative(saifboxRoot, withoutMd);
  if (!r.startsWith('..') && r !== '') {
    const posix = toPosix(r);
    if (posix === 'products/saifbox/index') {
      return '/product/saifbox';
    }
    if (posix.startsWith('products/saifbox/')) {
      const slug = posix.replace(/^products\/saifbox\//, '');
      return `/product/saifbox/${slug}`;
    }
    if (posix.startsWith('references/')) {
      return `/product/saifbox/${posix}`;
    }
  }

  return null;
}

function rewriteLinks(content: string, sourceAbsPath: string): string {
  return content.replace(
    /(\[([^\]]*)\])\(([^)]+\.md(?:#[^)]*)?)\)/g,
    /* eslint-disable-next-line max-params */
    (fullMatch, labelPart: string, _label: string, href: string) => {
      const hashIdx = href.indexOf('#');
      const hrefPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
      const fragment = hashIdx >= 0 ? href.slice(hashIdx + 1) : '';

      const resolvedAbs = path.resolve(path.dirname(sourceAbsPath), hrefPath);
      const webUrl = absPathToWebUrl(resolvedAbs);

      if (!webUrl) {
        console.warn(`  WARN: Could not resolve link ${hrefPath} in ${sourceAbsPath}`);
        return fullMatch;
      }

      const withFragment = fragment ? `${webUrl}#${fragment}` : webUrl;
      return `${labelPart}(${withFragment})`;
    },
  );
}

function filterEntriesForProduct(entries: ManifestEntry[], product: ProductId): ManifestEntry[] {
  return entries.filter((e) => {
    if (product === 'saifctl') {
      return e.productId === 'saifctl' || (e.type === 'references' && e.productId === null);
    }
    if (product === 'saifbox') {
      return e.productId === 'saifbox';
    }
    return e.productId === 'saifdocs' || (e.type === 'references' && e.productId === null);
  });
}

function loadManifest(manifestPath: string): Manifest {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw) as Manifest;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

type WrittenPage = {
  type: ManifestEntryType;
  slug: string;
  title: string;
  path: string;
};

function syncProduct(source: DocSource): WrittenPage[] {
  const { product, manifestPath, docsRoot } = source;

  if (!fs.existsSync(manifestPath)) {
    fail(
      `ERROR: Manifest not found: ${path.relative(REPO_ROOT, manifestPath)}\n` +
        'If vendor paths are git submodules, run: git submodule update --init --recursive\n' +
        'If the saifdocs submodule manifest is missing, run: cd vendor/saifdocs && node dist/cli.js gen --dry-run',
    );
  }
  if (!fs.existsSync(docsRoot)) {
    fail(
      `ERROR: Docs root not found: ${path.relative(REPO_ROOT, docsRoot)}\n` +
        'If vendor paths are git submodules, run: git submodule update --init --recursive',
    );
  }

  const manifest = loadManifest(manifestPath);
  const entries = filterEntriesForProduct(manifest.entries, product);
  const outDir = path.join(WEB_CONTENT_DOCS, product);
  ensureDir(outDir);

  const written: WrittenPage[] = [];

  for (const entry of entries) {
    const resolvedAbs = resolveOutputPath(entry);
    if (!fs.existsSync(resolvedAbs)) {
      console.warn(
        `  WARN: Skipping missing output file for ${entry.id}: ${path.relative(REPO_ROOT, resolvedAbs)}`,
      );
      continue;
    }

    const raw = fs.readFileSync(resolvedAbs, 'utf8');
    // Compute dest with .md extension first, then rename to .mdx
    const destRelMd = computeDestRelative({ product, entry, resolvedAbs, docsRoot });
    const destRel = destRelMd.replace(/\.md$/, '.mdx');
    const destAbs = path.join(outDir, destRel);
    ensureDir(path.dirname(destAbs));

    const linkedContent = rewriteLinks(raw, resolvedAbs);
    const mdxContent = MDX_IMPORT + transformCodeBlocks(linkedContent);
    fs.writeFileSync(destAbs, mdxContent, 'utf8');

    const slug = slugFromDestRelative(destRel);
    const title = extractTitle(raw, slugToTitle(slug || 'index'));
    written.push({
      type: entry.type,
      slug,
      title,
      path: webPathForSlug(product, slug),
    });
  }

  const sections = SECTION_ORDER.map((type) => {
    const items = written
      .filter((w) => w.type === type)
      .map((w) => ({
        slug: w.slug,
        title: w.title,
        path: w.path,
      }));
    if (items.length === 0) return null;
    return {
      type,
      label: SECTION_LABELS[type],
      items,
    };
  }).filter(Boolean);

  const navFile = { product, sections };
  fs.writeFileSync(path.join(outDir, 'nav.json'), `${JSON.stringify(navFile, null, 2)}\n`, 'utf8');

  return written;
}

function main(): void {
  console.log('sync-docs: repo root =', REPO_ROOT);
  console.log('sync-docs: output dir =', WEB_CONTENT_DOCS);

  fs.rmSync(WEB_CONTENT_DOCS, { recursive: true, force: true });
  ensureDir(WEB_CONTENT_DOCS);

  for (const source of SOURCES) {
    console.log(`sync-docs: syncing ${source.product}...`);
    const pages = syncProduct(source);
    console.log(`sync-docs: ${source.product} — ${pages.length} page(s)`);
  }

  console.log('sync-docs: done.');
}

main();
