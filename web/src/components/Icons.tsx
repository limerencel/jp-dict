/** 内联图标：避免引入图标库，统一 currentColor + 16px 视框。 */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

function Svg({ children, ...rest }: P): JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconChevronLeft = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M10 3 5 8l5 5" />
  </Svg>
);

export const IconChevronRight = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="m6 3 5 5-5 5" />
  </Svg>
);

export const IconClose = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
);

export const IconBook = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M2.5 3.2A9 9 0 0 1 8 4.6a9 9 0 0 1 5.5-1.4v9A9 9 0 0 0 8 13.6a9 9 0 0 0-5.5-1.4z" />
    <path d="M8 4.6v9" />
  </Svg>
);

export const IconRefresh = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.7-3.9" />
    <path d="M13.7 2.6v3.1h-3.1" />
  </Svg>
);

export const IconCopy = (p: P): JSX.Element => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5v5A1.5 1.5 0 0 0 4 11h1" />
  </Svg>
);

export const IconCheck = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="m3.2 8.4 3.2 3.2 6.4-7.2" />
  </Svg>
);

export const IconSun = (p: P): JSX.Element => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2 3.1 3.1" />
  </Svg>
);

export const IconMoon = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1" />
  </Svg>
);

export const IconArrowUp = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M8 12.5v-9M4.2 7.3 8 3.5l3.8 3.8" />
  </Svg>
);

export const IconArrowDown = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M8 3.5v9M11.8 8.7 8 12.5 4.2 8.7" />
  </Svg>
);

export const IconTrash = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M2.8 4.2h10.4M6.2 4.2V2.9h3.6v1.3M4.2 4.2l.6 8.2a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.2" />
  </Svg>
);

export const IconPanelLeft = (p: P): JSX.Element => (
  <Svg {...p}>
    <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" />
    <path d="M6.2 2.8v10.4" />
  </Svg>
);

export const IconPanelRight = (p: P): JSX.Element => (
  <Svg {...p}>
    <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" />
    <path d="M9.8 2.8v10.4" />
  </Svg>
);

export const IconSend = (p: P): JSX.Element => (
  <Svg {...p}>
    <path d="M14 2 7.2 8.8M14 2l-4.4 12-2.4-5.2L2 6.4z" />
  </Svg>
);
