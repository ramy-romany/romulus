import './globals.css';
import type { Metadata, Viewport } from 'next';

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://romulus.pages.dev';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'Romulus Poker',
  description: "Private dealer's choice poker for mixed home games.",
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/romulus-icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  openGraph: {
    title: 'Romulus Poker',
    description: "Private dealer's choice poker for mixed home games.",
    type: 'website',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'Romulus Poker' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Romulus Poker',
    description: "Private dealer's choice poker for mixed home games.",
    images: ['/og-image.png'],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#07140f',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
