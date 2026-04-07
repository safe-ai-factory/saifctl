'use client';

import { ChevronRight } from 'lucide-react';

import { GITHUB_REPO } from '../constants';
import { track } from '../lib/analytics';
import { Footer } from './Footer';
import { Nav } from './Nav';
import { useWaitlistModal } from './WaitlistModal.context';

const PRODUCTS = [
  {
    href: '/saifctl',
    name: 'saifctl',
    tagline: 'Software Factory',
    description:
      'Write feature specs, and let containerized agents iterate until your tests pass. SaifCTL is the verification engine — language-agnostic, agent-agnostic, safe by design.',
    cta: 'Explore saifctl',
  },
  {
    href: '/saifbox',
    name: 'saifbox',
    tagline: 'Safe Agent Sandbox',
    description:
      'Run any agent CLI — OpenClaw, Claude Code, anything — inside an ephemeral Docker sandbox. One command. Any agent. Any language. No host access.',
    cta: 'Explore saifbox',
  },
  {
    href: '/saifdocs',
    name: 'saifdocs',
    tagline: 'AI Documentation Engine',
    description:
      'Generate grounded, persona-driven documentation from your codebase. saifdocs runs a proof-of-concept before writing a single word, so docs reflect what your code actually does.',
    cta: 'Explore saifdocs',
  },
] as const;

export function Home() {
  const { open: openWaitlist } = useWaitlistModal();

  return (
    <div className="min-h-screen bg-bg text-fg selection:bg-accent selection:text-bg overflow-x-hidden">
      <Nav />

      <main className="pt-24 pb-24">
        <section className="max-w-6xl mx-auto px-6 mb-20 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-surface border border-border mb-6">
            <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            <span className="text-xs font-mono text-fg-muted">Alpha Available Soon</span>
          </div>

          <h1 className="text-5xl md:text-7xl font-bold tracking-tighter text-fg mb-6 leading-tight font-mono">
            Safe <span className="text-accent">AI</span> Factory
          </h1>

          <p className="text-lg md:text-xl text-fg-muted mb-4 max-w-2xl mx-auto leading-relaxed">
            Three tools. One mission: AI that can&apos;t cheat, leak, or wreak havoc.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-10">
            <button
              type="button"
              onClick={openWaitlist}
              className="px-6 py-3 bg-accent hover:bg-accent-hover text-bg font-bold rounded-md transition-colors"
            >
              Join Waitlist
            </button>
            <a
              href={GITHUB_REPO}
              target="_blank"
              rel="noopener noreferrer"
              className="px-6 py-3 border border-border text-fg hover:border-link hover:text-link rounded-md transition-all flex items-center gap-2"
              onClick={() => track('outbound_click', { destination: 'github_repo' })}
            >
              ★ Star on GitHub
            </a>
          </div>
        </section>

        <section className="max-w-6xl mx-auto px-6">
          <div className="grid md:grid-cols-3 gap-6">
            {PRODUCTS.map((p) => (
              <div key={p.href} className="p-8 rounded-xl card-link-tint">
                <p className="text-fg-subtle text-xs font-mono uppercase tracking-widest mb-3">
                  {p.tagline}
                </p>
                <h2 className="font-mono font-bold text-fg text-xl mb-4">{p.name}</h2>
                <p className="text-fg-muted text-sm leading-relaxed mb-6">{p.description}</p>
                <a
                  href={p.href}
                  className="text-link hover:text-link-hover text-sm hover:underline flex items-center gap-1"
                >
                  {p.cta} <ChevronRight className="w-4 h-4" />
                </a>
              </div>
            ))}
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
