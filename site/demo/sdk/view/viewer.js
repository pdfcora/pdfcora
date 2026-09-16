import { PdfViewTransform } from '../types.js';
import { fittingSize, fittingWidth, stepped } from './zoom.js';
/**
 * Where a viewer is looking, and what changes it.
 *
 * Headless: it owns no view. The app draws, asks `scrollOffset()` where to scroll and
 * `render()` what to paint, and reports gestures back in. Everything that changes it
 * emits an event, and `apply` is the inverse — which is what lets two viewers on
 * different platforms stay in step.
 */
export class PdfViewer {
    document;
    viewport;
    pageSize;
    pageCount;
    current;
    sessionId;
    throttleMs;
    role;
    presenterId;
    listeners = [];
    sequence = 0;
    /** Highest sequence seen per remote session, so late delivery cannot rewind us. */
    seen = new Map();
    pending = null;
    timer = null;
    constructor(document, viewport, pageSize, pageCount, current, sessionId, throttleMs, role, presenterId) {
        this.document = document;
        this.viewport = viewport;
        this.pageSize = pageSize;
        this.pageCount = pageCount;
        this.current = current;
        this.sessionId = sessionId;
        this.throttleMs = throttleMs;
        this.role = role;
        this.presenterId = presenterId;
    }
    static async open(document, viewport, options = {}) {
        const pageCount = await document.pageCount();
        const pageSize = await (await document.page(0)).size();
        const zoom = fittingWidth(viewport.width, pageSize);
        return new PdfViewer(document, viewport, pageSize, pageCount, {
            pageIndex: 0,
            center: { x: pageSize.width / 2, y: pageSize.height / 2 },
            zoom,
            rotation: 0,
            layout: 'single',
        }, options.sessionId ?? `s${Math.random().toString(36).slice(2, 10)}`, options.throttleMs ?? 50, options.role ?? 'presenter', options.presenterId);
    }
    /** The bytes this viewer's document was opened from. An edit is refused unless the
     *  sender's matches. */
    get documentFingerprint() { return this.document.fingerprint; }
    get state() { return this.current; }
    get selection() { return this.currentSelection; }
    get tool() { return this.currentTool; }
    currentSelection = null;
    currentTool = 'select';
    // MARK: - Marks
    //
    // Local to this viewer: none of these emit an event, so a sync transport never carries a
    // review, and none touch the document.
    currentMarks = [];
    get marks() { return this.currentMarks; }
    setMarks(marks) {
        this.currentMarks = [...marks];
    }
    setAllMarks(state) {
        this.currentMarks = this.currentMarks.map((mark) => ({ ...mark, state }));
    }
    /** The id of the topmost mark under a point on a page — the last one set — or null. */
    markAt(pageIndex, point) {
        for (let i = this.currentMarks.length - 1; i >= 0; i--) {
            const mark = this.currentMarks[i];
            if (mark.pageIndex === pageIndex && mark.rects.some((r) => point.x >= Math.min(r.left, r.right) && point.x <= Math.max(r.left, r.right)
                && point.y >= Math.min(r.bottom, r.top) && point.y <= Math.max(r.bottom, r.top))) {
                return mark.id;
            }
        }
        return null;
    }
    /** Cycles the tapped mark pending → accepted → rejected → pending. Returns its id, or null. */
    tapMark(pageIndex, point) {
        const id = this.markAt(pageIndex, point);
        if (id === null)
            return null;
        const next = { pending: 'accepted', accepted: 'rejected', rejected: 'pending' };
        this.currentMarks = this.currentMarks.map((mark) => (mark.id === id ? { ...mark, state: next[mark.state] } : mark));
        return id;
    }
    on(listener) {
        this.listeners.push(listener);
        return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
    }
    transform() {
        return new PdfViewTransform(this.pageSize, this.current.zoom.scale);
    }
    /** Where the app should scroll its view so the state's centre is in the middle. */
    scrollOffset() {
        return this.transform().scrollOffsetCentering(this.current.center, this.viewport);
    }
    /**
     * Renders the current page at the zoomed size. `pixelRatio` is device pixels per CSS
     * pixel — `window.devicePixelRatio` — so the bitmap is sharp when drawn at the zoomed
     * size on a high-density display.
     */
    render(options = {}) {
        const { pixelRatio = 1, ...renderOptions } = options;
        // Rendered at the zoomed size rather than scaling one bitmap up, so text stays sharp.
        const width = Math.max(1, Math.round(this.pageSize.width * this.current.zoom.scale * pixelRatio));
        return this.document.page(this.current.pageIndex)
            .then((page) => page.render({ ...renderOptions, width }));
    }
    // MARK: - Viewport
    async setViewport(size) {
        this.viewport = size;
        // A fit is a promise about the window, so it is re-derived. A free zoom is the
        // user's deliberate choice and survives.
        if (this.current.zoom.mode !== 'free') {
            this.update({ ...this.current, zoom: this.refit(this.current.zoom.mode) });
        }
        else {
            this.update({ ...this.current });
        }
    }
    scrollTo(center, page = this.current.pageIndex) {
        this.update({ ...this.current, pageIndex: this.clampPage(page), center });
    }
    scrollBy(delta) {
        const t = this.transform();
        const offset = this.scrollOffset();
        const moved = { x: offset.x + delta.x, y: offset.y + delta.y };
        this.update({ ...this.current, center: t.centerForScrollOffset(moved, this.viewport) });
    }
    async goToPage(index) {
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
    zoomTo(zoom) { this.update({ ...this.current, zoom }); }
    zoomIn() { this.zoomTo(stepped(this.current.zoom, 1)); }
    zoomOut() { this.zoomTo(stepped(this.current.zoom, -1)); }
    fitWidth() { this.zoomTo(this.refit('fitWidth')); }
    fitPage() { this.zoomTo(this.refit('fitPage')); }
    setRotation(rotation) {
        this.update({ ...this.current, rotation });
    }
    setLayout(layout) {
        this.update({ ...this.current, layout });
    }
    // MARK: - Selection and tools
    selectRegion(page, rect) {
        this.setSelection({ kind: 'region', page, rect });
    }
    selectAnnotation(page, index) {
        this.setSelection({ kind: 'annotation', page, index });
    }
    clearSelection() { this.setSelection(null); }
    setTool(tool) {
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
    async addNote(rect, contents, color = { red: 255, green: 255, blue: 0, alpha: 128 }) {
        this.requirePresenter();
        const index = await (await this.document.page(this.current.pageIndex))
            .addNote(rect, contents, color);
        this.emitEdit({ kind: 'noteAdded', page: this.current.pageIndex, rect, contents, color });
        return index;
    }
    async addInk(strokes, color = { red: 0, green: 0, blue: 0 }, lineWidth = 2) {
        this.requirePresenter();
        const index = await (await this.document.page(this.current.pageIndex))
            .addInk(strokes, color, lineWidth);
        this.emitEdit({ kind: 'inkAdded', page: this.current.pageIndex, strokes, color, lineWidth });
        return index;
    }
    async addHighlight(quads, color = { red: 255, green: 255, blue: 0, alpha: 128 }) {
        this.requirePresenter();
        const index = await (await this.document.page(this.current.pageIndex))
            .addHighlight(quads, color);
        this.emitEdit({ kind: 'highlightAdded', page: this.current.pageIndex, quads, color });
        return index;
    }
    async removeAnnotation(index) {
        this.requirePresenter();
        await (await this.document.page(this.current.pageIndex)).removeAnnotation(index);
        this.emitEdit({ kind: 'annotationRemoved', page: this.current.pageIndex, index });
    }
    async setFieldText(value, annotationIndex) {
        this.requirePresenter();
        await (await this.document.page(this.current.pageIndex)).setText(value, annotationIndex);
        this.emitEdit({ kind: 'fieldTextSet', page: this.current.pageIndex, annotationIndex, value });
    }
    async setFieldChecked(checked, annotationIndex) {
        this.requirePresenter();
        await (await this.document.page(this.current.pageIndex)).setChecked(checked, annotationIndex);
        this.emitEdit({ kind: 'fieldCheckedSet', page: this.current.pageIndex, annotationIndex, checked });
    }
    async setFieldOption(option, selected, annotationIndex) {
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
    async redact(targets) {
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
    async apply(event) {
        const highest = this.seen.get(event.sessionId);
        if (highest !== undefined && event.sequence <= highest)
            return;
        if (event.change.kind === 'edit') {
            // Only edits depend on the bytes. Two people looking at *different* documents can
            // still be told where the other is looking, and refusing that would be over-strict.
            if (event.documentFingerprint !== undefined
                && event.documentFingerprint !== this.documentFingerprint) {
                throw new Error(`edit is for a different document (${event.documentFingerprint} vs ${this.documentFingerprint})`);
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
    clampPage(index) {
        return Math.max(0, Math.min(index, this.pageCount - 1));
    }
    refit(mode) {
        return mode === 'fitWidth'
            ? fittingWidth(this.viewport.width, this.pageSize)
            : fittingSize(this.viewport, this.pageSize);
    }
    setSelection(selection) {
        this.currentSelection = selection;
        this.emit({ kind: 'selection', selection });
    }
    update(state) {
        this.current = state;
        // Viewport changes coalesce: a drag produces them at gesture rate and only the
        // latest matters. Selection, tool and (later) edits are emitted immediately, since
        // each is meaningful on its own and dropping one loses information.
        this.pending = state;
        if (this.timer)
            return;
        this.timer = setTimeout(() => {
            this.timer = null;
            const latest = this.pending;
            this.pending = null;
            if (latest)
                this.emit({ kind: 'viewport', state: latest });
        }, this.throttleMs);
    }
    /** Flushes any pending viewport change immediately. For tests and for teardown. */
    flush() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const latest = this.pending;
        this.pending = null;
        if (latest)
            this.emit({ kind: 'viewport', state: latest });
    }
    /**
     * Edits bypass the viewport throttle.
     *
     * A viewport change may be dropped in favour of a later one — only the latest matters.
     * An annotation added is not superseded by the next, and dropping it loses data.
     */
    requirePresenter() {
        if (this.role === 'follower') {
            throw new Error('this viewer is a follower and cannot edit the document');
        }
    }
    emitEdit(edit) {
        this.emit({ kind: 'edit', edit });
    }
    /** Replays a peer's edit by making the same call. Emits nothing. */
    async applyEdit(edit) {
        const page = await this.document.page(edit.kind === 'redacted' ? this.current.pageIndex : edit.page);
        switch (edit.kind) {
            case 'noteAdded':
                await page.addNote(edit.rect, edit.contents, edit.color);
                break;
            case 'inkAdded':
                await page.addInk(edit.strokes, edit.color, edit.lineWidth);
                break;
            case 'highlightAdded':
                await page.addHighlight(edit.quads, edit.color);
                break;
            case 'annotationRemoved':
                await page.removeAnnotation(edit.index);
                break;
            case 'fieldTextSet':
                await page.setText(edit.value, edit.annotationIndex);
                break;
            case 'fieldCheckedSet':
                await page.setChecked(edit.checked, edit.annotationIndex);
                break;
            case 'fieldOptionSet':
                await page.setOption(edit.option, edit.selected, edit.annotationIndex);
                break;
            case 'redacted':
                await this.document.redact(edit.targets);
                break;
        }
    }
    emit(change) {
        const event = {
            sequence: ++this.sequence,
            sessionId: this.sessionId,
            origin: 'local',
            // Carried on edits only: it is what lets a peer refuse one meant for other bytes.
            ...(change.kind === 'edit' ? { documentFingerprint: this.documentFingerprint } : {}),
            change,
        };
        for (const listener of this.listeners)
            listener(event);
    }
}
//# sourceMappingURL=viewer.js.map