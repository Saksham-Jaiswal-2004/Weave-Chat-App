'use client';

import { use } from 'react';

import { ChatPane } from '@/components/ChatPane';

export default function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = use(params);
  return <ChatPane conversationId={conversationId} />;
}
