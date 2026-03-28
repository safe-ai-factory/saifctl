import './globals.css';

import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import PlausibleProvider from 'next-plausible';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'SaifCTL',
  description: 'Zero-trust orchestrator for containerized AI swarms.',
  icons: {
    icon: '/saifctl-icon-green.svg',
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
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[#0F0F0F] text-white font-sans selection:bg-[#00FF66] selection:text-black`}
      >
        <PlausibleProvider domain={domain} trackOutboundLinks enabled={!!domain}>
          {children}
        </PlausibleProvider>
      </body>
    </html>
  );
}
