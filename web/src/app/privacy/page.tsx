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
    <div className="min-h-screen bg-[#0F0F0F] text-gray-200 selection:bg-[#00FF66] selection:text-black">
      {/* Minimal header */}
      <header className="fixed top-0 w-full z-50 border-b border-[#333] bg-[#0F0F0F]/80 backdrop-blur-md">
        <div className="max-w-4xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 hover:opacity-90 transition-opacity">
            <img src="/saifctl-icon-green.svg" alt="SaifCTL" className="w-6 h-6 shrink-0" />
            <span className="font-mono font-bold tracking-tight text-white">SaifCTL</span>
          </Link>
          <Link href="/" className="text-sm text-gray-400 hover:text-white transition-colors">
            ← Back
          </Link>
        </div>
      </header>

      {/* Policy content - dark theme overrides for Termly styles */}
      <main className="pt-24 pb-16 px-6">
        <div className="max-w-3xl mx-auto mb-12 border-b border-[#333] pb-8">
          <h1 className="text-3xl font-bold text-white mb-6">Privacy Policy</h1>

          <div className="bg-[#111] border border-[#333] rounded-lg p-6 font-mono text-sm text-gray-400 leading-relaxed">
            <h2 className="text-white font-bold mb-3 font-sans text-base">
              Data Controller Identification
            </h2>
            <p>
              The website <span className="text-white">safeaifactory.com</span> and its associated
              services are operated by:
            </p>
            <ul className="mt-3 space-y-1 list-disc list-inside">
              <li>
                <strong className="text-gray-300">Name:</strong> Juraj Oravec
              </li>
              <li>
                <strong className="text-gray-300">IČO:</strong> 23711434
              </li>
              <li>
                <strong className="text-gray-300">Registered Address:</strong> Varšavská 345/40,
                Vinohrady, 120 00 Praha 2, Czech Republic
              </li>
              <li>
                <strong className="text-gray-300">Registry:</strong> Zapsán v živnostenském
                rejstříku
              </li>
              <li>
                <strong className="text-gray-300">Contact Email:</strong>{' '}
                <a
                  href="mailto:juraj.oravec.josefson@gmail.com"
                  className="text-[#00FF66] hover:underline"
                >
                  juraj.oravec.josefson@gmail.com
                </a>
              </li>
            </ul>
            <p className="mt-4 text-xs text-gray-500">
              For any questions regarding data privacy or to exercise your GDPR rights, please
              contact the email address above.
            </p>
          </div>
        </div>

        <article
          className="max-w-3xl mx-auto privacy-policy prose prose-invert prose-headings:text-white prose-p:text-gray-400 prose-a:text-[#00FF66] prose-a:no-underline hover:prose-a:underline"
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
            color: #00ff66 !important;
          }
          .privacy-policy span[style*="color: rgb(89, 89, 89)"] {
            color: #9ca3af !important;
          }
          .privacy-policy a[href^="mailto:"] {
            color: #00ff66 !important;
          }
        `,
        }}
      />
    </div>
  );
}
