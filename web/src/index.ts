export { PdfDocument, PdfDocumentSnapshot } from './document.js';
export { PdfPage, PdfTextPage, type PdfImageData } from './page.js';
export { PdfError, type PdfErrorCode } from './errors.js';
export { configureEngine, ENGINE_VERSION, type EngineConfig, type ModuleFactory } from './engine.js';
export {
  PdfWorker, PdfWorkerDocument, PdfWorkerPage, PdfWorkerTextPage,
  type PdfWorkerOptions,
} from './worker/client.js';
export { type CmsSigner, type PdfSignOptions } from './sign/sign.js';
export * from './types.js';

// The UI layer. Optional: the headless PdfViewer stays usable alone.
export { PdfViewerElement, type PdfReviewOptions, type PdfViewerElementOptions } from './ui/viewerElement.js';
export { defaultToolbar, viewingToolbar, toolbarItems,
         type PdfToolbarConfiguration, type PdfToolbarItem } from './ui/toolbar.js';
export { lightTheme, darkTheme, type PdfViewerTheme } from './ui/theme.js';
export { PdfViewer, type PdfViewerOptions } from './view/viewer.js';
export * from './view/state.js';
export * from './view/zoom.js';
export { PdfLicense } from './license/state.js';
export type { PdfLicenseModule, PdfLicenseReason, PdfLicenseStatus } from './license/key.js';
