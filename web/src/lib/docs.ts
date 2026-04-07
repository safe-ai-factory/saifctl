import fs from 'node:fs';
import path from 'node:path';

import matter from 'gray-matter';
import { compileMDX } from 'next-mdx-remote/rsc';
import remarkGfm from 'remark-gfm';

import { DocCodeBlock } from '../components/DocCodeBlock';

export const DOC_PRODUCTS = ['saifctl', 'saifbox', 'saifdocs'] as const;
export type DocProductId = (typeof DOC_PRODUCTS)[number];

export type NavJson = {
  product: string;
  sections: Array<{
    type: 'landing-pages' | 'concepts' | 'how-tos' | 'tutorials' | 'references';
    label: string;
    items: Array<{
      slug: string;
      title: string;
      path: string;
    }>;
  }>;
};

const DOCS_DIR = path.join(process.cwd(), 'src/content/docs');

/** MDX components available inside every doc page. */
const MDX_COMPONENTS = { DocCodeBlock };

export function isDocProductId(s: string): s is DocProductId {
  return (DOC_PRODUCTS as readonly string[]).includes(s);
}

export function getNavForProduct(product: string): NavJson {
  const navPath = path.join(DOCS_DIR, product, 'nav.json');
  const raw = fs.readFileSync(navPath, 'utf8');
  return JSON.parse(raw) as NavJson;
}

export function getAllDocSlugParams(): Array<{ product: string; slug: string[] }> {
  const result: Array<{ product: string; slug: string[] }> = [];
  for (const product of DOC_PRODUCTS) {
    const nav = getNavForProduct(product);
    for (const section of nav.sections) {
      for (const item of section.items) {
        if (item.slug !== '') {
          result.push({ product, slug: item.slug.split('/').filter(Boolean) });
        }
      }
    }
  }
  return result;
}

function extractH1(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : 'Docs';
}

async function compileMdxFile(
  absPath: string,
): Promise<{ title: string; content: React.ReactElement }> {
  const raw = fs.readFileSync(absPath, 'utf8');
  const { content: body } = matter(raw);
  const title = extractH1(body);

  const { content } = await compileMDX({
    source: raw,
    options: {
      mdxOptions: {
        remarkPlugins: [remarkGfm],
      },
      parseFrontmatter: true,
    },
    components: MDX_COMPONENTS,
  });

  return { title, content };
}

export async function renderDocPage(
  product: string,
  slugParts: string[],
): Promise<{ title: string; content: React.ReactElement } | null> {
  if (slugParts.length === 0) return null;
  const absPath = path.join(DOCS_DIR, product, `${slugParts.join('/')}.mdx`);
  if (!fs.existsSync(absPath)) return null;
  return compileMdxFile(absPath);
}

export async function renderIndexPage(
  product: string,
): Promise<{ title: string; content: React.ReactElement } | null> {
  const absPath = path.join(DOCS_DIR, product, 'index.mdx');
  if (!fs.existsSync(absPath)) return null;
  return compileMdxFile(absPath);
}

/** When index.mdx is missing, build a minimal landing from nav.json. */
export async function renderIndexFallback(
  product: string,
): Promise<{ title: string; content: React.ReactElement }> {
  const nav = getNavForProduct(product);
  const links: string[] = [];
  for (const section of nav.sections) {
    for (const item of section.items) {
      if (item.slug !== '') {
        links.push(`- [${item.title}](${item.path})`);
      }
    }
  }
  const list = links.length ? links.join('\n') : '_Documentation is being prepared._';
  const source = `# ${product} documentation\n\n${list}`;

  const { content } = await compileMDX({
    source,
    options: { mdxOptions: { remarkPlugins: [remarkGfm] } },
    components: MDX_COMPONENTS,
  });

  return { title: `${product} documentation`, content };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Re-export for any callers that still reference the old HTML-based API.
// Remove once all pages are migrated.
export { escapeHtml };
