/**
 * The toolbar's icons.
 *
 * Inline SVG rather than a font or sprite sheet: the SDK ships no assets, and an icon
 * that arrives as a second request is an icon that is sometimes missing. Each one draws
 * in `currentColor`, so a theme's `toolbarForeground` is the only thing that colours it.
 *
 * Every button keeps its `aria-label` from the toolbar item, so replacing text with a
 * drawing changes nothing a screen reader hears.
 */
const svg = (body) => `<svg viewBox="0 0 24 24" width="1.25em" height="1.25em" fill="none" stroke="currentColor"
    stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    focusable="false">${body}</svg>`;
export const icons = {
    pageBack: svg('<path d="M14.5 5.5 8 12l6.5 6.5"/>'),
    pageForward: svg('<path d="M9.5 5.5 16 12l-6.5 6.5"/>'),
    select: svg('<path d="M5.5 3.5 18 11l-5.2 1.6L10.4 18z"/>'),
    ink: svg('<path d="M4 20h3.5L19 8.5a2.5 2.5 0 0 0-3.5-3.5L4 16.5z"/><path d="m14 6.5 3.5 3.5"/>'),
    highlight: svg('<path d="m9 14 6.5-6.5a2 2 0 0 1 3 3L12 17H9z"/><path d="M4.5 20.5h9"/>'),
    note: svg('<path d="M4.5 5.5h15v9h-6l-4 4v-4h-5z"/><path d="M8 9h8M8 11.5h5"/>'),
    redact: svg('<rect x="3.5" y="8" width="17" height="5" rx="1"/><path d="M4 17h8"/>'),
    undo: svg('<path d="M4 9h9.5a5 5 0 0 1 0 10H9"/><path d="M7.5 5.5 4 9l3.5 3.5"/>'),
    deleteSelection: svg('<path d="M5 7h14"/><path d="M9.5 7V5h5v2"/><path d="M6.5 7 7.5 20h9l1-13"/>'),
    zoomOut: svg('<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5M8 10.5h5"/>'),
    zoomIn: svg('<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5M8 10.5h5M10.5 8v5"/>'),
    fitWidth: svg('<path d="M3.5 6.5v11M20.5 6.5v11"/><path d="M7 12h10"/><path d="m9.5 9.5-2.5 2.5 2.5 2.5M14.5 9.5l2.5 2.5-2.5 2.5"/>'),
    save: svg('<path d="M12 3.5v11"/><path d="m8 11 4 3.5 4-3.5"/><path d="M4.5 16v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V16"/>'),
};
//# sourceMappingURL=icons.js.map