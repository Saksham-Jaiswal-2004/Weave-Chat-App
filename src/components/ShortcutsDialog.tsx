'use client';

import { useEffect, useRef } from 'react';

import { CloseIcon } from '@/components/Icons';
import { SHORTCUTS } from '@/lib/shortcuts';

const KEY_CHIP =
  'inline-flex min-w-6 items-center justify-center rounded-md border border-ink-600 bg-ink-800 px-1.5 py-0.5 text-[11px] font-medium text-mist-200 shadow-sm';

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus lands on Close so the dialog is dismissible without reaching for the mouse.
    closeRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="w-full overflow-hidden rounded-t-2xl border border-ink-700 bg-ink-900 shadow-2xl sm:max-w-sm sm:rounded-2xl"
      >
        <header className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
          <h2 className="text-base font-semibold">Keyboard shortcuts</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-mist-400 transition-colors hover:bg-ink-800 hover:text-mist-50 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none motion-reduce:transition-none"
          >
            <CloseIcon className="h-[18px] w-[18px]" />
          </button>
        </header>

        <dl className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-5 py-4">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className="contents">
              <dt className="py-1 text-sm text-mist-200">{shortcut.label}</dt>
              <dd className="flex justify-end gap-1 py-1">
                {shortcut.keys.split(' ').map((key) => (
                  <kbd key={key} className={KEY_CHIP}>
                    {key}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>

        <p className="border-t border-ink-800 px-5 py-3 text-[11px] leading-relaxed text-mist-500">
          Shortcuts stay out of the way while you are typing — only the modifier combos
          and Escape reach through a text field.
        </p>
      </div>
    </div>
  );
}
