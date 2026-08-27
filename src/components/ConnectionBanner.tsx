'use client';

import { useEffect, useState } from 'react';

import { WarningIcon } from '@/components/Icons';
import { useSocketStore } from '@/store/socket';

/**
 * Only speaks up when the socket is actually struggling — and only after a short
 * grace period, so a routine reconnect never flashes a banner at the user.
 */
const GRACE_MS = 1_500;

export function ConnectionBanner() {
  const status = useSocketStore((state) => state.status);
  const lastError = useSocketStore((state) => state.lastError);
  const [visible, setVisible] = useState(false);

  const degraded = status === 'offline' || status === 'reconnecting' || status === 'connecting';

  useEffect(() => {
    if (!degraded) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), GRACE_MS);
    return () => clearTimeout(timer);
  }, [degraded]);

  if (!visible) return null;

  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 bg-weave-600/90 px-4 py-1.5 text-center text-xs font-medium text-white"
    >
      {/* shrink-0: at 320px the wrapping message was squashing the glyph to a sliver. */}
      <WarningIcon aria-hidden className="h-3.5 w-3.5 shrink-0" />
      {/* A bare socket error told the user nothing about what happens next. */}
      <span>
        {status === 'offline' && lastError
          ? `${lastError} Retrying automatically — anything you send will go out once you are back.`
          : 'Reconnecting… messages you send will be delivered once you are back.'}
      </span>
    </div>
  );
}
