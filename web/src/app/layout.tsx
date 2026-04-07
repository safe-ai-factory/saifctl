import './globals.css';
import 'highlight.js/styles/tokyo-night-dark.css';
import '../components/DocCodeBlock.css';

import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import PlausibleProvider from 'next-plausible';

import { Mascot } from '../components/Mascot/Mascot';
import { WaitlistModalProvider } from '../components/WaitlistModal.context';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Safe AI Factory',
  description: "Open-source tools for autonomous AI agents that can't cheat, leak, or wreak havoc.",
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '16x16 32x32', type: 'image/x-icon' },
      { url: '/logo/saif_512_circ_color.svg', type: 'image/svg+xml' },
    ],
    apple: '/logo/apple-touch-icon.png',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const domain = process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN ?? '';

  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-bg text-fg font-sans selection:bg-accent selection:text-bg`}
      >
        <PlausibleProvider domain={domain} trackOutboundLinks enabled={!!domain}>
          <WaitlistModalProvider>{children}</WaitlistModalProvider>
        </PlausibleProvider>
        <Mascot />
      </body>
    </html>
  );
}
