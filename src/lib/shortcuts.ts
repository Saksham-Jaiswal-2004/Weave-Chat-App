/**
 * One window-level keydown listener for the whole app. Each surface registering its
 * own listener made the rules ("does Escape close the composer or the dialog?")
 * impossible to reason about, so the combos live here and the shell owns the handlers.
 */

export interface ShortcutHandlers {
  /** Ctrl/Cmd+F — in-thread search. */
  onSearch?: () => void;
  /** Ctrl/Cmd+K — new conversation. */
  onNewChat?: () => void;
  /** Alt+ArrowDown */
  onNextChat?: () => void;
  /** Alt+ArrowUp */
  onPrevChat?: () => void;
  onEscape?: () => void;
  /** "?" — the shortcuts dialog. */
  onHelp?: () => void;
}

/** Labels only — the combos themselves match `metaKey || ctrlKey`, so both work either way. */
function isApplePlatform() {
  if (typeof navigator === 'undefined') return false;
  const source = navigator.platform || navigator.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(source);
}

const MOD_LABEL = isApplePlatform() ? '⌘' : 'Ctrl';
const ALT_LABEL = isApplePlatform() ? '⌥' : 'Alt';

/** Rendered by ShortcutsDialog. Space-separated so each key can become its own chip. */
export const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: `${MOD_LABEL} F`, label: 'Search this conversation' },
  { keys: `${MOD_LABEL} K`, label: 'Start a new chat' },
  { keys: `${ALT_LABEL} ↓`, label: 'Next conversation' },
  { keys: `${ALT_LABEL} ↑`, label: 'Previous conversation' },
  { keys: '?', label: 'Show these shortcuts' },
  { keys: 'Esc', label: 'Close search, a dialog, or a reply draft' },
];

function isTextEntry(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

export function registerShortcuts(handlers: ShortcutHandlers): () => void {
  if (typeof window === 'undefined') return () => {};

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat) return;

    // Escape is exempt from the text-entry guard: dismissing whatever is open is
    // exactly what you want while your hands are still in the composer.
    if (event.key === 'Escape') {
      if (handlers.onEscape) handlers.onEscape();
      return;
    }

    const mod = event.metaKey || event.ctrlKey;

    // Modifier combos are exempt too — they cannot be mistaken for typing.
    if (mod && !event.altKey) {
      const key = event.key.toLowerCase();
      const handler =
        key === 'f' ? handlers.onSearch : key === 'k' ? handlers.onNewChat : undefined;

      // Only swallow the browser's own binding when we actually replace it.
      if (handler) {
        event.preventDefault();
        handler();
      }
      return;
    }

    if (isTextEntry(event.target)) return;

    if (event.altKey && !mod) {
      const handler =
        event.key === 'ArrowDown'
          ? handlers.onNextChat
          : event.key === 'ArrowUp'
            ? handlers.onPrevChat
            : undefined;

      if (handler) {
        event.preventDefault();
        handler();
      }
      return;
    }

    if (event.key === '?' && !event.altKey && handlers.onHelp) {
      event.preventDefault();
      handlers.onHelp();
    }
  };

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
