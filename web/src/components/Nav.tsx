'use client';

import Link from 'next/link';

import { GITHUB_REPO, VSCODE_MARKETPLACE_URL } from '../constants';
import { useWaitlistModal } from './WaitlistModal.context';

const navLinkClass = 'font-mono text-sm text-fg-muted hover:text-fg transition-colors';

export function Nav() {
  const { open: openWaitlist } = useWaitlistModal();

  const vscodeExternal = /^https?:\/\//.test(VSCODE_MARKETPLACE_URL);

  return (
    <nav className="fixed top-0 w-full z-50 border-b border-border bg-bg/80 backdrop-blur-md">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 hover:opacity-90 transition-opacity">
          <img
            src="/logo/saif_512_circ_color.svg"
            alt="Safe AI Factory"
            className="w-16 h-16 shrink-0"
          />
          <span className="font-mono font-bold tracking-tight text-fg">
            Safe <span className="text-accent">AI</span> Factory
          </span>
        </Link>
        <div className="hidden md:flex items-center gap-6">
          <Link href="/saifctl" className={navLinkClass}>
            saifctl
          </Link>
          <Link href="/saifbox" className={navLinkClass}>
            saifbox
          </Link>
          <Link href="/saifdocs" className={navLinkClass}>
            saifdocs
          </Link>
          {vscodeExternal ? (
            <a
              href={VSCODE_MARKETPLACE_URL}
              className={navLinkClass}
              target="_blank"
              rel="noopener noreferrer"
            >
              VSCode Ext
            </a>
          ) : (
            <a
              href={VSCODE_MARKETPLACE_URL}
              className={navLinkClass}
              aria-label="VS Code extension — marketplace link coming soon"
            >
              VSCode Ext
            </a>
          )}
          <a href={GITHUB_REPO} className={navLinkClass} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </div>
        <button
          type="button"
          onClick={openWaitlist}
          className="px-4 py-1.5 bg-accent hover:bg-accent-hover text-bg rounded-md transition-colors font-bold text-sm"
        >
          Join Waitlist
        </button>
      </div>
    </nav>
  );
}
