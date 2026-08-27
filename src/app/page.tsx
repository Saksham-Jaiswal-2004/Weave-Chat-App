'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { Spinner } from '@/components/Spinner';
import { useAuthStore } from '@/store/auth';

/** Entry point: hand off to the chat shell or the login screen once auth resolves. */
export default function HomePage() {
  const router = useRouter();
  const status = useAuthStore((state) => state.status);

  useEffect(() => {
    if (status === 'authenticated') router.replace('/chat');
    if (status === 'unauthenticated') router.replace('/login');
  }, [status, router]);

  return (
    <main className="flex min-h-full items-center justify-center bg-ink-950">
      <Spinner label="Loading Weave" />
    </main>
  );
}
