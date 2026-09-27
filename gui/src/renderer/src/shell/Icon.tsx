/** A small, consistent line icon set (16px grid, 1.5 stroke). Inline SVG so it
 *  inherits colour and needs no font or dependency. Always decorative: the
 *  control carrying it provides the accessible name. */
const PATHS: Record<string, string> = {
  home: 'M2.5 7.2 8 2.8l5.5 4.4V13a.5.5 0 0 1-.5.5H9.5V10h-3v3.5H3a.5.5 0 0 1-.5-.5z',
  chat: 'M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5z',
  files: 'M4 1.8h5l3 3V14a.5.5 0 0 1-.5.5h-7.5A.5.5 0 0 1 3.5 14V2.3a.5.5 0 0 1 .5-.5zM9 1.8V5h3M5.8 8h4.4M5.8 10.5h4.4',
  plan: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01',
  memory: 'M8 2.2c-3 0-5 1-5 2.3v7c0 1.3 2 2.3 5 2.3s5-1 5-2.3v-7C13 3.2 11 2.2 8 2.2zM3 4.5c0 1.3 2 2.3 5 2.3s5-1 5-2.3M3 8c0 1.3 2 2.3 5 2.3S13 9.3 13 8',
  decisions: 'M8 2v12M3.5 5.5 8 2l4.5 3.5M2 10l1.5-4.5L5 10a1.6 1.6 0 0 1-3 0zM11 10l1.5-4.5L14 10a1.6 1.6 0 0 1-3 0z',
  runs: 'M3 3.5h10M3 8h10M3 12.5h6',
  agents: 'M8 3.5a1.5 1.5 0 1 0 0-.01M3.5 12a1.5 1.5 0 1 0 0-.01M12.5 12a1.5 1.5 0 1 0 0-.01M8 5v2.5M8 7.5 4 10.5M8 7.5l4 3',
  evidence: 'M8 1.8 13 3.8v4c0 3-2.2 5.3-5 6.4-2.8-1.1-5-3.4-5-6.4v-4zM5.7 8l1.6 1.6L10.5 6.4',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.6 10.6 14 14',
  chevronDown: 'M4 6l4 4 4-4',
  chevronLeft: 'M10 3.5 5.5 8l4.5 4.5',
  chevronRight: 'M6 3.5 10.5 8 6 12.5',
  sidebar: 'M2.5 3.5h11v9h-11zM6 3.5v9',
  pin: 'M9.5 2 14 6.5l-2 .5-2.5 2.5.5 3.5-1 1-3-3-3.5 3.5M6 9 3 6l1-1 3.5.5L10 3z',
  close: 'M4 4l8 8M12 4l-8 8',
  detach: 'M9 2.5h4.5V7M13.5 2.5 8 8M11.5 9.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5h3.5',
  plus: 'M8 3v10M3 8h10',
  send: 'M8 13V3M3.5 7.5 8 3l4.5 4.5',
  branch: 'M5 2.5v7M5 9.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM11 6.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM11 6.5c0 2.5-6 1.5-6 3',
  shield: 'M8 1.8 13 3.8v4c0 3-2.2 5.3-5 6.4-2.8-1.1-5-3.4-5-6.4v-4z',
  bell: 'M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 14a1.5 1.5 0 0 0 3 0',
  expand: 'M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3',
  undo: 'M5 3 2.5 5.5 5 8M2.5 5.5H10a3.5 3.5 0 0 1 0 7H7',
  activity: 'M1.8 8h2.7l1.8-4.5 3.4 9 1.8-4.5h2.7',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
