import type { PdfDocument } from '../document.js';
import type {
  PdfColor, PdfPoint, PdfQuad, PdfRect, PdfRenderOptions, PdfSize, PdfPageRotation,
  PdfRedactionReport, PdfRedactionTarget,
} from '../types.js';
import type { PdfImageData } from '../page.js';
import { PdfViewTransform } from '../types.js';
import { fittingSize, fittingWidth, stepped, type PdfZoom } from './zoom.js';
import type {
  PdfEdit, PdfPageLayout, PdfSelection, PdfTool, PdfViewChange, PdfViewEvent, PdfViewState,
} from './state.js';

export interface PdfViewerOptions {
  readonly sessionId?: string;
  /** Viewport changes are coalesced over this window. Edits will not be. */
  readonly throttleMs?: number;
  /**
   * A follower may look wherever it likes but may not change the document.
   *
   * Concurrent editing is deliberately out of scope: two people editing one annotation
   * is a distributed-systems problem, and last-writer-wins silently discards work.
   */
  readonly role?: 'presenter' | 'follower';
  /** When set, only this session's edits are applied. Others are ignored. */
  readonly presenterId?: string;
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
    private readonly role: 'presenter' | 'follower',
    private readonly presenterId: string | undefined,
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
      options.role ?? 'presenter',
      options.presenterId,
    );
  }

  /** The bytes this viewer's document was opened from. An edit is refused unless the
   *  sender's matches. */
  get documentFingerprint(): string { return this.document.fingerprint; }

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

  /**
   * Renders the current page at the zoomed size. `pixelRatio` is device pixels per CSS
   * pixel — `window.devicePixelRatio` — so the bitmap is sharp when drawn at the zoomed
   * size on a high-density display.
   */
  render(options: PdfRenderOptions & { readonly pixelRatio?: number } = {}): Promise<PdfImageData> {
    const { pixelRatio = 1, ...renderOptions } = options;
    // Rendered at the zoomed size rather than scaling one bitmap up, so text stays sharp.
    const width = Math.max(1, Math.round(this.pageSize.width * this.current.zoom.scale * pixelRatio));
    return this.document.page(this.current.pageIndex)
      .then((page) => page.render({ ...renderOptions, width }));
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

  // MARK: - Editing
  //
  // A follower refuses to edit locally. It may still scroll and zoom: following is not
  // the same as being frozen, and reading a different part of the page is normal.
  //
  // Every method delegates to the existing page API and then emits. Two code paths
  // producing annotations would drift, and the bug would only surface through one of
  // them — `viewer-delegation.test.ts` asserts byte identity to stop that.

  async addNote(rect: PdfRect, contents: string,
                color: PdfColor = { red: 255, green: 255, blue: 0, alpha: 128 }): Promise<number> {
    this.requirePresenter();
    const index = await (await this.document.page(this.current.pageIndex))
      .addNote(rect, contents, color);
    this.emitEdit({ kind: 'noteAdded', page: this.current.pageIndex, rect, contents, color });
    return index;
  }

  async addInk(strokes: readonly (readonly PdfPoint[])[],
               color: PdfColor = { red: 0, green: 0, blue: 0 },
               lineWidth = 2): Promise<number> {
    this.requirePresenter();
    const index = await (await this.document.page(this.current.pageIndex))
      .addInk(strokes, color, lineWidth);
    this.emitEdit({ kind: 'inkAdded', page: this.current.pageIndex, strokes, color, lineWidth });
    return index;
  }

  async addHighlight(quads: readonly PdfQuad[],
                     color: PdfColor = { red: 255, green: 255, blue: 0, alpha: 128 }): Promise<number> {
    this.requirePresenter();
    const index = await (await this.document.page(this.current.pageIndex))
      .addHighlight(quads, color);
    this.emitEdit({ kind: 'highlightAdded', page: this.current.pageIndex, quads, color });
    return index;
  }

  async removeAnnotation(index: number): Promise<void> {
    this.requirePresenter();
    await (await this.document.page(this.current.pageIndex)).removeAnnotation(index);
    this.emitEdit({ kind: 'annotationRemoved', page: this.current.pageIndex, index });
  }

  async setFieldText(value: string, annotationIndex: number): Promise<void> {
    this.requirePresenter();
    await (await this.document.page(this.current.pageIndex)).setText(value, annotationIndex);
    this.emitEdit({ kind: 'fieldTextSet', page: this.current.pageIndex, annotationIndex, value });
  }

  async setFieldChecked(checked: boolean, annotationIndex: number): Promise<void> {
    this.requirePresenter();
    await (await this.document.page(this.current.pageIndex)).setChecked(checked, annotationIndex);
    this.emitEdit({ kind: 'fieldCheckedSet', page: this.current.pageIndex, annotationIndex, checked });
  }

  async setFieldOption(option: number, selected: boolean, annotationIndex: number): Promise<void> {
    this.requirePresenter();
    await (await this.document.page(this.current.pageIndex))
      .setOption(option, selected, annotationIndex);
    this.emitEdit({ kind: 'fieldOptionSet', page: this.current.pageIndex, annotationIndex, option, selected });
  }

  /**
   * Removes content so it cannot be recovered.
   *
   * **Save with `'full'` afterwards** — an incremental save leaves the original content
   * stream in the file, and the removed content with it.
   */
  async redact(targets: readonly PdfRedactionTarget[]): Promise<PdfRedactionReport> {
    this.requirePresenter();
    const report = await this.document.redact(targets);
    this.emitEdit({ kind: 'redacted', targets });
    return report;
  }

  // MARK: - Sync

  /**
   * Applies a peer's event.
   *
   * Emits nothing — without that, two synced viewers echo each other forever — and
   * ignores anything at or below the highest sequence already seen from that session,
   * so late delivery cannot rewind the view.
   */
  async apply(event: PdfViewEvent): Promise<void> {
    const highest = this.seen.get(event.sessionId);
    if (highest !== undefined && event.sequence <= highest) return;

    if (event.change.kind === 'edit') {
      // Only edits depend on the bytes. Two people looking at *different* documents can
      // still be told where the other is looking, and refusing that would be over-strict.
      if (event.documentFingerprint !== undefined
          && event.documentFingerprint !== this.documentFingerprint) {
        throw new Error(
          `edit is for a different document (${event.documentFingerprint} vs ${this.documentFingerprint})`);
      }
      // An edit from someone who is not the presenter is ignored rather than refused:
      // in a broadcast transport everyone hears everyone, and throwing would turn a
      // third participant's stray edit into an error on every peer.
      if (this.presenterId !== undefined && event.sessionId !== this.presenterId) {
        return;
      }

      this.seen.set(event.sessionId, event.sequence);
      await this.applyEdit(event.change.edit);
      return;
    }

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

  /**
   * Edits bypass the viewport throttle.
   *
   * A viewport change may be dropped in favour of a later one — only the latest matters.
   * An annotation added is not superseded by the next, and dropping it loses data.
   */
  private requirePresenter(): void {
    if (this.role === 'follower') {
      throw new Error('this viewer is a follower and cannot edit the document');
    }
  }

  private emitEdit(edit: PdfEdit): void {
    this.emit({ kind: 'edit', edit });
  }

  /** Replays a peer's edit by making the same call. Emits nothing. */
  private async applyEdit(edit: PdfEdit): Promise<void> {
    const page = await this.document.page(edit.kind === 'redacted' ? this.current.pageIndex : edit.page);
    switch (edit.kind) {
      case 'noteAdded': await page.addNote(edit.rect, edit.contents, edit.color); break;
      case 'inkAdded': await page.addInk(edit.strokes, edit.color, edit.lineWidth); break;
      case 'highlightAdded': await page.addHighlight(edit.quads, edit.color); break;
      case 'annotationRemoved': await page.removeAnnotation(edit.index); break;
      case 'fieldTextSet': await page.setText(edit.value, edit.annotationIndex); break;
      case 'fieldCheckedSet': await page.setChecked(edit.checked, edit.annotationIndex); break;
      case 'fieldOptionSet': await page.setOption(edit.option, edit.selected, edit.annotationIndex); break;
      case 'redacted': await this.document.redact(edit.targets); break;
    }
  }

  private emit(change: PdfViewChange): void {
    const event: PdfViewEvent = {
      sequence: ++this.sequence,
      sessionId: this.sessionId,
      origin: 'local',
      // Carried on edits only: it is what lets a peer refuse one meant for other bytes.
      ...(change.kind === 'edit' ? { documentFingerprint: this.documentFingerprint } : {}),
      change,
    };
    for (const listener of this.listeners) listener(event);
  }
}
