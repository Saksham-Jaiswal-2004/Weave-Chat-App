'use client';

import { useChatStore } from '@/store/chat';

/**
 * Everything the app does to get a user's attention: desktop notifications, a
 * short synthesised blip, and the unread count in the tab title.
 *
 * Deliberately framework-free — plain functions over one module-level singleton —
 * so the socket client can call it from outside React. Every browser API touched
 * here is optional at runtime (private mode, an autoplay block, a browser with no
 * Notification support), so nothing in this file is allowed to throw.
 */

export type PermissionState = NotificationPermission | 'unsupported';

const SOUND_KEY = 'weave:sound';
const PROMPT_KEY = 'weave:notify-prompt';

/* ------------------------------------------------------------------ storage */

function readStorage(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode, or storage disabled — the preference just is not sticky */
  }
}

/* -------------------------------------------------------------- permissions */

export function notificationPermission(): PermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  try {
    return Notification.permission;
  } catch {
    return 'unsupported';
  }
}

/** Must be called from a user gesture — browsers reject a bare page-load request. */
export async function requestNotificationPermission(): Promise<PermissionState> {
  if (notificationPermission() === 'unsupported') return 'unsupported';
  try {
    // Legacy Safari resolves the callback form with undefined.
    const result: NotificationPermission | undefined = await Notification.requestPermission();
    return result ?? notificationPermission();
  } catch {
    return 'unsupported';
  }
}

/* ------------------------------------------------------- the prompt's memory */

export function notificationPromptDismissed(): boolean {
  return readStorage(PROMPT_KEY) === 'dismissed';
}

export function dismissNotificationPrompt(): void {
  writeStorage(PROMPT_KEY, 'dismissed');
}

/* -------------------------------------------------------------------- sound */

const SOUND_PEAK_GAIN = 0.06;

/** A rising two-tone blip: short enough to register without ever being a nuisance. */
const TONES = [
  { frequency: 660, at: 0, duration: 0.06 },
  { frequency: 880, at: 0.055, duration: 0.07 },
];

export function soundEnabled(): boolean {
  return readStorage(SOUND_KEY) !== 'off';
}

export function setSoundEnabled(on: boolean): void {
  writeStorage(SOUND_KEY, on ? 'on' : 'off');
}

let audioContext: AudioContext | null = null;

function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const legacy = (window as Window & { webkitAudioContext?: typeof AudioContext })
    .webkitAudioContext;
  return window.AudioContext ?? legacy ?? null;
}

/** One context for the tab's lifetime — creating one per blip exhausts the pool. */
function getAudioContext(): AudioContext | null {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;

  try {
    if (!audioContext) audioContext = new Ctor();
    // Created before the first gesture, a context starts suspended and stays mute.
    if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
    return audioContext;
  } catch {
    audioContext = null;
    return null;
  }
}

/**
 * Synthesises the blip rather than shipping an audio asset — no network, no
 * decode, nothing to cache. A no-op wherever WebAudio is missing or blocked.
 */
export function playMessageSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const start = ctx.currentTime;

    for (const tone of TONES) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const from = start + tone.at;
      const to = from + tone.duration;

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(tone.frequency, from);

      // Ramped in and out, because a raw start/stop on a sine is an audible click.
      gain.gain.setValueAtTime(0.0001, from);
      gain.gain.linearRampToValueAtTime(SOUND_PEAK_GAIN, from + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, to);

      oscillator.connect(gain).connect(ctx.destination);
      oscillator.onended = () => {
        try {
          oscillator.disconnect();
          gain.disconnect();
        } catch {
          /* already torn down */
        }
      };

      oscillator.start(from);
      oscillator.stop(to + 0.01);
    }
  } catch {
    /* autoplay policy, or a context closed underneath us */
  }
}

/* -------------------------------------------------------------- title badge */

let baseTitle: string | null = null;

/** Strips a badge that is already there, so prefixes never compound. */
function stripBadge(title: string): string {
  return title.replace(/^\(\d+\+?\)\s*/, '');
}

export function updateTitleBadge(totalUnread: number): void {
  if (typeof document === 'undefined') return;

  try {
    if (baseTitle === null) baseTitle = stripBadge(document.title);

    const count = Number.isFinite(totalUnread) ? Math.max(0, Math.floor(totalUnread)) : 0;
    document.title = count > 0 ? `(${count > 99 ? '99+' : count}) ${baseTitle}` : baseTitle;
  } catch {
    /* document.title is unwritable in some embedded contexts */
  }
}

/* ----------------------------------------------------------- click handlers */

type ClickHandler = (conversationId: string) => void;

const clickHandlers = new Set<ClickHandler>();

/**
 * The router lives in React and this module does not, so whoever owns navigation
 * registers here instead. Returns an unsubscribe, for effect cleanup.
 */
export function onNotificationClick(handler: ClickHandler): () => void {
  clickHandlers.add(handler);
  return () => {
    clickHandlers.delete(handler);
  };
}

function emitClick(conversationId: string): void {
  for (const handler of clickHandlers) {
    try {
      handler(conversationId);
    } catch {
      /* one bad listener must not stop the others */
    }
  }
}

/* ------------------------------------------------------------------- notify */

export interface NotifyMessageInput {
  conversationId: string;
  title: string;
  body: string;
  /** Mentions pierce a mute — that is the whole point of being @-named. */
  isMention?: boolean;
  muted?: boolean;
  /** Repeats within one thread replace each other instead of stacking. */
  tag?: string;
}

/**
 * The single entry point for "a message just arrived". The caller is responsible
 * for not passing the viewer's own messages.
 */
export function notifyMessage(input: NotifyMessageInput): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const { conversationId, title, body, isMention = false, muted = false, tag } = input;

  // Already looking at the thread: the message is on screen, so anything more is spam.
  const isActive = useChatStore.getState().activeConversationId === conversationId;
  if (!document.hidden && isActive) return;

  if (muted && !isMention) return;

  const wantsSound = soundEnabled();
  if (wantsSound) playMessageSound();

  if (!document.hidden || notificationPermission() !== 'granted') return;

  try {
    const notification = new Notification(title, {
      body,
      tag: tag ?? `weave:${conversationId}`,
      // Our own blip already played; let the OS stay quiet rather than double up.
      silent: wantsSound,
    });

    notification.onclick = () => {
      try {
        window.focus();
        notification.close();
      } catch {
        /* focus can be refused; the navigation below still matters */
      }
      emitClick(conversationId);
    };
  } catch {
    // Some platforms (Chrome on Android) only allow notifications from a service worker.
  }
}
