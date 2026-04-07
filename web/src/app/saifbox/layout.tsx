import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'saifbox — Safe sandbox for any AI agent',
  description:
    'Run any agent CLI inside an ephemeral Docker sandbox. One command. Any agent. Any language. Zero host access.',
};

export default function SaifboxLayout({ children }: { children: ReactNode }) {
  return children;
}
