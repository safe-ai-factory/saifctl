import type { Metadata } from 'next';

import { Home } from '../components/Home';

export const metadata: Metadata = {
  title: 'Safe AI Factory — Tools for safe, autonomous AI agents',
  description:
    'Three open-source tools for teams building with autonomous AI: saifctl, saifbox, and saifdocs.',
};

export default function HomePage() {
  return <Home />;
}
