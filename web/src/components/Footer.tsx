import Link from 'next/link';

import { GITHUB_REPO } from '../constants';

const GITHUB_AUTHOR = 'https://github.com/JuroOravec';
const GITHUB_CHANGELOG_URL = `${GITHUB_REPO}/releases`;

export function Footer() {
  const year = new Date().getFullYear();
  const copyrightYear = year === 2026 ? '2026' : `2026-${year}`;

  return (
    <footer className="border-t border-border py-16">
      <div className="max-w-6xl mx-auto px-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-12">
          <div>
            <div className="flex items-center gap-2 mb-4">
              <img
                src="/logo/saif_512_circ_color.svg"
                alt="Safe AI Factory"
                className="w-16 h-16 shrink-0"
              />
              <span className="font-mono font-bold text-fg">
                Safe <span className="text-accent">AI</span> Factory
              </span>
            </div>
            <p className="text-fg-subtle text-sm leading-relaxed mb-4">
              Open-source tools for autonomous AI agents that can&apos;t cheat, leak, or wreak
              havoc.
            </p>
            <a
              href={GITHUB_REPO}
              className="text-link hover:text-link-hover text-sm hover:underline transition-colors"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub →
            </a>
          </div>
          <div>
            <h4 className="font-bold text-fg text-sm mb-4">Products</h4>
            <ul className="space-y-2 text-sm text-fg-subtle">
              <li>
                <Link href="/saifctl" className="hover:text-fg transition-colors">
                  saifctl
                </Link>
              </li>
              <li>
                <Link href="/saifbox" className="hover:text-fg transition-colors">
                  saifbox
                </Link>
              </li>
              <li>
                <Link href="/saifdocs" className="hover:text-fg transition-colors">
                  saifdocs
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="font-bold text-fg text-sm mb-4">Learn More</h4>
            <ul className="space-y-2 text-sm text-fg-subtle">
              <li>
                <Link href="/product/saifctl" className="hover:text-fg transition-colors">
                  Docs
                </Link>
              </li>
              <li>
                <Link
                  href="/product/saifctl/references/commands/doctor"
                  className="hover:text-fg transition-colors"
                >
                  CLI Reference
                </Link>
              </li>
              <li>
                <a
                  href={GITHUB_CHANGELOG_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-fg transition-colors"
                >
                  Changelog
                </a>
              </li>
              <li>
                <a
                  href={GITHUB_REPO}
                  className="hover:text-fg transition-colors"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  GitHub
                </a>
              </li>
              <li>
                <Link href="/privacy" className="hover:text-fg transition-colors">
                  Privacy Policy
                </Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="border-t border-border pt-8 text-center text-xs text-fg-subtle font-mono">
          © {copyrightYear} Made by{' '}
          <a
            href={GITHUB_AUTHOR}
            target="_blank"
            rel="noopener noreferrer"
            className="text-link hover:text-link-hover hover:underline transition-colors"
          >
            Juro Oravec
          </a>
        </div>
      </div>
    </footer>
  );
}
