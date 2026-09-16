import { PdfViewer } from '../view/viewer.js';
import { defaultToolbar } from './toolbar.js';
import { lightTheme } from './theme.js';
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
    viewer;
    tool = 'select';
    created = 0;
    canvas = document.createElement('canvas');
    bar = document.createElement('div');
    stage = document.createElement('div');
    status = document.createElement('p');
    overlay = document.createElement('div');
    reviewBar = document.createElement('div');
    accessible = document.createElement('div');
    accessiblePage = -1;
    constructor(host, pdf, toolbar, theme, onSave, review) {
        this.host = host;
        this.pdf = pdf;
        this.toolbar = toolbar;
        this.theme = theme;
        this.onSave = onSave;
        this.review = review;
    }
    static async mount(host, pdf, options = {}) {
        const element = new PdfViewerElement(host, pdf, options.toolbar ?? defaultToolbar, options.theme ?? lightTheme, options.onSave, options.review);
        await element.build();
        return element;
    }
    async build() {
        const width = Math.max(240, this.host.clientWidth || 800);
        this.viewer = await PdfViewer.open(this.pdf, { width, height: this.host.clientHeight || 600 });
        if (this.review)
            this.viewer.setMarks(this.review.marks);
        Object.assign(this.host.style, { background: this.theme.background, display: 'block' });
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
            minHeight: this.theme.toolbarHeight, padding: '0 8px',
            background: this.theme.toolbarBackground, color: this.theme.toolbarForeground,
            overflowX: 'auto', overflowY: 'hidden', whiteSpace: 'nowrap',
        });
        Object.assign(this.stage.style, { overflow: 'auto', position: 'relative' });
        Object.assign(this.status.style, { margin: '4px 8px', font: '0.75rem sans-serif', color: '#6e6e73' });
        Object.assign(this.overlay.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none' });
        // Screen readers get the page's structure from a hidden layer; the bitmap says nothing.
        this.canvas.setAttribute('aria-hidden', 'true');
        this.accessible.className = 'pdf-accessible-content';
        Object.assign(this.accessible.style, {
            position: 'absolute', width: '1px', height: '1px', overflow: 'hidden',
            clipPath: 'inset(50%)', whiteSpace: 'nowrap',
        });
        this.stage.append(this.canvas, this.overlay, this.accessible);
        // The page takes keyboard focus: + and - zoom, Page Up and Page Down turn pages.
        this.stage.tabIndex = 0;
        this.stage.setAttribute('role', 'group');
        this.stage.setAttribute('aria-label', 'Page');
        this.stage.onkeydown = (event) => { void this.key(event); };
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
        button.textContent = item.item.kind === 'custom' ? item.item.content : item.label;
        const active = item.item.kind === 'tool' && item.item.tool === this.tool;
        Object.assign(button.style, {
            font: `${this.theme.iconSize} sans-serif`, color: 'inherit', cursor: 'pointer',
            border: 'none', borderRadius: this.theme.cornerRadius, padding: '6px 10px',
            background: active ? `color-mix(in srgb, ${this.theme.accent} 18%, transparent)` : 'transparent',
            flex: '0 0 auto',
        });
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
    }
    attachGestures() {
        let start = null;
        const local = (event) => {
            const box = this.canvas.getBoundingClientRect();
            return { x: event.clientX - box.left, y: event.clientY - box.top };
        };
        this.canvas.onpointerdown = (event) => { start = local(event); };
        this.canvas.onpointerup = async (event) => {
            const from = start;
            start = null;
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
                const point = transform.toPdf(to);
                await viewer.addNote({ left: point.x, bottom: point.y - 24, right: point.x + 24, top: point.y }, 'Note');
                this.created++;
            }
            else if (this.tool === 'ink') {
                await viewer.addInk([[transform.toPdf(from), transform.toPdf(to)]]);
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
        };
    }
    async refresh() {
        const viewer = this.viewer;
        if (!viewer)
            return;
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
        const pixels = image.data;
        this.canvas.getContext('2d')?.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
        this.drawMarks();
        await this.renderAccessible();
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