'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import type { NavJson } from '../lib/docs';

type DocSidebarProps = {
  nav: NavJson;
  onNavigate?: () => void;
};

export function DocSidebar({ nav, onNavigate }: DocSidebarProps) {
  const pathname = usePathname();
  const productPath = `/product/${nav.product}`;

  const landingSection = nav.sections.find((s) => s.type === 'landing-pages');
  const landingItem = landingSection?.items[0];

  return (
    <nav className="space-y-1" aria-label="Documentation">
      <div className="mb-6 px-3">
        <Link
          href={productPath}
          onClick={onNavigate}
          className="flex items-center gap-2 font-mono font-bold text-fg hover:text-accent transition-colors text-sm"
        >
          <span>{nav.product}</span>
        </Link>
      </div>

      {landingItem ? (
        <div className="mb-4">
          <Link
            href={landingItem.path}
            onClick={onNavigate}
            className={`block px-3 py-1.5 text-sm rounded transition-colors ${
              pathname === landingItem.path
                ? 'text-accent bg-accent-dim font-medium'
                : 'text-fg-muted hover:text-fg'
            }`}
          >
            {landingItem.title}
          </Link>
        </div>
      ) : null}

      {nav.sections
        .filter((s) => s.type !== 'landing-pages')
        .map((section) => (
          <div key={section.type}>
            <div className="text-xs font-mono uppercase tracking-widest text-fg-subtle mt-6 mb-2 px-3 first:mt-0">
              {section.label}
            </div>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = pathname === item.path;
                return (
                  <li key={item.path}>
                    <Link
                      href={item.path}
                      onClick={onNavigate}
                      className={`block px-3 py-1.5 text-sm md:text-xs rounded transition-colors ${
                        active
                          ? 'text-accent bg-accent-dim font-medium'
                          : 'text-fg-muted hover:text-fg'
                      }`}
                    >
                      {item.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
    </nav>
  );
}
