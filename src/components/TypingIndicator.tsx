'use client';

import { useShallow } from 'zustand/react/shallow';

import { useChatStore } from '@/store/chat';

/** The "… is typing" line that sits just above the composer. */
export function TypingIndicator({
  conversationId,
  viewerUid,
}: {
  conversationId: string;
  viewerUid: string;
}) {
  const typingIds = useChatStore(
    useShallow((state) =>
      Object.keys(state.typing[conversationId] ?? {}).filter((uid) => uid !== viewerUid)
    )
  );
  const users = useChatStore((state) => state.users);

  if (typingIds.length === 0) return <div className="h-6" aria-hidden />;

  const names = typingIds.map((uid) => users[uid]?.displayName ?? 'Someone');
  const label =
    names.length === 1
      ? `${names[0]} is typing`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are typing`
        : `${names[0]} and ${names.length - 1} others are typing`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-6 items-center gap-2 px-4 text-xs text-mist-400 sm:px-7"
    >
      <span className="flex items-center gap-1" aria-hidden>
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="typing-dot h-1.5 w-1.5 rounded-full bg-mist-400"
            style={{ animationDelay: `${index * 160}ms` }}
          />
        ))}
      </span>
      {label}
    </div>
  );
}
