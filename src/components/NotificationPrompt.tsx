'use client';

import type { SVGProps } from 'react';
import { useEffect, useState } from 'react';

import { CloseIcon } from '@/components/Icons';
import {
  dismissNotificationPrompt,
  notificationPermission,
  notificationPromptDismissed,
  playMessageSound,
  requestNotificationPermission,
  setSoundEnabled,
  soundEnabled,
} from '@/lib/notifications';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------- icons */

const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  viewBox: '0 0 24 24',
};

type IconProps = SVGProps<SVGSVGElement>;

const BellIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6Z" />
    <path d="M13.7 19a2 2 0 0 1-3.4 0" />
  </svg>
);

const SpeakerOnIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" />
    <path d="M15 9.5a3.5 3.5 0 0 1 0 5M17.8 6.7a7.5 7.5 0 0 1 0 10.6" />
  </svg>
);

const SpeakerOffIcon = (props: IconProps) => (
  <svg {...base} {...props}>
    <path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" />
    <path d="m16 10 4 4m0-4-4 4" />
  </svg>
);

/* ------------------------------------------------------------------- prompt */

/**
 * Asks once, quietly. Permission can only be requested from a gesture, so this
 * bar exists purely to provide one — and it never comes back after a dismissal.
 */
export function NotificationPrompt() {
  // Decided after mount: permission and localStorage do not exist on the server,
  // so rendering nothing first keeps hydration honest.
  const [visible, setVisible] = useState(false);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    setVisible(notificationPermission() === 'default' && !notificationPromptDismissed());
  }, []);

  if (!visible) return null;

  async function enable() {
    if (asking) return;
    setAsking(true);

    const result = await requestNotificationPermission();

    setAsking(false);
    // Anything but a dismissed browser prompt is a settled answer.
    if (result !== 'default') {
      dismissNotificationPrompt();
      setVisible(false);
    }
  }

  function dismiss() {
    dismissNotificationPrompt();
    setVisible(false);
  }

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-ink-800 bg-ink-850 px-4 py-1 text-xs text-mist-200"
    >
      <BellIcon className="h-3.5 w-3.5 shrink-0 text-mist-400" />
      <span className="min-w-0 flex-1 truncate">
        Get notified when a message arrives while Weave is in the background.
      </span>

      <button
        type="button"
        onClick={() => void enable()}
        disabled={asking}
        className="min-h-11 shrink-0 rounded-md bg-weave-500 px-3 font-medium text-white transition-colors hover:bg-weave-400 disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none"
      >
        {asking ? 'Waiting…' : 'Enable'}
      </button>

      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="-mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-mist-500 transition-colors hover:bg-ink-800 hover:text-mist-200 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none"
      >
        <CloseIcon aria-hidden className="h-4 w-4" />
      </button>
    </div>
  );
}

/* -------------------------------------------------------------- sound toggle */

/** Flips the message blip on or off. Enabling previews the sound. */
export function SoundToggle({ className }: { className?: string }) {
  const [on, setOn] = useState(true);

  useEffect(() => {
    setOn(soundEnabled());
  }, []);

  function toggle() {
    const next = !on;
    setOn(next);
    setSoundEnabled(next);
    // The click is a gesture, so this doubles as unlocking the AudioContext.
    if (next) playMessageSound();
  }

  const label = on ? 'Message sound on' : 'Message sound off';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={on}
      aria-label={label}
      title={label}
      className={cn(
        'rounded-lg p-2 text-mist-400 transition-colors hover:bg-ink-800 hover:text-mist-50',
        className
      )}
    >
      {on ? (
        <SpeakerOnIcon className="h-[18px] w-[18px]" />
      ) : (
        <SpeakerOffIcon className="h-[18px] w-[18px]" />
      )}
    </button>
  );
}
