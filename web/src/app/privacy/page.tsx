import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy Policy | SaifCTL',
  description: 'Privacy Policy for SaifCTL.',
};

async function getPolicyHtml(): Promise<string> {
  const filePath = path.join(process.cwd(), 'src', 'content', 'policy.html');
  return readFile(filePath, 'utf-8');
}

export default async function PrivacyPage() {
  const policyHtml = await getPolicyHtml();

  return (
    <div className="min-h-screen bg-bg text-fg selection:bg-accent selection:text-bg">
      {/* Minimal header */}
      <header className="fixed top-0 w-full z-50 border-b border-border bg-bg/80 backdrop-blur-md">
        <div className="max-w-4xl mx-auto px-6 h-16 flex items-center justify-between">
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
          <Link href="/" className="text-sm text-fg-muted hover:text-fg transition-colors">
            ← Back
          </Link>
        </div>
      </header>

      {/* Policy content - dark theme overrides for Termly styles */}
      <main className="pt-24 pb-16 px-6">
        <div className="max-w-3xl mx-auto mb-12 border-b border-border pb-8">
          <h1 className="text-3xl font-bold text-fg mb-6">Privacy Policy</h1>

          <div className="bg-surface border border-border rounded-lg p-6 font-mono text-sm text-fg-muted leading-relaxed">
            <h2 className="text-fg font-bold mb-3 font-sans text-base">
              Data Controller Identification
            </h2>
            <p>
              The website <span className="text-fg">safeaifactory.com</span> and its associated
              services are operated by:
            </p>
            <ul className="mt-3 space-y-1 list-disc list-inside">
              <li>
                <strong className="text-fg-muted">Name:</strong> Juraj Oravec
              </li>
              <li>
                <strong className="text-fg-muted">IČO:</strong> 23711434
              </li>
              <li>
                <strong className="text-fg-muted">Registered Address:</strong> Varšavská 345/40,
                Vinohrady, 120 00 Praha 2, Czech Republic
              </li>
              <li>
                <strong className="text-fg-muted">Registry:</strong> Zapsán v živnostenském
                rejstříku
              </li>
              <li>
                <strong className="text-fg-muted">Contact Email:</strong>{' '}
                <a
                  href="mailto:juraj.oravec.josefson@gmail.com"
                  className="text-link hover:text-link-hover hover:underline transition-colors"
                >
                  juraj.oravec.josefson@gmail.com
                </a>
              </li>
            </ul>
            <p className="mt-4 text-xs text-fg-subtle">
              For any questions regarding data privacy or to exercise your GDPR rights, please
              contact the email address above.
            </p>
          </div>
        </div>

        <article
          className="max-w-3xl mx-auto privacy-policy prose prose-invert prose-headings:text-fg prose-p:text-fg-muted prose-a:text-link prose-a:no-underline hover:prose-a:underline hover:prose-a:text-link-hover"
          dangerouslySetInnerHTML={{ __html: policyHtml }}
        />
      </main>

      <style
        dangerouslySetInnerHTML={{
          __html: `
          .privacy-policy [data-custom-class='body_text'],
          .privacy-policy [data-custom-class='body_text'] * {
            color: #9ca3af !important;
          }
          .privacy-policy [data-custom-class='title'],
          .privacy-policy [data-custom-class='title'] * {
            color: #fff !important;
          }
          .privacy-policy [data-custom-class='subtitle'],
          .privacy-policy [data-custom-class='subtitle'] * {
            color: #6b7280 !important;
          }
          .privacy-policy [data-custom-class='heading_1'],
          .privacy-policy [data-custom-class='heading_1'] * {
            color: #fff !important;
          }
          .privacy-policy [data-custom-class='heading_2'],
          .privacy-policy [data-custom-class='heading_2'] * {
            color: #e5e7eb !important;
          }
          .privacy-policy [data-custom-class='link'],
          .privacy-policy [data-custom-class='link'] * {
            color: var(--c-link) !important;
          }
          .privacy-policy span[style*="color: rgb(89, 89, 89)"] {
            color: var(--c-fg-muted) !important;
          }
          .privacy-policy a[href^="mailto:"] {
            color: var(--c-link) !important;
          }
        `,
        }}
      />
    </div>
  );
}
