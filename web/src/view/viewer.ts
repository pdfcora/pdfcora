import type { PdfDocument } from '../document.js';
import type {
  PdfPoint, PdfRect, PdfRenderOptions, PdfSize, PdfPageRotation,
} from '../types.js';
import type { PdfImageData } from '../page.js';
import { PdfViewTransform } from '../types.js';
import { fittingSize, fittingWidth, stepped, type PdfZoom } from './zoom.js';
import type {
  PdfPageLayout, PdfSelection, PdfTool, PdfViewChange, PdfViewEvent, PdfViewState,
} from './state.js';

export interface PdfViewerOptions {
  readonly sessionId?: string;
  /** Viewport changes are coalesced over this window. Edits will not be. */
  readonly throttleMs?: number;
}

type Listener = (event: PdfViewEvent) => void;

/**
 * Where a viewer is looking, and what changes it.
 *
 * Headless: it owns no view. The app draws, asks `scrollOffset()` where to scroll and
 * `render()` what to paint, and reports gestures back in. Everything that changes it
 * emits an event, and `apply` is the inverse — which is what lets two viewers on
 * different platforms stay in step.
 */
export class PdfViewer {
  private listeners: Listener[] = [];
  private sequence = 0;
  /** Highest sequence seen per remote session, so late delivery cannot rewind us. */
  private seen = new Map<string, number>();
  private pending: PdfViewState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private readonly document: PdfDocument,
    private viewport: { width: number; height: number },
    private pageSize: PdfSize,
    private readonly pageCount: number,
    private current: PdfViewState,
    private readonly sessionId: string,
    private readonly throttleMs: number,
  ) {}

  static async open(
    document: PdfDocument,
    viewport: { width: number; height: number },
    options: PdfViewerOptions = {},
  ): Promise<PdfViewer> {
    const pageCount = await document.pageCount();
    const pageSize = await (await document.page(0)).size();
    const zoom = fittingWidth(viewport.width, pageSize);
    return new PdfViewer(
      document, viewport, pageSize, pageCount,
      {
        pageIndex: 0,
        center: { x: pageSize.width / 2, y: pageSize.height / 2 },
        zoom,
        rotation: 0,
        layout: 'single',
      },
      options.sessionId ?? `s${Math.random().toString(36).slice(2, 10)}`,
      options.throttleMs ?? 50,
    );
  }

  get state(): PdfViewState { return this.current; }
  get selection(): PdfSelection | null { return this.currentSelection; }
  get tool(): PdfTool { return this.currentTool; }
  private currentSelection: PdfSelection | null = null;
  private currentTool: PdfTool = 'select';

  on(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }

  transform(): PdfViewTransform {
    return new PdfViewTransform(this.pageSize, this.current.zoom.scale);
  }

  /** Where the app should scroll its view so the state's centre is in the middle. */
  scrollOffset(): { x: number; y: number } {
    return this.transform().scrollOffsetCentering(this.current.center, this.viewport);
  }

  render(options: PdfRenderOptions = {}): Promise<PdfImageData> {
    // Rendered at the zoomed size rather than scaling one bitmap up, so text stays sharp.
    const width = Math.max(1, Math.round(this.pageSize.width * this.current.zoom.scale));
    return this.document.page(this.current.pageIndex)
      .then((page) => page.render({ ...options, width }));
  }

  // MARK: - Viewport

  async setViewport(size: { width: number; height: number }): Promise<void> {
    this.viewport = size;
    // A fit is a promise about the window, so it is re-derived. A free zoom is the
    // user's deliberate choice and survives.
    if (this.current.zoom.mode !== 'free') {
      this.update({ ...this.current, zoom: this.refit(this.current.zoom.mode) });
    } else {
      this.update({ ...this.current });
    }
  }

  scrollTo(center: PdfPoint, page = this.current.pageIndex): void {
    this.update({ ...this.current, pageIndex: this.clampPage(page), center });
  }

  scrollBy(delta: { x: number; y: number }): void {
    const t = this.transform();
    const offset = this.scrollOffset();
    const moved = { x: offset.x + delta.x, y: offset.y + delta.y };
    this.update({ ...this.current, center: t.centerForScrollOffset(moved, this.viewport) });
  }

  async goToPage(index: number): Promise<void> {
    const page = this.clampPage(index);
    this.pageSize = await (await this.document.page(page)).size();
    const zoom = this.current.zoom.mode === 'free' ? this.current.zoom : this.refit(this.current.zoom.mode);
    this.update({
      ...this.current,
      pageIndex: page,
      center: { x: this.pageSize.width / 2, y: this.pageSize.height / 2 },
      zoom,
    });
  }

  zoomTo(zoom: PdfZoom): void { this.update({ ...this.current, zoom }); }
  zoomIn(): void { this.zoomTo(stepped(this.current.zoom, 1)); }
  zoomOut(): void { this.zoomTo(stepped(this.current.zoom, -1)); }
  fitWidth(): void { this.zoomTo(this.refit('fitWidth')); }
  fitPage(): void { this.zoomTo(this.refit('fitPage')); }

  setRotation(rotation: PdfPageRotation): void {
    this.update({ ...this.current, rotation });
  }

  setLayout(layout: PdfPageLayout): void {
    this.update({ ...this.current, layout });
  }

  // MARK: - Selection and tools

  selectRegion(page: number, rect: PdfRect): void {
    this.setSelection({ kind: 'region', page, rect });
  }

  selectAnnotation(page: number, index: number): void {
    this.setSelection({ kind: 'annotation', page, index });
  }

  clearSelection(): void { this.setSelection(null); }

  setTool(tool: PdfTool): void {
    this.currentTool = tool;
    this.emit({ kind: 'tool', tool });
  }

  // MARK: - Sync

  /**
   * Applies a peer's event.
   *
   * Emits nothing — without that, two synced viewers echo each other forever — and
   * ignores anything at or below the highest sequence already seen from that session,
   * so late delivery cannot rewind the view.
   */
  apply(event: PdfViewEvent): void {
    const highest = this.seen.get(event.sessionId);
    if (highest !== undefined && event.sequence <= highest) return;
    this.seen.set(event.sessionId, event.sequence);

    switch (event.change.kind) {
      case 'viewport': {
        const incoming = event.change.state;
        // A fit is re-derived for *this* window; a free zoom is adopted verbatim.
        const zoom = incoming.zoom.mode === 'free' ? incoming.zoom : this.refit(incoming.zoom.mode);
        this.current = { ...incoming, zoom };
        break;
      }
      case 'selection':
        this.currentSelection = event.change.selection;
        break;
      case 'tool':
        this.currentTool = event.change.tool;
        break;
    }
  }

  // MARK: - Internals

  private clampPage(index: number): number {
    return Math.max(0, Math.min(index, this.pageCount - 1));
  }

  private refit(mode: 'fitWidth' | 'fitPage'): PdfZoom {
    return mode === 'fitWidth'
      ? fittingWidth(this.viewport.width, this.pageSize)
      : fittingSize(this.viewport, this.pageSize);
  }

  private setSelection(selection: PdfSelection | null): void {
    this.currentSelection = selection;
    this.emit({ kind: 'selection', selection });
  }

  private update(state: PdfViewState): void {
    this.current = state;
    // Viewport changes coalesce: a drag produces them at gesture rate and only the
    // latest matters. Selection, tool and (later) edits are emitted immediately, since
    // each is meaningful on its own and dropping one loses information.
    this.pending = state;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const latest = this.pending;
      this.pending = null;
      if (latest) this.emit({ kind: 'viewport', state: latest });
    }, this.throttleMs);
  }

  /** Flushes any pending viewport change immediately. For tests and for teardown. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const latest = this.pending;
    this.pending = null;
    if (latest) this.emit({ kind: 'viewport', state: latest });
  }

  private emit(change: PdfViewChange): void {
    const event: PdfViewEvent = {
      sequence: ++this.sequence,
      sessionId: this.sessionId,
      origin: 'local',
      change,
    };
    for (const listener of this.listeners) listener(event);
  }
}
