import { PdfViewer } from '../view/viewer.js';
import { defaultToolbar } from './toolbar.js';
import { lightTheme } from './theme.js';
import { icons } from './icons.js';
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
    host;
    pdf;
    toolbar;
    theme;
    onSave;
    review;
    onChange;
    onEvent;
    viewer;
    tool = 'select';
    created = 0;
    canvas = document.createElement('canvas');
    bar = document.createElement('div');
    stage = document.createElement('div');
    status = document.createElement('p');
    overlay = document.createElement('div');
    /** What the current gesture will create, drawn while the pointer is still down. */
    preview = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    /** Where a note's text is typed, before the annotation exists. */
    editor = document.createElement('textarea');
    /** Real controls over the page's form fields, so a form is filled in rather than looked at. */
    fields = document.createElement('div');
    reviewBar = document.createElement('div');
    accessible = document.createElement('div');
    accessiblePage = -1;
    /** A scroll this component made itself, so its scroll event is not reported as the user's. */
    ownScroll = null;
    constructor(host, pdf, toolbar, theme, onSave, review, onChange, onEvent) {
        this.host = host;
        this.pdf = pdf;
        this.toolbar = toolbar;
        this.theme = theme;
        this.onSave = onSave;
        this.review = review;
        this.onChange = onChange;
        this.onEvent = onEvent;
    }
    static async mount(host, pdf, options = {}) {
        const element = new PdfViewerElement(host, pdf, options.toolbar ?? defaultToolbar, options.theme ?? lightTheme, options.onSave, options.review, options.onChange, options.onEvent);
        await element.build();
        return element;
    }
    async build() {
        const width = Math.max(240, this.host.clientWidth || 800);
        this.viewer = await PdfViewer.open(this.pdf, { width, height: this.host.clientHeight || 600 });
        if (this.review)
            this.viewer.setMarks(this.review.marks);
        if (this.onEvent)
            this.viewer.on(this.onEvent);
        // A column: the toolbar keeps its height and the page takes the rest and scrolls, so a
        // zoomed page can be scrolled within the host instead of being clipped by it.
        Object.assign(this.host.style, { background: this.theme.background, display: 'flex', flexDirection: 'column' });
        // A visible focus indicator for every control, marks included (A11Y-3).
        this.host.classList.add('pdf-viewer-element');
        const focus = document.createElement('style');
        focus.textContent = `.pdf-viewer-element button:focus-visible, .pdf-viewer-element [tabindex]:focus-visible {
      outline: 2px solid ${this.theme.accent}; outline-offset: 2px; }`;
        // The toolbar must not clip. Every item has a fixed width, so a row overflows rather
        // than wrapping and whatever does not fit is silently cut off — this project shipped
        // that bug once, and a configurable toolbar makes it likelier because apps add items.
        Object.assign(this.bar.style, {
            display: 'flex', gap: '4px', alignItems: 'center',
            minHeight: this.theme.toolbarHeight, padding: '0 8px', flex: 'none',
            background: this.theme.toolbarBackground, color: this.theme.toolbarForeground,
            overflowX: 'auto', overflowY: 'hidden', whiteSpace: 'nowrap',
        });
        Object.assign(this.stage.style, { overflow: 'auto', position: 'relative', flex: '1 1 auto', minHeight: '0' });
        Object.assign(this.status.style, { margin: '4px 8px', font: '0.75rem sans-serif', color: '#6e6e73' });
        Object.assign(this.overlay.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none' });
        // Screen readers get the page's structure from a hidden layer; the bitmap says nothing.
        this.canvas.setAttribute('aria-hidden', 'true');
        this.accessible.className = 'pdf-accessible-content';
        Object.assign(this.accessible.style, {
            position: 'absolute', width: '1px', height: '1px', overflow: 'hidden',
            clipPath: 'inset(50%)', whiteSpace: 'nowrap',
        });
        // The preview sits above the page and below the marks, and never takes the pointer:
        // it is a drawing of the gesture in flight, not something to click.
        Object.assign(this.preview.style, {
            position: 'absolute', left: '0', top: '0', pointerEvents: 'none', overflow: 'visible',
        });
        this.preview.setAttribute('aria-hidden', 'true');
        this.preview.classList.add('pdf-gesture-preview');
        Object.assign(this.editor.style, {
            position: 'absolute', display: 'none', resize: 'none', zIndex: '2',
            font: '0.8125rem/1.35 sans-serif', padding: '5px 6px', width: '164px', height: '62px',
            borderRadius: this.theme.cornerRadius, border: `1px solid ${this.theme.accent}`,
            background: '#fffbe6', color: '#1d1d1f', boxShadow: `0 2px 10px ${this.theme.pageShadow}`,
        });
        this.editor.id = 'note-text';
        this.editor.placeholder = 'Note…';
        this.editor.setAttribute('aria-label', 'Note text');
        Object.assign(this.fields.style, { position: 'absolute', left: '0', top: '0' });
        this.fields.className = 'pdf-form-fields';
        this.stage.append(this.canvas, this.preview, this.fields, this.overlay, this.editor, this.accessible);
        // The page takes keyboard focus: + and - zoom, Page Up and Page Down turn pages.
        this.stage.tabIndex = 0;
        this.stage.setAttribute('role', 'group');
        this.stage.setAttribute('aria-label', 'Page');
        this.stage.onkeydown = (event) => { void this.key(event); };
        this.stage.onscroll = () => this.scrolled();
        this.host.replaceChildren(focus, this.bar, this.stage, ...(this.review ? [this.reviewBar] : []), this.status);
        this.renderToolbar();
        this.renderReview();
        this.attachGestures();
        await this.refresh();
    }
    renderToolbar() {
        this.bar.replaceChildren(...this.toolbar.items.map((item) => this.control(item)));
    }
    control(item) {
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
        button.title = item.label;
        // An icon where there is one, the label where there is not. `aria-label` carries the
        // name either way, so a screen reader hears the same thing as before.
        const icon = item.item.kind === 'tool' ? icons[item.item.tool]
            : icons[item.item.kind];
        if (item.item.kind === 'custom')
            button.textContent = item.item.content;
        else if (icon)
            button.innerHTML = icon;
        else
            button.textContent = item.label;
        const active = item.item.kind === 'tool' && item.item.tool === this.tool;
        Object.assign(button.style, {
            font: `${this.theme.iconSize} sans-serif`, color: 'inherit', cursor: 'pointer',
            border: 'none', borderRadius: this.theme.cornerRadius,
            padding: icon ? '7px' : '6px 10px',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: active ? `color-mix(in srgb, ${this.theme.accent} 18%, transparent)` : 'transparent',
            flex: '0 0 auto',
        });
        if (active)
            button.style.color = this.theme.accent;
        // Only a tool is a toggle; save and zoom are actions, and announcing them as pressed
        // would be a lie.
        if (item.item.kind === 'tool')
            button.setAttribute('aria-pressed', String(active));
        button.onclick = () => { void this.perform(item); };
        if (item.item.kind === 'undo' && this.created === 0)
            button.disabled = true;
        if (this.review && item.item.kind === 'tool')
            button.disabled = true;
        return button;
    }
    renderReview() {
        const review = this.review;
        const viewer = this.viewer;
        if (!review || !viewer)
            return;
        const count = (state) => viewer.marks.filter((m) => m.state === state).length;
        const button = (id, label, action) => {
            const b = document.createElement('button');
            b.id = id;
            b.textContent = label;
            b.onclick = action;
            return b;
        };
        const notice = document.createElement('span');
        notice.id = 'review-notice';
        notice.textContent = review.notice;
        const counts = document.createElement('span');
        counts.id = 'review-counts';
        counts.textContent = `${count('accepted')} accepted · ${count('pending')} pending`;
        this.reviewBar.id = 'review-bar';
        Object.assign(this.reviewBar.style, {
            display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', padding: '6px 8px',
            font: '0.8125rem sans-serif', background: this.theme.toolbarBackground, color: this.theme.toolbarForeground,
        });
        this.reviewBar.replaceChildren(notice, counts, button('review-accept-all', 'Accept all', () => { viewer.setAllMarks('accepted'); this.drawMarks(); }), button('review-reject-all', 'Reject all', () => { viewer.setAllMarks('rejected'); this.drawMarks(); }), button('review-apply', review.applyLabel ?? 'Apply', () => {
            void review.onApply(viewer.marks.filter((m) => m.state === 'accepted').map((m) => m.id));
        }), button('review-cancel', 'Cancel', () => review.onCancel?.()));
    }
    /** Marks on the current page, positioned in the canvas's CSS pixels. */
    drawMarks() {
        const viewer = this.viewer;
        if (!viewer)
            return;
        const transform = viewer.transform();
        const style = {
            pending: { border: '2px solid #ff9500', background: 'rgba(255,149,0,0.18)' },
            accepted: { border: '2px solid #1d1d1f', background: this.theme.redactionFill },
            rejected: { border: '1px dashed #8e8e93', background: 'transparent' },
        };
        const boxes = [];
        for (const mark of viewer.marks.filter((m) => m.pageIndex === viewer.state.pageIndex)) {
            for (const [index, rect] of mark.rects.entries()) {
                const r = transform.toViewRect(rect);
                // A button, so a mark can be reached and cycled from the keyboard too.
                const box = document.createElement('button');
                box.dataset.markId = mark.id;
                box.dataset.markState = mark.state;
                box.setAttribute('aria-label', `${mark.label ?? 'Suggestion'}: ${mark.state}`);
                if (index > 0)
                    box.tabIndex = -1;
                box.onclick = () => {
                    const point = transform.toPdf({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
                    if (viewer.tapMark(mark.pageIndex, point))
                        this.drawMarks();
                    this.overlay.querySelector(`[data-mark-id="${CSS.escape(mark.id)}"]`)?.focus();
                };
                Object.assign(box.style, { position: 'absolute', left: `${r.x}px`, top: `${r.y}px`,
                    width: `${r.width}px`, height: `${r.height}px`, boxSizing: 'border-box', margin: '0', cursor: 'pointer',
                    pointerEvents: 'auto', font: 'inherit', textAlign: 'left' }, style[mark.state]);
                if (mark.label && index === 0) {
                    box.textContent = mark.label;
                    Object.assign(box.style, { font: `${Math.max(8, Math.min(12, r.height * 0.7))}px sans-serif`,
                        lineHeight: `${r.height - 4}px`, padding: '0 3px', overflow: 'hidden', whiteSpace: 'nowrap',
                        color: mark.state === 'accepted' ? '#ffffff' : '#1d1d1f' });
                }
                boxes.push(box);
            }
        }
        this.overlay.replaceChildren(...boxes);
        this.renderReview();
    }
    async key(event) {
        const viewer = this.viewer;
        if (!viewer || event.target !== this.stage)
            return;
        const pageIndex = viewer.state.pageIndex;
        switch (event.key) {
            case '+':
            case '=':
                viewer.zoomIn();
                break;
            case '-':
                viewer.zoomOut();
                break;
            case 'PageDown':
                await viewer.goToPage(pageIndex + 1);
                break;
            case 'PageUp':
                await viewer.goToPage(pageIndex - 1);
                break;
            default: return;
        }
        event.preventDefault();
        await this.refresh();
        this.showCenter();
    }
    /**
     * Replays another viewer's event — sent through `onEvent` — and redraws.
     *
     * Emits nothing, so two components wired to each other do not echo.
     */
    async apply(event) {
        const viewer = this.viewer;
        if (!viewer)
            return;
        await viewer.apply(event);
        if (event.change.kind === 'tool') {
            this.tool = viewer.tool;
            this.renderToolbar();
        }
        await this.refresh();
        if (event.change.kind === 'viewport')
            this.showCenter();
        if (event.change.kind === 'edit')
            this.onChange?.();
    }
    viewportSize() {
        return { width: this.stage.clientWidth, height: this.stage.clientHeight };
    }
    /** The user scrolled: the point now in the middle is the view state other viewers follow. */
    scrolled() {
        const viewer = this.viewer;
        if (!viewer)
            return;
        const own = this.ownScroll;
        this.ownScroll = null;
        if (own && Math.abs(own.left - this.stage.scrollLeft) <= 1 && Math.abs(own.top - this.stage.scrollTop) <= 1)
            return;
        viewer.scrollTo(viewer.transform().centerForScrollOffset({ x: this.stage.scrollLeft, y: this.stage.scrollTop }, this.viewportSize()));
    }
    /** Scrolls so the view state's centre is in the middle, without reporting it as the user's scroll. */
    showCenter() {
        const viewer = this.viewer;
        if (!viewer)
            return;
        const offset = viewer.transform().scrollOffsetCentering(viewer.state.center, this.viewportSize());
        const clamp = (value, max) => Math.round(Math.max(0, Math.min(value, max)));
        const left = clamp(offset.x, this.stage.scrollWidth - this.stage.clientWidth);
        const top = clamp(offset.y, this.stage.scrollHeight - this.stage.clientHeight);
        // No scroll event fires when nothing moves, and a stale marker would swallow the next real one.
        if (Math.abs(left - this.stage.scrollLeft) <= 1 && Math.abs(top - this.stage.scrollTop) <= 1)
            return;
        this.ownScroll = { left, top };
        this.stage.scrollLeft = left;
        this.stage.scrollTop = top;
    }
    async perform(item) {
        const viewer = this.viewer;
        if (!viewer)
            return;
        switch (item.item.kind) {
            case 'custom':
                item.item.action();
                return;
            case 'tool':
                this.tool = item.item.tool;
                viewer.setTool(item.item.tool);
                this.renderToolbar();
                this.fields.style.pointerEvents = this.tool === 'select' ? 'auto' : 'none';
                return;
            case 'undo': {
                const count = (await (await this.pdf.page(viewer.state.pageIndex)).annotations()).length;
                if (count > 0)
                    await viewer.removeAnnotation(count - 1);
                this.created = Math.max(0, this.created - 1);
                break;
            }
            case 'zoomIn':
                viewer.zoomIn();
                break;
            case 'zoomOut':
                viewer.zoomOut();
                break;
            case 'fitWidth':
                viewer.fitWidth();
                break;
            case 'pageBack':
                await viewer.goToPage(viewer.state.pageIndex - 1);
                break;
            case 'pageForward':
                await viewer.goToPage(viewer.state.pageIndex + 1);
                break;
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
        if (item.item.kind !== 'undo')
            this.showCenter();
        if (item.item.kind === 'undo')
            this.onChange?.();
    }
    attachGestures() {
        let start = null;
        // Every point the pointer visited, so ink is the line that was drawn rather than a
        // straight one between where it went down and where it came up.
        let path = [];
        const local = (event) => {
            const box = this.canvas.getBoundingClientRect();
            return { x: event.clientX - box.left, y: event.clientY - box.top };
        };
        this.canvas.onpointerdown = (event) => {
            if (this.editor.style.display !== 'none') {
                void this.commitNote();
                return;
            }
            start = local(event);
            path = [start];
            // Capture, so a stroke that leaves the page still finishes where the pointer does.
            this.canvas.setPointerCapture(event.pointerId);
        };
        this.canvas.onpointermove = (event) => {
            if (!start || this.review)
                return;
            const to = local(event);
            // A pointer reports sub-pixel moves; anything under a pixel is noise in the path
            // and another node in the SVG.
            const last = path[path.length - 1];
            if (Math.abs(to.x - last.x) >= 1 || Math.abs(to.y - last.y) >= 1)
                path.push(to);
            this.drawPreview(start, to, path);
        };
        const cancel = () => { start = null; path = []; this.clearPreview(); };
        this.canvas.onpointercancel = cancel;
        this.canvas.onpointerup = async (event) => {
            const from = start;
            const drawn = path;
            start = null;
            path = [];
            this.clearPreview();
            const viewer = this.viewer;
            if (!from || !viewer)
                return;
            const to = local(event);
            const transform = viewer.transform();
            // While reviewing, a tap is about a mark; editing tools stay out of the way.
            if (this.review) {
                if (viewer.tapMark(viewer.state.pageIndex, transform.toPdf(to)))
                    this.drawMarks();
                return;
            }
            if (this.tool === 'note') {
                this.openNoteEditor(to);
                return;
            }
            else if (this.tool === 'ink') {
                // A tap with the pen is not a stroke.
                if (drawn.length < 2)
                    return;
                await viewer.addInk([drawn.map((point) => transform.toPdf(point))]);
                this.created++;
            }
            else if (this.tool === 'highlight' || this.tool === 'redact') {
                const rect = transform.toPdfRect({
                    x: Math.min(from.x, to.x), y: Math.min(from.y, to.y),
                    width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y),
                });
                if (Math.abs(to.x - from.x) < 4 || Math.abs(to.y - from.y) < 4)
                    return;
                if (this.tool === 'redact') {
                    const report = await viewer.redact([{ kind: 'region', rect, pageIndex: viewer.state.pageIndex }]);
                    this.status.textContent = report.textObjects + report.images + report.paths > 0
                        ? `Redacted ${report.textObjects} text object(s) — save to write it out`
                        : 'Nothing in that region to redact';
                }
                else {
                    await viewer.addHighlight([{
                            p1: { x: rect.left, y: rect.top }, p2: { x: rect.right, y: rect.top },
                            p3: { x: rect.left, y: rect.bottom }, p4: { x: rect.right, y: rect.bottom },
                        }]);
                    this.created++;
                }
            }
            else {
                return;
            }
            this.renderToolbar();
            await this.refresh();
            this.onChange?.();
        };
    }
    /** The gesture in flight, in the canvas's CSS pixels. */
    drawPreview(from, to, path) {
        const width = this.canvas.clientWidth;
        const height = this.canvas.clientHeight;
        this.preview.setAttribute('width', String(width));
        this.preview.setAttribute('height', String(height));
        const node = (name, attributes) => {
            const e = document.createElementNS('http://www.w3.org/2000/svg', name);
            for (const [key, value] of Object.entries(attributes))
                e.setAttribute(key, value);
            return e;
        };
        if (this.tool === 'ink') {
            this.preview.replaceChildren(node('polyline', {
                points: path.map((p) => `${p.x},${p.y}`).join(' '),
                fill: 'none', stroke: this.theme.accent, 'stroke-width': '2',
                'stroke-linecap': 'round', 'stroke-linejoin': 'round',
            }));
            return;
        }
        if (this.tool === 'highlight' || this.tool === 'redact') {
            const box = {
                x: Math.min(from.x, to.x), y: Math.min(from.y, to.y),
                width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y),
            };
            // Redaction is shown as what it will leave behind; a highlight as what it will add.
            const redacting = this.tool === 'redact';
            this.preview.replaceChildren(node('rect', {
                x: String(box.x), y: String(box.y),
                width: String(box.width), height: String(box.height),
                fill: redacting ? this.theme.redactionFill : `color-mix(in srgb, ${this.theme.accent} 28%, transparent)`,
                stroke: redacting ? '#1d1d1f' : this.theme.accent,
                'stroke-width': '1.5',
                'stroke-dasharray': redacting ? '5 3' : '',
            }));
            return;
        }
        this.clearPreview();
    }
    clearPreview() {
        this.preview.replaceChildren();
    }
    /**
     * A note carries text, so the text is typed before the annotation exists rather than
     * created empty and edited afterwards — PDFium has no editing path for one.
     */
    openNoteEditor(at) {
        Object.assign(this.editor.style, {
            display: 'block',
            left: `${Math.min(at.x, Math.max(0, this.canvas.clientWidth - 170))}px`,
            top: `${Math.min(at.y, Math.max(0, this.canvas.clientHeight - 68))}px`,
        });
        this.editor.value = '';
        this.editor.dataset.x = String(at.x);
        this.editor.dataset.y = String(at.y);
        this.editor.focus({ preventScroll: true });
        this.status.textContent = 'Type the note, then press Enter. Escape cancels.';
        this.editor.onkeydown = (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void this.commitNote();
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                this.closeNoteEditor();
            }
        };
    }
    closeNoteEditor() {
        this.editor.style.display = 'none';
        this.editor.value = '';
        this.status.textContent = '';
        // preventScroll, or the browser scrolls the focused stage into view and takes the
        // toolbar off the top of a fixed-height host, where overflow:hidden strands it.
        this.stage.focus({ preventScroll: true });
    }
    async commitNote() {
        const viewer = this.viewer;
        const text = this.editor.value.trim();
        const at = { x: Number(this.editor.dataset.x), y: Number(this.editor.dataset.y) };
        this.closeNoteEditor();
        if (!viewer || text.length === 0)
            return;
        const point = viewer.transform().toPdf(at);
        await viewer.addNote({ left: point.x, bottom: point.y - 24, right: point.x + 24, top: point.y }, text);
        this.created++;
        this.renderToolbar();
        await this.refresh();
        this.onChange?.();
    }
    async refresh() {
        const viewer = this.viewer;
        if (!viewer)
            return;
        // Drawn at CSS size from a device-pixel bitmap, so text is sharp on a 2x or 3x display
        // and gestures keep working in CSS pixels.
        const ratio = globalThis.devicePixelRatio || 1;
        const image = await viewer.render({ pixelRatio: ratio, forms: false });
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
        const pixels = image.data;
        this.canvas.getContext('2d')?.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
        this.drawMarks();
        await this.renderFields();
        await this.renderAccessible();
    }
    /**
     * A control per form field on the page, positioned over the widget PDFium drew.
     *
     * Typing goes straight into the document through the form-fill environment, so the
     * value other viewers read back is the one on screen. While reviewing, or with a tool
     * other than select, the layer stays out of the pointer's way so drawing still works.
     */
    async renderFields() {
        const viewer = this.viewer;
        if (!viewer)
            return;
        if (this.review) {
            this.fields.replaceChildren();
            return;
        }
        const transform = viewer.transform();
        const page = await this.pdf.page(viewer.state.pageIndex);
        const controls = [];
        for (const field of await page.formFields()) {
            const box = transform.toViewRect(field.rect);
            if (box.width < 4 || box.height < 4)
                continue;
            let control;
            if (field.kind === 'checkBox' || field.kind === 'radioButton') {
                control = document.createElement('input');
                control.type = field.kind === 'checkBox' ? 'checkbox' : 'radio';
                control.checked = field.isChecked;
                control.onchange = () => void this.commitField(() => viewer.setFieldChecked(control.checked, field.annotationIndex));
            }
            else if (field.kind === 'comboBox' || field.kind === 'listBox') {
                control = document.createElement('select');
                for (const [index, option] of field.options.entries()) {
                    const choice = document.createElement('option');
                    choice.value = String(index);
                    choice.textContent = option;
                    choice.selected = field.selectedIndices.includes(index);
                    control.append(choice);
                }
                control.onchange = () => void this.commitField(() => viewer.setFieldOption(Number(control.value), true, field.annotationIndex));
            }
            else if (field.kind === 'text') {
                const multiline = field.isMultiline;
                control = document.createElement(multiline ? 'textarea' : 'input');
                if (!multiline)
                    control.type = field.isPassword ? 'password' : 'text';
                control.value = field.value;
                // On change, not on input: every keystroke would be a round trip into the engine
                // and a re-render of the page underneath.
                control.onchange = () => void this.commitField(() => viewer.setFieldText(control.value, field.annotationIndex));
            }
            else {
                // A push button, a signature field, or a type this SDK does not model. PDFium has
                // already drawn it; there is nothing for a control to add.
                continue;
            }
            control.disabled = field.isReadOnly;
            if (field.isRequired)
                control.required = true;
            // The tooltip is what a form's author wrote for exactly this purpose.
            const name = field.alternateName ?? field.name;
            if (name)
                control.setAttribute('aria-label', name);
            const toggle = field.kind === 'checkBox' || field.kind === 'radioButton';
            Object.assign(control.style, {
                position: 'absolute', left: `${box.x}px`, top: `${box.y}px`,
                width: `${box.width}px`, height: `${box.height}px`,
                boxSizing: 'border-box', margin: '0', padding: toggle ? '0' : '0 3px',
                font: `${Math.max(9, Math.min(15, box.height * 0.62))}px sans-serif`,
                border: `1px solid color-mix(in srgb, ${this.theme.accent} 45%, transparent)`,
                borderRadius: '2px', background: `color-mix(in srgb, ${this.theme.accent} 8%, transparent)`,
                color: '#1d1d1f', resize: 'none',
            });
            controls.push(control);
        }
        // Fields take the pointer only when no drawing tool is chosen, so a highlight can
        // still be dragged across a form.
        this.fields.style.pointerEvents = this.tool === 'select' ? 'auto' : 'none';
        this.fields.replaceChildren(...controls);
    }
    async commitField(write) {
        await write();
        this.status.textContent = 'Field updated — save to write it out';
        await this.refresh();
        this.onChange?.();
    }
    /** Rebuilt when the page changes: headings, paragraphs, lists, figures, tables, form fields. */
    async renderAccessible() {
        const viewer = this.viewer;
        if (!viewer || viewer.state.pageIndex === this.accessiblePage)
            return;
        const pageIndex = viewer.state.pageIndex;
        this.accessiblePage = pageIndex;
        const nodes = await (await this.pdf.page(pageIndex)).accessibleContent();
        if (this.accessiblePage !== pageIndex)
            return;
        const element = (node) => {
            const make = (tag, text = node.text) => {
                const e = document.createElement(tag);
                if (text)
                    e.textContent = text;
                return e;
            };
            switch (node.role) {
                case 'heading': return make(`h${node.level ?? 1}`);
                case 'paragraph': return make('p');
                case 'listItem': return make('li');
                case 'headerCell': return make('th');
                case 'cell': return make('td');
                case 'list': {
                    const e = make('ul', '');
                    e.append(...node.children.map(element));
                    return e;
                }
                case 'table': {
                    const e = make('table', '');
                    e.append(...node.children.map(element));
                    return e;
                }
                case 'row': {
                    const e = make('tr', '');
                    e.append(...node.children.map(element));
                    return e;
                }
                case 'figure': {
                    const e = make('div', '');
                    e.setAttribute('role', 'img');
                    // An image must have a name; one the document leaves undescribed says so.
                    e.setAttribute('aria-label', node.text || 'Figure without a description');
                    return e;
                }
                case 'formField': {
                    const e = make('div', '');
                    e.setAttribute('role', 'group');
                    e.setAttribute('aria-label', node.text);
                    return e;
                }
            }
        };
        this.accessible.replaceChildren(...nodes.map(element));
    }
}
//# sourceMappingURL=viewerElement.js.map