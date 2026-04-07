import type { ReactNode } from 'react';

import { Footer } from '../../components/Footer';
import { Nav } from '../../components/Nav';

export default function ProductLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-fg flex flex-col">
      <Nav />
      <div className="pt-16 flex-1">{children}</div>
      <Footer />
    </div>
  );
}
