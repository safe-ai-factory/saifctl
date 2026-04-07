import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { DocContent } from '../../../../components/DocContent';
import { getAllDocSlugParams, renderDocPage } from '../../../../lib/docs';

export async function generateStaticParams() {
  return getAllDocSlugParams();
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ product: string; slug: string[] }>;
}): Promise<Metadata> {
  const { product, slug } = await params;
  const page = await renderDocPage(product, slug);
  const title = page?.title ?? slug.join('/');
  return {
    title: `${title} — ${product} docs`,
    description: `${title} — ${product} documentation.`,
  };
}

export default async function DocSlugPage({
  params,
}: {
  params: Promise<{ product: string; slug: string[] }>;
}) {
  const { product, slug } = await params;
  const page = await renderDocPage(product, slug);
  if (!page) notFound();

  return <DocContent content={page.content} />;
}
