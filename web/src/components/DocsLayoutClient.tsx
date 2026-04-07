'use client';

import { Menu, X } from 'lucide-react';
import { useState } from 'react';

import type { NavJson } from '../lib/docs';
import { DocSidebar } from './DocSidebar';

export function DocsLayoutClient({ nav, children }: { nav: NavJson; children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="max-w-[1400px] mx-auto flex min-h-[calc(100vh-4rem)]">
      <aside className="hidden md:block w-64 shrink-0 border-r border-border px-4 py-8 sticky top-16 h-[calc(100vh-4rem)] overflow-y-auto">
        <DocSidebar nav={nav} />
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="md:hidden sticky top-16 z-30 flex items-center gap-2 border-b border-border bg-bg/95 backdrop-blur px-4 py-3">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-fg-muted hover:border-accent hover:text-fg"
            aria-expanded={mobileOpen}
            aria-controls="docs-mobile-drawer"
          >
            <Menu className="w-4 h-4" aria-hidden />
            Menu
          </button>
        </div>

        {mobileOpen ? (
          <div className="fixed inset-0 z-40 md:hidden" id="docs-mobile-drawer">
            <button
              type="button"
              className="absolute inset-0 bg-black/60"
              aria-label="Close menu"
              onClick={() => setMobileOpen(false)}
            />
            <div className="absolute left-0 top-0 bottom-0 w-[min(20rem,85vw)] border-r border-border bg-bg overflow-y-auto px-4 py-8 shadow-xl">
              <div className="flex justify-end mb-4">
                <button
                  type="button"
                  onClick={() => setMobileOpen(false)}
                  className="rounded-md p-2 text-fg-muted hover:text-fg border border-border"
                  aria-label="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <DocSidebar nav={nav} onNavigate={() => setMobileOpen(false)} />
            </div>
          </div>
        ) : null}

        <main className="flex-1 min-w-0 px-6 md:px-8 py-10 md:py-12 max-w-3xl">{children}</main>
      </div>
    </div>
  );
}
