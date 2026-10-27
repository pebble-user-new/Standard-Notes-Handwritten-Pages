// Small inline SVG icons (24x24, stroke = currentColor).

const wrap = (body: string): string =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICON = {
  pen: wrap('<path d="M4 20l1-4.5L16.5 4a2.1 2.1 0 013 3L8 18.5 4 20z"/><path d="M14.5 6l3.5 3.5"/>'),
  highlighter: wrap('<path d="M15 4.5l4.5 4.5-8 8H7v-4.5l8-8z"/><path d="M7 17l-2.5 2.5"/><path d="M4 21h16" stroke-width="2.6" opacity=".45"/>'),
  eraser: wrap('<path d="M7 20h12"/><path d="M5.2 14.3l8.1-8.1a2 2 0 012.8 0l2.6 2.6a2 2 0 010 2.8L11.5 18.2H8.7l-3.5-3.5a.9.9 0 010-1.2z"/><path d="M9.5 10l5.5 5.5"/>'),
  undo: wrap('<path d="M9 14L4 9l5-5"/><path d="M4 9h9a6 6 0 010 12h-3"/>'),
  redo: wrap('<path d="M15 14l5-5-5-5"/><path d="M20 9h-9a6 6 0 000 12h3"/>'),
  prev: wrap('<path d="M15 5l-7 7 7 7"/>'),
  next: wrap('<path d="M9 5l7 7-7 7"/>'),
  plus: wrap('<path d="M12 5v14M5 12h14"/>'),
  overview: wrap('<rect x="4" y="4" width="7" height="7" rx="1.2"/><rect x="13" y="4" width="7" height="7" rx="1.2"/><rect x="4" y="13" width="7" height="7" rx="1.2"/><rect x="13" y="13" width="7" height="7" rx="1.2"/>'),
  pageStyle: wrap('<path d="M6 3h8.5L19 7.5V21H6z"/><path d="M14 3v5h5"/><path d="M9 12h7M9 15.5h7M9 19h4"/>'),
  more: wrap('<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>'),
  image: wrap('<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 18l5-5 3 3 2-2 4 4"/>'),
  focus: wrap('<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>'),
  copy: wrap('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>'),
  trash: wrap('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
};

/** Tiny paper previews for the template picker. */
export function templatePreview(kind: 'blank' | 'lined' | 'grid' | 'dots'): string {
  let body = '';
  if (kind === 'lined') for (let y = 12; y <= 40; y += 7) body += `<path d="M3 ${y}h30"/>`;
  if (kind === 'grid') {
    for (let y = 9; y <= 43; y += 8) body += `<path d="M3 ${y}h30"/>`;
    for (let x = 9; x <= 31; x += 8) body += `<path d="M${x} 4v44"/>`;
  }
  if (kind === 'dots') for (let y = 10; y <= 42; y += 8) for (let x = 8; x <= 32; x += 8) body += `<circle cx="${x}" cy="${y}" r="1" fill="currentColor" stroke="none"/>`;
  return `<svg viewBox="0 0 36 52" width="36" height="52" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><rect x=".5" y=".5" width="35" height="51" rx="2" fill="#fff" stroke="currentColor" opacity=".9"/><g opacity=".55" color="#4a6aa0">${body}</g></svg>`;
}
