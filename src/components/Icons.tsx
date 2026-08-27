import type { SVGProps } from 'react';

/** Inline icons — a handful of paths beats pulling in an icon package. */

const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  viewBox: '0 0 24 24',
};

type Props = SVGProps<SVGSVGElement>;

export const SearchIcon = (props: Props) => (
  <svg {...base} {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const PlusIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const GroupIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19" />
    <circle cx="10" cy="8" r="3.25" />
    <path d="M20 19v-1.5a3.5 3.5 0 0 0-2.6-3.38M15.5 5.2a3.25 3.25 0 0 1 0 6.1" />
  </svg>
);

export const SendIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M4.5 12h6" />
    <path d="M5.4 5.2 19.2 12 5.4 18.8l1.9-6.8-1.9-6.8Z" />
  </svg>
);

export const BackIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
);

export const MoreIcon = (props: Props) => (
  <svg {...base} {...props}>
    <circle cx="12" cy="5.5" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none" />
    <circle cx="12" cy="18.5" r="1.25" fill="currentColor" stroke="none" />
  </svg>
);

export const LogoutIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2" />
    <path d="M10 12h10m0 0-3-3m3 3-3 3" />
  </svg>
);

export const CloseIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const CheckIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);

export const RetryIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M20 11a8 8 0 1 0-.6 4" />
    <path d="M20 5v6h-6" />
  </svg>
);

export const WarningIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M12 9v4.5M12 17h.01" />
    <path d="M10.3 3.9 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
  </svg>
);

export const WeaveMark = (props: Props) => (
  <svg viewBox="0 0 24 24" fill="none" {...props}>
    <path
      d="M3 7c3 0 3 10 6 10s3-10 6-10 3 10 6 10"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
    />
  </svg>
);

export const DoubleCheckIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="m1.5 12.5 4 4L14 8" />
    <path d="m10 16.5 8.5-9" />
  </svg>
);

export const ReplyIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M9 7 4 12l5 5" />
    <path d="M4 12h9a7 7 0 0 1 7 7v1" />
  </svg>
);

export const PencilIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
    <path d="m14.5 6.5 3 3" />
  </svg>
);

export const TrashIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13" />
    <path d="M10.5 11v5M13.5 11v5" />
  </svg>
);

/** A plain smiley — opens the emoji picker in the composer. */
export const SmileyIcon = (props: Props) => (
  <svg {...base} {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
    <circle cx="9" cy="10" r=".9" fill="currentColor" stroke="none" />
    <circle cx="15" cy="10" r=".9" fill="currentColor" stroke="none" />
  </svg>
);

/** A face with a "+" — the add-a-reaction affordance. */
export const ReactionIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M21 12a9 9 0 1 1-6-8.5" />
    <path d="M8.5 14.5a4.5 4.5 0 0 0 6.6.6" />
    <circle cx="9" cy="9.5" r=".9" fill="currentColor" stroke="none" />
    <circle cx="15" cy="9.5" r=".9" fill="currentColor" stroke="none" />
    <path d="M18.5 2.5v4M16.5 4.5h4" />
  </svg>
);

export const BellIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6Z" />
    <path d="M13.7 19a2 2 0 0 1-3.4 0" />
  </svg>
);

/** Bell with a strike-through — a muted thread. */
export const BellOffIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M18 9a6 6 0 0 0-8.4-5.5M6.2 6.6A6 6 0 0 0 6 9c0 5-2 6-2 6h13" />
    <path d="M13.7 19a2 2 0 0 1-3.4 0" />
    <path d="m3 3 18 18" />
  </svg>
);

export const InfoIcon = (props: Props) => (
  <svg {...base} {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <circle cx="12" cy="8" r=".9" fill="currentColor" stroke="none" />
  </svg>
);

/** A person with a "+" — invite someone into a group. */
export const UserPlusIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M15 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-4A3.5 3.5 0 0 0 4 17.5V19" />
    <circle cx="9.5" cy="8" r="3.25" />
    <path d="M18 8v6m3-3h-6" />
  </svg>
);

/** Gear — opens profile and account settings. */
export const SettingsIcon = (props: Props) => (
  <svg {...base} {...props}>
    <circle cx="12" cy="12" r="3.25" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8.6 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 8.6a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

/** A palette dot row — the avatar colour picker. */
export const PaletteIcon = (props: Props) => (
  <svg {...base} {...props}>
    <path d="M12 3a9 9 0 1 0 0 18c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1a1.5 1.5 0 0 1 1.14-2.5H17a4 4 0 0 0 4-4c0-4.42-4.03-9-9-9Z" />
    <circle cx="8" cy="10" r=".9" fill="currentColor" stroke="none" />
    <circle cx="12" cy="7.5" r=".9" fill="currentColor" stroke="none" />
    <circle cx="16" cy="10" r=".9" fill="currentColor" stroke="none" />
  </svg>
);

/** A key cap grid — opens the keyboard shortcuts dialog. */
export const KeyboardIcon = (props: Props) => (
  <svg {...base} {...props}>
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <path d="M8 15h8" />
    <circle cx="6.5" cy="10" r=".9" fill="currentColor" stroke="none" />
    <circle cx="10" cy="10" r=".9" fill="currentColor" stroke="none" />
    <circle cx="13.5" cy="10" r=".9" fill="currentColor" stroke="none" />
    <circle cx="17" cy="10" r=".9" fill="currentColor" stroke="none" />
  </svg>
);
