import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'saifdocs — AI documentation engine for real codebases',
  description:
    'Generate grounded documentation from your codebase. saifdocs runs a PoC before writing a word.',
};

export default function SaifdocsLayout({ children }: { children: ReactNode }) {
  return children;
}
