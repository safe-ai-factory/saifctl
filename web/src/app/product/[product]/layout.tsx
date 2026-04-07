import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { DocsLayoutClient } from '../../../components/DocsLayoutClient';
import { getNavForProduct, isDocProductId } from '../../../lib/docs';

export default async function ProductDocsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ product: string }>;
}) {
  const { product } = await params;
  if (!isDocProductId(product)) {
    notFound();
  }

  const nav = getNavForProduct(product);

  return <DocsLayoutClient nav={nav}>{children}</DocsLayoutClient>;
}
