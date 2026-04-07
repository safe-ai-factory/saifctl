import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'SaifCTL — Spec-driven software factory',
  description:
    'Write feature specs, and let containerized agents iterate in a zero-trust sandbox until it passes your checks and tests.',
};

export default function SaifctlLayout({ children }: { children: ReactNode }) {
  return children;
}
