'use client';

import { ChevronRight } from 'lucide-react';

import { Footer } from '../../components/Footer';
import { Nav } from '../../components/Nav';
import { useWaitlistModal } from '../../components/WaitlistModal.context';
import { GITHUB_REPO } from '../../constants';
import { track } from '../../lib/analytics';

const HIGHLIGHTS = [
  {
    icon: '🐳',
    title: 'Any agent, one command',
    body: (
      <>
        Run OpenClaw, Claude Code, or any other agent CLI inside an isolated container. No config
        beyond what you already have.
        <div className="mt-4 bg-bg border border-border rounded-md p-4 font-mono text-xs text-accent">
          <span className="text-fg-subtle">$ </span>saifbox run openclaw &quot;refactor this
          module&quot;
        </div>
      </>
    ),
  },
  {
    icon: '🔒',
    title: 'Zero host access',
    body: (
      <>
        The agent can&apos;t read your <code className="text-accent">.env</code>, your{' '}
        <code className="text-accent">~/.aws</code>, or anything outside the project directory.
        Sandboxed at the filesystem and network level.
      </>
    ),
  },
  {
    icon: '🔄',
    title: 'Use any LLM provider',
    body: 'Pass --model to switch providers mid-project. Not locked into one vendor. Not locked into one agent.',
  },
] as const;

export default function SaifboxPage() {
  const { open: openWaitlist } = useWaitlistModal();

  return (
    <div className="min-h-screen bg-bg text-fg selection:bg-accent selection:text-bg overflow-x-hidden">
      <Nav />

      <main className="pt-24 pb-24">
        <section className="max-w-4xl mx-auto px-6 mb-20 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-surface border border-border mb-6">
            <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            <span className="text-xs font-mono text-fg-muted">Alpha Available Soon</span>
          </div>

          <h1 className="text-5xl md:text-6xl font-bold tracking-tighter text-fg mb-6 leading-tight">
            Run any agent. Safe by default.
          </h1>

          <p className="text-lg text-fg-muted mb-10 max-w-2xl mx-auto leading-relaxed">
            saifbox wraps any agent CLI — OpenClaw, Claude Code, anything — in an ephemeral Docker
            sandbox. Your host is untouched. Your secrets stay yours.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 flex-wrap">
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
              className="px-6 py-3 border border-border text-fg hover:border-link hover:text-link rounded-md transition-all"
              onClick={() => track('outbound_click', { destination: 'github_repo' })}
            >
              ★ Star on GitHub
            </a>
            <a
              href="/product/saifbox"
              className="px-6 py-3 text-link hover:text-link-hover hover:underline text-sm font-medium flex items-center gap-1 transition-colors"
            >
              View docs <ChevronRight className="w-4 h-4" />
            </a>
          </div>
        </section>

        <section className="max-w-6xl mx-auto px-6 mb-20">
          <div className="grid md:grid-cols-3 gap-6">
            {HIGHLIGHTS.map((h) => (
              <div key={h.title} className="p-8 border border-border rounded-xl bg-surface">
                <div className="text-3xl mb-4">{h.icon}</div>
                <h2 className="font-bold text-fg text-lg mb-3">{h.title}</h2>
                <div className="text-fg-muted text-sm leading-relaxed">{h.body}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-2xl font-bold text-fg mb-6">Ready to run agents safely?</h2>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
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
              className="text-link hover:text-link-hover hover:underline text-sm transition-colors"
            >
              Star on GitHub →
            </a>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
