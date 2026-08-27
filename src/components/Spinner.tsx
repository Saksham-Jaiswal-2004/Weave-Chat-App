import { cn } from '@/lib/utils';

export function Spinner({ label, className }: { label?: string; className?: string }) {
  return (
    <div
      role="status"
      className={cn('flex flex-col items-center gap-3 text-mist-500', className)}
    >
      <span
        aria-hidden
        className="h-6 w-6 animate-spin rounded-full border-2 border-ink-700 border-t-weave-500"
      />
      {/* A visible label is already announced; adding the sr-only copy read it twice. */}
      {label ? <span className="text-sm">{label}</span> : <span className="sr-only">Loading</span>}
    </div>
  );
}
