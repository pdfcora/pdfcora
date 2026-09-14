/**
 * How the viewer looks.
 *
 * Tokens are the tested path and mean the same thing on every platform. CSS custom
 * properties may be set on the host element as well, which is deliberately **outside**
 * the conformance contract: once used, cross-platform parity is the app's to maintain.
 */
export interface PdfViewerTheme {
  readonly accent: string;
  readonly background: string;
  readonly pageBackground: string;
  readonly pageShadow: string;
  readonly toolbarBackground: string;
  readonly toolbarForeground: string;
  readonly selectionStroke: string;
  readonly redactionFill: string;
  readonly cornerRadius: string;
  readonly iconSize: string;
  readonly toolbarHeight: string;
}

export const lightTheme: PdfViewerTheme = {
  accent: '#0066cc',
  background: '#fbfbfd',
  pageBackground: '#ffffff',
  pageShadow: 'rgba(0,0,0,0.18)',
  toolbarBackground: '#efeff3',
  toolbarForeground: '#1d1d1f',
  selectionStroke: '#ff9500',
  redactionFill: 'rgba(29,29,31,0.72)',
  cornerRadius: '7px',
  iconSize: '15px',
  toolbarHeight: '44px',
};

export const darkTheme: PdfViewerTheme = {
  ...lightTheme,
  background: '#16161a',
  pageBackground: '#ebebeb',
  toolbarBackground: '#26262b',
  toolbarForeground: '#f2f2f7',
};
