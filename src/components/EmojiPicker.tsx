'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { SearchIcon } from '@/components/Icons';
import { EMOJI_GROUPS, QUICK_REACTIONS, emojiName, searchEmoji } from '@/lib/emoji';
import { cn } from '@/lib/utils';

export interface EmojiPickerProps {
  onSelect: (char: string) => void;
  onClose: () => void;
  /** Which edge of the positioned parent the panel hangs from. */
  align?: 'left' | 'right';
}

const MAX_RESULTS = 56;

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function EmojiPicker({ onSelect, onClose, align = 'left' }: EmojiPickerProps) {
  const [term, setTerm] = useState('');
  const [activeGroup, setActiveGroup] = useState(EMOJI_GROUPS[0].name);
  const [hovered, setHovered] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sections = useRef(new Map<string, HTMLElement>());

  // Same dismiss contract as the group menu in ChatHeader: Escape, or a press
  // that starts outside the panel.
  useEffect(() => {
    inputRef.current?.focus();

    const onPointerDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const results = useMemo(() => searchEmoji(term, MAX_RESULTS), [term]);
  const searching = term.trim().length > 0;

  /** Keep the tab strip in step with a manual scroll. */
  function syncActiveGroup() {
    const container = scrollRef.current;
    if (!container || searching) return;

    const edge = container.scrollTop + 8;
    let current = EMOJI_GROUPS[0].name;
    for (const entry of EMOJI_GROUPS) {
      const node = sections.current.get(entry.name);
      if (node && node.offsetTop <= edge) current = entry.name;
    }
    setActiveGroup(current);
  }

  function jumpTo(name: string) {
    setTerm('');
    setActiveGroup(name);

    // The section only exists once the search results are swapped back out.
    requestAnimationFrame(() => {
      const node = sections.current.get(name);
      const container = scrollRef.current;
      if (!node || !container) return;
      container.scrollTo({
        top: node.offsetTop,
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    });
  }

  const label = hovered ? emojiName(hovered) : searching ? `${results.length} matches` : '';

  function cell(char: string) {
    const name = emojiName(char);
    return (
      <button
        key={char}
        type="button"
        title={name}
        aria-label={name || char}
        onClick={() => onSelect(char)}
        onMouseEnter={() => setHovered(char)}
        onMouseLeave={() => setHovered((current) => (current === char ? null : current))}
        onFocus={() => setHovered(char)}
        onBlur={() => setHovered((current) => (current === char ? null : current))}
        className="flex h-9 w-9 items-center justify-center rounded-lg text-xl leading-none transition-colors hover:bg-ink-750 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none motion-reduce:transition-none"
      >
        {char}
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Choose an emoji"
      // `message-enter` is the app's existing rise-in, already muted under
      // prefers-reduced-motion in globals.css.
      className={cn(
        'message-enter absolute bottom-full z-30 mb-2 w-80 overflow-hidden rounded-2xl border border-ink-700 bg-ink-800 shadow-2xl',
        align === 'right' ? 'right-0' : 'left-0'
      )}
    >
      <div className="space-y-2.5 px-3 pt-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-mist-500" />
          <input
            ref={inputRef}
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && results.length > 0) {
                event.preventDefault();
                onSelect(results[0]);
              }
            }}
            placeholder="Search emoji"
            aria-label="Search emoji"
            className="w-full rounded-xl border border-ink-700 bg-ink-850 py-2 pr-3 pl-9 text-sm placeholder:text-mist-500 focus:border-weave-500 focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-0.5">
          {QUICK_REACTIONS.map((char) => cell(char))}
        </div>
      </div>

      <div className="mt-2.5 flex items-center gap-0.5 border-y border-ink-750 px-2 py-1">
        {EMOJI_GROUPS.map((entry) => (
          <button
            key={entry.name}
            type="button"
            title={entry.name}
            aria-label={entry.name}
            aria-current={!searching && entry.name === activeGroup}
            onClick={() => jumpTo(entry.name)}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-lg text-sm leading-none transition-colors hover:bg-ink-750 focus-visible:ring-2 focus-visible:ring-weave-500 focus-visible:outline-none motion-reduce:transition-none',
              !searching && entry.name === activeGroup
                ? 'bg-ink-750 opacity-100'
                : 'opacity-55 hover:opacity-100'
            )}
          >
            {entry.emoji[0].char}
          </button>
        ))}
      </div>

      <div
        ref={scrollRef}
        onScroll={syncActiveGroup}
        className="scroll-slim relative h-60 overflow-y-auto px-2 py-1"
      >
        {searching ? (
          results.length === 0 ? (
            <p className="px-2 py-10 text-center text-sm text-mist-500">Nothing matched that.</p>
          ) : (
            <div className="grid grid-cols-8">{results.map((char) => cell(char))}</div>
          )
        ) : (
          EMOJI_GROUPS.map((entry) => (
            <section
              key={entry.name}
              ref={(node) => {
                if (node) sections.current.set(entry.name, node);
                else sections.current.delete(entry.name);
              }}
            >
              <h3 className="sticky top-0 z-10 bg-ink-800/95 px-1 py-1.5 text-[11px] font-medium tracking-wide text-mist-500 uppercase backdrop-blur-sm">
                {entry.name}
              </h3>
              <div className="grid grid-cols-8">
                {entry.emoji.map((item) => cell(item.char))}
              </div>
            </section>
          ))
        )}
      </div>

      <div className="flex h-8 items-center border-t border-ink-750 px-3">
        <span className="truncate text-[11px] text-mist-500">{label}</span>
      </div>
    </div>
  );
}
