import type { PdfDocument } from '../document.js';
import { PdfViewer } from '../view/viewer.js';
import type { PdfTool } from '../view/state.js';
import { defaultToolbar, type PdfToolbarConfiguration, type PdfToolbarItem } from './toolbar.js';
import { lightTheme, type PdfViewerTheme } from './theme.js';

export interface PdfViewerElementOptions {
  readonly toolbar?: PdfToolbarConfiguration;
  readonly theme?: PdfViewerTheme;
  readonly onSave?: (bytes: Uint8Array) => void;
}

/**
 * A drop-in viewer: the page, gestures and a configurable toolbar.
 *
 * It drives a headless `PdfViewer` and owns no state of its own, so behaviour lives in
 * one tested place and this layer can be rewritten without touching the contract
 * underneath. An app that wants full control uses `PdfViewer` directly.
 *
 * Plain DOM rather than a framework component: the SDK has no framework dependency and
 * should not acquire one to draw a toolbar.
 */
export class PdfViewerElement {
  private viewer?: PdfViewer;
  private tool: PdfTool = 'select';
  private created = 0;
  private readonly canvas = document.createElement('canvas');
  private readonly bar = document.createElement('div');
  private readonly stage = document.createElement('div');
  private readonly status = document.createElement('p');

  private constructor(
    private readonly host: HTMLElement,
    private readonly pdf: PdfDocument,
    private readonly toolbar: PdfToolbarConfiguration,
    private readonly theme: PdfViewerTheme,
    private readonly onSave?: (bytes: Uint8Array) => void,
  ) {}

  static async mount(host: HTMLElement, pdf: PdfDocument,
                     options: PdfViewerElementOptions = {}): Promise<PdfViewerElement> {
    const element = new PdfViewerElement(
      host, pdf, options.toolbar ?? defaultToolbar, options.theme ?? lightTheme, options.onSave);
    await element.build();
    return element;
  }

  private async build(): Promise<void> {
    const width = Math.max(240, this.host.clientWidth || 800);
    this.viewer = await PdfViewer.open(this.pdf, { width, height: this.host.clientHeight || 600 });

    Object.assign(this.host.style, { background: this.theme.background, display: 'block' });

    // The toolbar must not clip. Every item has a fixed width, so a row overflows rather
    // than wrapping and whatever does not fit is silently cut off — this project shipped
    // that bug once, and a configurable toolbar makes it likelier because apps add items.
    Object.assign(this.bar.style, {
      display: 'flex', gap: '4px', alignItems: 'center',
      height: this.theme.toolbarHeight, padding: '0 8px',
      background: this.theme.toolbarBackground, color: this.theme.toolbarForeground,
      overflowX: 'auto', overflowY: 'hidden', whiteSpace: 'nowrap',
    });
    Object.assign(this.stage.style, { overflow: 'auto', position: 'relative' });
    Object.assign(this.status.style, { margin: '4px 8px', font: '12px sans-serif', color: '#6e6e73' });

    this.stage.append(this.canvas);
    this.host.replaceChildren(this.bar, this.stage, this.status);
    this.renderToolbar();
    this.attachGestures();
    await this.refresh();
  }

  private renderToolbar(): void {
    this.bar.replaceChildren(...this.toolbar.items.map((item) => this.control(item)));
  }

  private control(item: PdfToolbarItem): HTMLElement {
    if (item.item.kind === 'spacer') {
      const spacer = document.createElement('span');
      spacer.style.flex = '1 0 12px';
      return spacer;
    }
    if (item.item.kind === 'divider') {
      const divider = document.createElement('span');
      Object.assign(divider.style, { width: '1px', height: '24px', background: 'currentColor', opacity: '0.2' });
      return divider;
    }

    const button = document.createElement('button');
    button.id = item.id;
    button.setAttribute('aria-label', item.label);
    button.textContent = item.item.kind === 'custom' ? item.item.content : item.label;
    const active = item.item.kind === 'tool' && item.item.tool === this.tool;
    Object.assign(button.style, {
      font: `${this.theme.iconSize} sans-serif`, color: 'inherit', cursor: 'pointer',
      border: 'none', borderRadius: this.theme.cornerRadius, padding: '6px 10px',
      background: active ? `color-mix(in srgb, ${this.theme.accent} 18%, transparent)` : 'transparent',
      flex: '0 0 auto',
    });
    button.onclick = () => { void this.perform(item); };
    if (item.item.kind === 'undo' && this.created === 0) button.disabled = true;
    return button;
  }

