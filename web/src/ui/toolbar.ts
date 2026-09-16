import type { PdfTool } from '../view/state.js';

export type PdfToolbarItemKind =
  | { readonly kind: 'tool'; readonly tool: PdfTool }
  | { readonly kind: 'undo' } | { readonly kind: 'deleteSelection' }
  | { readonly kind: 'zoomOut' } | { readonly kind: 'zoomIn' } | { readonly kind: 'fitWidth' }
  | { readonly kind: 'pageBack' } | { readonly kind: 'pageForward' }
  | { readonly kind: 'save' } | { readonly kind: 'spacer' } | { readonly kind: 'divider' }
  /**
   * An app-defined button. `label` is rendered as its own content — text or an inline
   * SVG string — because an icon is an SF Symbol on Apple and an ImageVector on Android,
   * and a cross-platform icon type would satisfy none of them.
   */
  | { readonly kind: 'custom'; readonly content: string; readonly action: () => void };

export interface PdfToolbarItem {
  readonly id: string;
  readonly label: string;
  readonly item: PdfToolbarItemKind;
}

const tool = (t: PdfTool): PdfToolbarItem =>
  ({ id: `tool-${t}`, label: t[0]!.toUpperCase() + t.slice(1), item: { kind: 'tool', tool: t } });

export const toolbarItems = {
  tool,
  undo: { id: 'editor-undo', label: 'Undo', item: { kind: 'undo' } } as PdfToolbarItem,
  deleteSelection: { id: 'editor-delete', label: 'Delete', item: { kind: 'deleteSelection' } } as PdfToolbarItem,
  zoomOut: { id: 'zoom-out', label: '−', item: { kind: 'zoomOut' } } as PdfToolbarItem,
  zoomIn: { id: 'zoom-in', label: '+', item: { kind: 'zoomIn' } } as PdfToolbarItem,
  fitWidth: { id: 'zoom-fit', label: 'Fit', item: { kind: 'fitWidth' } } as PdfToolbarItem,
  pageBack: { id: 'page-back', label: '‹', item: { kind: 'pageBack' } } as PdfToolbarItem,
  pageForward: { id: 'page-forward', label: '›', item: { kind: 'pageForward' } } as PdfToolbarItem,
  save: { id: 'editor-save', label: 'Save', item: { kind: 'save' } } as PdfToolbarItem,
  spacer: { id: 'spacer', label: '', item: { kind: 'spacer' } } as PdfToolbarItem,
  divider: { id: 'divider', label: '', item: { kind: 'divider' } } as PdfToolbarItem,

  custom: (id: string, label: string, content: string, action: () => void): PdfToolbarItem =>
    ({ id, label, item: { kind: 'custom', content, action } }),
};

export interface PdfToolbarConfiguration {
  readonly items: readonly PdfToolbarItem[];
}

/**
 * Paging first, then the tools, then zoom and save.
 *
 * `deleteSelection` is not here: undo covers the same ground for the common mistake, and
 * a toolbar earns its width. Apps that want it add `toolbarItems.deleteSelection`.
 */
export const defaultToolbar: PdfToolbarConfiguration = {
  items: [
    toolbarItems.pageBack, toolbarItems.pageForward,
    toolbarItems.divider,
    tool('select'), tool('ink'), tool('highlight'), tool('note'), tool('redact'),
    toolbarItems.divider, toolbarItems.undo,
    toolbarItems.spacer,
    toolbarItems.zoomOut, toolbarItems.fitWidth, toolbarItems.zoomIn,
    toolbarItems.divider, toolbarItems.save,
  ],
};

/** Viewing only: no tools, no save. */
export const viewingToolbar: PdfToolbarConfiguration = {
  items: [
    toolbarItems.pageBack, toolbarItems.pageForward, toolbarItems.spacer,
    toolbarItems.zoomOut, toolbarItems.fitWidth, toolbarItems.zoomIn,
  ],
};
