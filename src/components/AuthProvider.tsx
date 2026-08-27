'use client';

import { onIdTokenChanged } from 'firebase/auth';
import { useEffect, useRef } from 'react';

import { api } from '@/lib/api';
import { firebaseAuth, firebaseConfigured } from '@/lib/firebase';
import { socket } from '@/lib/socket-client';
import { useAuthStore } from '@/store/auth';
import { useChatStore } from '@/store/chat';

const TYPING_SWEEP_MS = 2_000;

/**
 * Bridges Firebase Auth into the stores and owns the socket lifecycle: sign in
 * opens the connection, sign out tears it down and clears the cache.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Token refreshes re-fire this listener hourly; only mirror the profile once.
  const syncedUid = useRef<string | null>(null);

  useEffect(() => {
    if (!firebaseConfigured) {
      useAuthStore.setState({ status: 'unauthenticated', user: null });
      return;
    }

    const unsubscribe = onIdTokenChanged(firebaseAuth(), async (firebaseUser) => {
      if (!firebaseUser) {
        syncedUid.current = null;
        socket.disconnect();
        useChatStore.getState().reset();
        useAuthStore.getState().setUser(null);
        return;
      }

      const fallbackName = firebaseUser.email?.split('@')[0] ?? 'Someone';
      useAuthStore.getState().setUser({
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        displayName: firebaseUser.displayName || fallbackName,
        photoURL: firebaseUser.photoURL,
        // Firebase Auth knows nothing about this; the directory sync below fills it.
        avatarColor: useAuthStore.getState().user?.avatarColor ?? null,
      });

      socket.connect();

      if (syncedUid.current === firebaseUser.uid) return;
      syncedUid.current = firebaseUser.uid;

      try {
        const { user } = await api.syncProfile({
          displayName: firebaseUser.displayName,
          photoURL: firebaseUser.photoURL,
        });
        useAuthStore.getState().patchUser({
          displayName: user.displayName,
          photoURL: user.photoURL,
          avatarColor: user.avatarColor,
        });
        useChatStore.getState().cacheUsers([user]);
      } catch (error) {
        // Not fatal — the next sign-in retries. But a failure here means this
        // account was never written to the directory and nobody can find it in
        // search, so it must not pass silently.
        syncedUid.current = null;
        console.error('[weave] could not sync your profile to the directory:', error);
      }
    });

    return () => unsubscribe();
  }, []);

  // Expire "is typing…" bubbles whose owner went quiet or disconnected.
  useEffect(() => {
    const timer = setInterval(() => useChatStore.getState().pruneTyping(), TYPING_SWEEP_MS);
    return () => clearInterval(timer);
  }, []);

  return <>{children}</>;
}
