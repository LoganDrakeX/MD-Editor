/** 轻量 SVG 图标集（Atlassian/Jira 风格，currentColor 描边）。 */
import type { SVGProps } from 'react';

function Svg({ children, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconBold = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
    <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
  </Svg>
);

export const IconItalic = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M19 4h-9" />
    <path d="M14 20H5" />
    <path d="M15 4 9 20" />
  </Svg>
);

export const IconStrike = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M16 4H9a3 3 0 0 0-2.83 4" />
    <path d="M14 12a4 4 0 0 1 0 8H6" />
    <path d="M4 12h16" />
  </Svg>
);

export const IconListUl = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M8 6h13M8 12h13M8 18h13" />
    <path d="M3 6h.01M3 12h.01M3 18h.01" strokeWidth="3" />
  </Svg>
);

export const IconListOl = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M9 6h12M9 12h12M9 18h12" />
    <text x="1" y="8.2" fontSize="7.5" fontWeight="700" fill="currentColor" stroke="none" fontFamily="inherit">
      1
    </text>
    <text x="1" y="14.2" fontSize="7.5" fontWeight="700" fill="currentColor" stroke="none" fontFamily="inherit">
      2
    </text>
    <text x="1" y="20.2" fontSize="7.5" fontWeight="700" fill="currentColor" stroke="none" fontFamily="inherit">
      3
    </text>
  </Svg>
);

export const IconTask = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M9 11l3 3L22 4" />
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
  </Svg>
);

export const IconQuote = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M4 12c1.5 0 2.5 1 2.5 2.5S5.5 17 4 17V12z" fill="currentColor" stroke="none" />
    <path d="M4 4v5.2c1.4.4 2.4 1.2 2.9 2.8H4" />
    <path d="M14 12c1.5 0 2.5 1 2.5 2.5s-1 2.5-2.5 2.5V12z" fill="currentColor" stroke="none" />
    <path d="M14 4v5.2c1.4.4 2.4 1.2 2.9 2.8H14" />
  </Svg>
);

export const IconCode = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M16 18l6-6-6-6" />
    <path d="M8 6l-6 6 6 6" />
  </Svg>
);

export const IconTable = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="1.5" />
    <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
  </Svg>
);

export const IconLink = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </Svg>
);

export const IconImage = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15l-5-5L5 21" />
  </Svg>
);

export const IconHr = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
);

export const IconUndo = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M3 7v6h6" />
    <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
  </Svg>
);

export const IconRedo = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M21 7v6h-6" />
    <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7" />
  </Svg>
);

export const IconSun = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </Svg>
);

export const IconMoon = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </Svg>
);

export const IconChevronDown = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);

export const IconChevronRight = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);

export const IconOutline = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M6 4v16" />
    <path d="M6 8h14" />
    <path d="M6 13h9" />
    <path d="M6 18h5" />
  </Svg>
);

export const IconEmoji = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
    <path d="M9 9h.01M15 9h.01" strokeWidth="3" />
  </Svg>
);

export const IconSave = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <path d="M17 21v-8H7v8" />
    <path d="M7 3v5h8" />
  </Svg>
);
