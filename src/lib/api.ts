'use client';

import { currentIdToken } from './firebase';
import type { AvatarColor, Conversation, Message, UserProfile } from '@/types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Thin fetch wrapper that attaches the Firebase ID token. A 401 is retried once
 * with a force-refreshed token, which covers the hour-long token expiry without
 * bouncing the user back to the login screen.
 */
async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const token = await currentIdToken();
  if (!token) throw new ApiError(401, 'You are not signed in.');

  const response = await fetch(path, {
    ...init,
    // Belt and braces with the server's `no-store`: chat state is never re-usable,
    // and a cached reply makes deleted messages and stale reactions reappear.
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });

  if (response.status === 401 && retry) {
    await currentIdToken(true);
    return request<T>(path, init, false);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, payload?.error ?? `Request failed (${response.status}).`);
  }
  return payload as T;
}

const post = <T,>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  syncProfile: (input: { displayName?: string | null; photoURL?: string | null }) =>
    post<{ user: UserProfile }>('/api/session', input),

  /** Settings screen: change display name and avatar colour. */
  updateProfile: (input: { displayName?: string; avatarColor?: AvatarColor | null }) =>
    request<{ user: UserProfile }>('/api/profile', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  /** Revokes refresh tokens, so every other device is signed out. */
  signOutEverywhere: () => post<{ ok: true }>('/api/account/revoke', {}),

  /** Irreversible: removes the profile, the DMs and the Firebase Auth record. */
  deleteAccount: () => request<{ ok: true }>('/api/account', { method: 'DELETE' }),

  searchUsers: (term: string) =>
    request<{ users: UserProfile[] }>(`/api/users/search?q=${encodeURIComponent(term)}`),

  listConversations: () =>
    request<{ conversations: Conversation[]; users: UserProfile[]; onlineUserIds: string[] }>(
      '/api/conversations'
    ),

  createDirect: (userId: string) =>
    post<{ conversation: Conversation; users: UserProfile[]; created: boolean }>(
      '/api/conversations',
      { type: 'dm', userId }
    ),

  createGroup: (name: string, memberIds: string[]) =>
    post<{ conversation: Conversation; users: UserProfile[]; created: boolean }>(
      '/api/conversations',
      { type: 'group', name, memberIds }
    ),

  listMessages: (conversationId: string, before?: number) => {
    const query = before ? `?before=${before}` : '';
    return request<{ conversation: Conversation; messages: Message[]; hasMore: boolean }>(
      `/api/conversations/${conversationId}/messages${query}`
    );
  },

  addMembers: (conversationId: string, memberIds: string[]) =>
    post<{ conversation: Conversation; users: UserProfile[]; added: string[] }>(
      `/api/conversations/${conversationId}/members`,
      { memberIds }
    ),

  leaveConversation: (conversationId: string) =>
    request<{ ok: true; deleted: boolean }>(`/api/conversations/${conversationId}/members`, {
      method: 'DELETE',
    }),

  /** Admin-only. Distinct from leaving, which takes no target. */
  removeMember: (conversationId: string, userId: string) =>
    request<{ conversation: Conversation; users: UserProfile[] }>(
      `/api/conversations/${conversationId}/members?userId=${encodeURIComponent(userId)}`,
      { method: 'DELETE' }
    ),

  renameConversation: (conversationId: string, name: string) =>
    request<{ conversation: Conversation }>(`/api/conversations/${conversationId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  setMuted: (conversationId: string, muted: boolean) =>
    request<{ conversation: Conversation }>(`/api/conversations/${conversationId}`, {
      method: 'PATCH',
      body: JSON.stringify({ muted }),
    }),

  setAdmin: (conversationId: string, userId: string, admin: boolean) =>
    post<{ conversation: Conversation }>(`/api/conversations/${conversationId}/admins`, {
      userId,
      admin,
    }),
};
