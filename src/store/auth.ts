'use client';

import { create } from 'zustand';

import type { AvatarColor } from '@/types';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface SessionUser {
  uid: string;
  email: string | null;
  displayName: string;
  photoURL: string | null;
  avatarColor: AvatarColor | null;
}

interface AuthState {
  status: AuthStatus;
  user: SessionUser | null;
  setUser: (user: SessionUser | null) => void;
  patchUser: (patch: Partial<SessionUser>) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'loading',
  user: null,

  setUser: (user) => set({ user, status: user ? 'authenticated' : 'unauthenticated' }),

  patchUser: (patch) =>
    set((state) => (state.user ? { user: { ...state.user, ...patch } } : state)),
}));

/** Read the signed-in uid outside of React (socket client, event handlers). */
export const currentUid = () => useAuthStore.getState().user?.uid ?? null;
