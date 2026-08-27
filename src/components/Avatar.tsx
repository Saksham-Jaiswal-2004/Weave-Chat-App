'use client';

import { cn, initials, tintFor } from '@/lib/utils';
import type { AvatarColor } from '@/types';

const SIZES = {
  sm: 'h-8 w-8 text-[11px]',
  md: 'h-10 w-10 text-[13px]',
  lg: 'h-12 w-12 text-[15px]',
} as const;

const DOT_SIZES = {
  sm: 'h-2.5 w-2.5 border-2',
  md: 'h-3 w-3 border-2',
  lg: 'h-3.5 w-3.5 border-[3px]',
} as const;

interface AvatarProps {
  name: string;
  /** Stable per-identity so colours do not shuffle between renders. */
  seed?: string;
  photoURL?: string | null;
  size?: keyof typeof SIZES;
  /** `undefined` hides the presence dot entirely (groups, own avatar). */
  online?: boolean;
  /** Overrides the deterministic tint when the person has picked one. */
  color?: AvatarColor | null;
  /** Ring colour must match the surface the avatar sits on. */
  ringClass?: string;
  className?: string;
}

export function Avatar({
  name,
  seed,
  photoURL,
  size = 'md',
  online,
  color,
  ringClass = 'border-ink-900',
  className,
}: AvatarProps) {
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      {photoURL ? (
        // Plain <img>: avatars come from arbitrary provider domains, which would
        // otherwise all need whitelisting in next.config for next/image.
        <img
          src={photoURL}
          alt=""
          className={cn('rounded-full object-cover', SIZES[size])}
          referrerPolicy="no-referrer"
        />
      ) : (
        <span
          aria-hidden
          className={cn(
            'flex items-center justify-center rounded-full font-semibold text-white/95 select-none',
            SIZES[size],
            tintFor(seed ?? name, color)
          )}
        >
          {initials(name)}
        </span>
      )}

      {online !== undefined && (
        <span
          className={cn(
            'absolute right-0 bottom-0 rounded-full',
            DOT_SIZES[size],
            ringClass,
            online ? 'bg-signal-online' : 'bg-ink-600'
          )}
          title={online ? 'Online' : 'Offline'}
        />
      )}
    </span>
  );
}
