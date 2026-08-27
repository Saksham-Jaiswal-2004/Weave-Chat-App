import type { Metadata, Viewport } from 'next';

import { AuthProvider } from '@/components/AuthProvider';

import './globals.css';

export const metadata: Metadata = {
  title: 'Weave',
  description: 'A small, fast chat app for direct messages and groups.',
};

export const viewport: Viewport = {
  themeColor: '#0b0c10',
  // No `maximumScale`: capping it blocks pinch-zoom, which fails WCAG 1.4.4. It was
  // here to stop iOS double-scrolling the chat pane, but the shell now pins the
  // document with `overflow-hidden`, so the cap bought nothing and cost access.
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-full antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
