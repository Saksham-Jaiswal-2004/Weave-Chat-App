'use client';

import { create } from 'zustand';

export type SocketStatus =
  | 'idle'
  | 'connecting'
  | 'reconnecting'
  /** Socket is open and the ID token has been accepted. */
  | 'ready'
  | 'offline';

interface SocketState {
  status: SocketStatus;
  lastError: string | null;
  setStatus: (status: SocketStatus, lastError?: string | null) => void;
}

export const useSocketStore = create<SocketState>((set) => ({
  status: 'idle',
  lastError: null,
  setStatus: (status, lastError = null) => set({ status, lastError }),
}));
