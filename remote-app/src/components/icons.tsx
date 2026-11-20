// Line icons drawn for this app (24×24, round caps like the app icon's strokes). Decorative by default:
// the button or text next to an icon carries its meaning.

import type { ComponentChildren } from "preact";

interface IconProps {
  size?: number;
  class?: string;
  stroke?: number;
}

function Svg({ size = 20, class: className, stroke = 1.8, children }: IconProps & { children: ComponentChildren }) {
  return (
    <svg
      class={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={stroke}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const icon = (paths: ComponentChildren) => (props: IconProps) => <Svg {...props}>{paths}</Svg>;

export const ChevronLeft = icon(<path d="M15 5l-7 7 7 7" />);
export const ChevronRight = icon(<path d="M9 5l7 7-7 7" />);
export const ChevronDown = icon(<path d="M6 9l6 6 6-6" />);
export const Ellipsis = icon(
  <>
    <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </>,
);
export const Sliders = icon(
  <>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </>,
);
export const ArrowUp = icon(<path d="M12 19V5M6 11l6-6 6 6" />);
export const ArrowDown = icon(<path d="M12 5v14M6 13l6 6 6-6" />);
export const Stop = icon(<rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor" stroke="none" />);
export const Photo = icon(
  <>
    <rect x="3" y="5" width="18" height="14" rx="3" />
    <circle cx="8.5" cy="10" r="1.5" />
    <path d="M21 15.5l-4.5-4.5L8 19.5" />
  </>,
);
export const Scan = icon(
  <>
    <path d="M4 8V6.5A2.5 2.5 0 0 1 6.5 4H8M16 4h1.5A2.5 2.5 0 0 1 20 6.5V8M20 16v1.5a2.5 2.5 0 0 1-2.5 2.5H16M8 20H6.5A2.5 2.5 0 0 1 4 17.5V16" />
    <path d="M8 12h8" />
  </>,
);
export const ClipboardIcon = icon(
  <>
    <path d="M9 4h6v3H9z" />
    <path d="M8 5.5H7A2 2 0 0 0 5 7.5v11A2 2 0 0 0 7 20.5h10a2 2 0 0 0 2-2v-11a2 2 0 0 0-2-2h-1" />
  </>,
);
export const Keyboard = icon(
  <>
    <rect x="3" y="6" width="18" height="12" rx="2.5" />
    <path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" />
  </>,
);
export const Terminal = icon(<path d="M5 7l5 5-5 5M12.5 17H19" />);
export const FileIcon = icon(
  <>
    <path d="M13.5 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8.5z" />
    <path d="M13.5 3v5.5H19" />
  </>,
);
export const Pencil = icon(
  <>
    <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0 0-3l-1-1a2.1 2.1 0 0 0-3 0L4 16z" />
    <path d="M14 6l4 4" />
  </>,
);
export const Search = icon(
  <>
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20l-4.3-4.3" />
  </>,
);
export const Globe = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.3 3.5 8.5s-1.1 6.1-3.5 8.5M12 3.5C9.6 5.9 8.5 8.8 8.5 12s1.1 6.1 3.5 8.5" />
  </>,
);
export const Agent = icon(
  <>
    <path d="M6 4v8.5A3.5 3.5 0 0 0 9.5 16H19" />
    <path d="M15 12l4 4-4 4" />
  </>,
);
export const ListCheck = icon(
  <>
    <path d="M10 7h10M10 12h10M10 17h10" />
    <path d="M4 7l1.3 1.3L7.5 6M4 12h.01M4 17h.01" />
  </>,
);
export const Question = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.6 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.2 1-1.2 1.8v.4M12 17h.01" />
  </>,
);
export const PlanIcon = icon(
  <>
    <path d="M9 4.5L3.5 6.5v13L9 17.5l6 2 5.5-2v-13L15 6.5z" />
    <path d="M9 4.5v13M15 6.5v13" />
  </>,
);
export const Plug = icon(
  <>
    <path d="M9 3v4.5M15 3v4.5M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0z" />
    <path d="M12 16.5V21" />
  </>,
);
export const Cube = icon(
  <>
    <path d="M12 3l7.5 4.2v9.6L12 21l-7.5-4.2V7.2z" />
    <path d="M12 12l7.5-4.8M12 12v9M12 12L4.5 7.2" />
  </>,
);
export const Check = icon(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const Close = icon(<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />);
export const Mic = icon(
  <>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </>,
);
export const Plus = icon(<path d="M12 5v14M5 12h14" />);
export const Branch = icon(
  <>
    <circle cx="7" cy="6" r="2" />
    <circle cx="7" cy="18" r="2" />
    <circle cx="17" cy="8" r="2" />
    <path d="M7 8v8M17 10c0 3.5-3 4.5-6 4.8-2 .2-3.2.9-3.8 1.6" />
  </>,
);
export const Bell = icon(
  <>
    <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z" />
    <path d="M10 20.5a2 2 0 0 0 4 0" />
  </>,
);
export const Paperclip = icon(<path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7-7l8.2-8.2a3.4 3.4 0 0 1 4.8 4.8l-8.1 8.1a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3" />);
export const SelectionIcon = icon(
  <>
    <path d="M5 6h14M5 10h9M5 14h14M5 18h7" />
  </>,
);
export const Slash = icon(<path d="M15 4L9 20" />);
export const External = icon(
  <>
    <path d="M14 4h6v6M20 4l-8.5 8.5" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </>,
);
export const Laptop = icon(
  <>
    <rect x="5" y="5" width="14" height="10" rx="1.8" />
    <path d="M2.5 18.5h19" />
  </>,
);
export const Trash = icon(
  <>
    <path d="M4.5 7h15M9.5 7V4.5h5V7" />
    <path d="M6.5 7l.9 12a1.8 1.8 0 0 0 1.8 1.6h5.6a1.8 1.8 0 0 0 1.8-1.6l.9-12" />
  </>,
);
export const Refresh = icon(
  <>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M19.5 4.5v4.5H15" />
  </>,
);
export const Book = icon(
  <>
    <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z" />
    <path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19M9 7h6" />
  </>,
);
export const Thinking = icon(
  <>
    <path d="M7 17.5a5 5 0 0 1-1.3-9.8A6 6 0 0 1 17.5 7a4.8 4.8 0 0 1 .5 9.6z" />
    <path d="M9 12h.01M12 12h.01M15 12h.01" />
  </>,
);
export const Layers = icon(
  <>
    <path d="M12 4l8 4-8 4-8-4z" />
    <path d="M4 12.5l8 4 8-4M4 16.5l8 4 8-4" />
  </>,
);
export const Pause = icon(<path d="M9 6v12M15 6v12" />);
export const Wifi = icon(
  <>
    <path d="M4.5 9.5a11 11 0 0 1 15 0M7.5 13a6.5 6.5 0 0 1 9 0" />
    <path d="M12 17h.01" />
  </>,
);
export const Key = icon(
  <>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l8.5-8.5M16.5 6.5l2.5 2.5M14 9l2 2" />
  </>,
);