  private async perform(item: PdfToolbarItem): Promise<void> {
    const viewer = this.viewer;
    if (!viewer) return;

    switch (item.item.kind) {
      case 'custom': item.item.action(); return;
      case 'tool': this.tool = item.item.tool; viewer.setTool(item.item.tool); this.renderToolbar(); return;
      case 'undo': {
        const count = (await (await this.pdf.page(viewer.state.pageIndex)).annotations()).length;
        if (count > 0) await viewer.removeAnnotation(count - 1);
        this.created = Math.max(0, this.created - 1);
        break;
      }
      case 'zoomIn': viewer.zoomIn(); break;
      case 'zoomOut': viewer.zoomOut(); break;
      case 'fitWidth': viewer.fitWidth(); break;
      case 'pageBack': await viewer.goToPage(viewer.state.pageIndex - 1); break;
      case 'pageForward': await viewer.goToPage(viewer.state.pageIndex + 1); break;
      case 'save': {
        const bytes = await this.pdf.toBytes('full');
        this.onSave?.(bytes);
        this.status.textContent = `Saved ${(bytes.length / 1024).toFixed(0)} KB`;
        return;
      }
      default: return;
    }
    this.renderToolbar();
    await this.refresh();
  }

  private attachGestures(): void {
    let start: { x: number; y: number } | null = null;
    const local = (event: PointerEvent) => {
      const box = this.canvas.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };

    this.canvas.onpointerdown = (event) => { start = local(event); };
    this.canvas.onpointerup = async (event) => {
      const from = start;
      start = null;
      const viewer = this.viewer;
      if (!from || !viewer) return;
      const to = local(event);
      const transform = viewer.transform();

      if (this.tool === 'note') {
        const point = transform.toPdf(to);
        await viewer.addNote({ left: point.x, bottom: point.y - 24, right: point.x + 24, top: point.y }, 'Note');
        this.created++;
      } else if (this.tool === 'ink') {
        await viewer.addInk([[transform.toPdf(from), transform.toPdf(to)]]);
        this.created++;
      } else if (this.tool === 'highlight' || this.tool === 'redact') {
        const rect = transform.toPdfRect({
          x: Math.min(from.x, to.x), y: Math.min(from.y, to.y),
          width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y),
        });
        if (Math.abs(to.x - from.x) < 4 || Math.abs(to.y - from.y) < 4) return;
        if (this.tool === 'redact') {
          const report = await viewer.redact([{ kind: 'region', rect, pageIndex: viewer.state.pageIndex }]);
          this.status.textContent = report.textObjects + report.images + report.paths > 0
            ? `Redacted ${report.textObjects} text object(s) — save to write it out`
            : 'Nothing in that region to redact';
        } else {
          await viewer.addHighlight([{
            p1: { x: rect.left, y: rect.top }, p2: { x: rect.right, y: rect.top },
            p3: { x: rect.left, y: rect.bottom }, p4: { x: rect.right, y: rect.bottom },
          }]);
          this.created++;
        }
      } else {
        return;
      }
      this.renderToolbar();
      await this.refresh();
    };
  }

  private async refresh(): Promise<void> {
    const viewer = this.viewer;
    if (!viewer) return;
    // Drawn at CSS size from a device-pixel bitmap, so text is sharp on a 2x or 3x display
    // and gestures keep working in CSS pixels.
    const ratio = globalThis.devicePixelRatio || 1;
    const image = await viewer.render({ pixelRatio: ratio });
    this.canvas.width = image.width;
    this.canvas.height = image.height;
    Object.assign(this.canvas.style, {
      width: `${image.width / ratio}px`,
      height: `${image.height / ratio}px`,
      background: this.theme.pageBackground,
      boxShadow: `0 2px 8px ${this.theme.pageShadow}`,
    });
    // ImageData's declared parameter is Uint8ClampedArray<ArrayBuffer> while the render
    // buffer is backed by ArrayBufferLike. The bytes are identical; copying a whole
    // bitmap on every frame to satisfy the type would not be.
    const pixels = image.data as unknown as Uint8ClampedArray<ArrayBuffer>;
    this.canvas.getContext('2d')?.putImageData(
      new ImageData(pixels, image.width, image.height), 0, 0);
  }
}
