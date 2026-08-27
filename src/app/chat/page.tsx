'use client';

import { GroupIcon, PlusIcon, WeaveMark } from '@/components/Icons';

/** Shown on wide screens when no conversation is selected. */
export default function ChatIndexPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-ink-850 px-6 py-10 text-center">
      <span
        aria-hidden
        className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-ink-800 text-weave-400"
      >
        <WeaveMark className="h-8 w-8" />
      </span>
      <h2 className="text-lg font-semibold">Pick up a conversation</h2>
      <p className="mt-1.5 max-w-sm text-sm text-mist-400">
        Nothing is open yet. Choose a chat from the list on the left, or start a new one.
      </p>

      {/* The two buttons live in the sidebar header, which is easy to miss when the
          pane is empty — name them and show the glyph so they can be found. */}
      <ul className="mt-6 max-w-xs space-y-2.5 text-left">
        <Hint icon={<PlusIcon className="h-4 w-4" />}>
          <strong className="font-medium text-mist-200">New chat</strong> — the{' '}
          <span aria-hidden>+</span> button above the list — to message one person.
        </Hint>
        <Hint icon={<GroupIcon className="h-4 w-4" />}>
          <strong className="font-medium text-mist-200">New group</strong> — next to it — to start a
          conversation with several people.
        </Hint>
      </ul>
    </div>
  );
}

function Hint({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 text-sm text-mist-400">
      <span
        aria-hidden
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ink-800 text-mist-200"
      >
        {icon}
      </span>
      <span className="leading-relaxed">{children}</span>
    </li>
  );
}
