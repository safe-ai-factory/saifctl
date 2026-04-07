import type { Metadata } from 'next';

import { DocContent } from '../../../components/DocContent';
import { DOC_PRODUCTS, renderIndexFallback, renderIndexPage } from '../../../lib/docs';

export async function generateStaticParams() {
  return DOC_PRODUCTS.map((product) => ({ product }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ product: string }>;
}): Promise<Metadata> {
  const { product } = await params;
  const index = await renderIndexPage(product);
  const title = index?.title ?? `${product} documentation`;
  return {
    title: `${title} — Docs`,
    description: `${title} — ${product} product documentation on Safe AI Factory.`,
  };
}

export default async function ProductIndexPage({
  params,
}: {
  params: Promise<{ product: string }>;
}) {
  const { product } = await params;
  let page = await renderIndexPage(product);
  if (!page) {
    page = await renderIndexFallback(product);
  }

  return <DocContent content={page.content} />;
}
