import { readUtf16, withBuffer, withUtf16, type PdfiumModule } from './engine.js';
import { PdfError } from './errors.js';
import { readPageObjects } from './pageObjects.js';
import type { PdfDocument } from './document.js';
import type {
  PdfAnnotation, PdfAnnotationBase, PdfColor, PdfFormField, PdfFormFieldBase,
  PdfLink, PdfLinkTarget, PdfPoint, PdfQuad, PdfRect, PdfRenderOptions,
  PdfSearchOptions, PdfSize, PdfTextMatch,
  PdfPageObject,
} from './types.js';

// PDFium annotation subtypes (fpdf_annot.h)
const SUBTYPE = {
  text: 1, link: 2, freeText: 3, line: 4, square: 5, circle: 6,
  highlight: 9, underline: 10, squiggly: 11, strikeout: 12,
  stamp: 13, ink: 15, fileAttachment: 17, widget: 20,
} as const;

// PDFium form field types (fpdf_formfill.h)
const FIELD = {
  pushButton: 1, checkBox: 2, radioButton: 3,
  comboBox: 4, listBox: 5, text: 6, signature: 7,
} as const;

/** Rendered pixels, as RGBA suitable for `ImageData` or a canvas. */
export interface PdfImageData {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel. */
  readonly data: Uint8ClampedArray;
}

/**
 * A page within a document.
 *
 * A lightweight reference holding the document and a page index, not a live PDFium
 * handle, so it can be held across awaits and can never dangle.
 */
export class PdfPage {
  constructor(
    readonly document: PdfDocument,
    readonly index: number,
  ) {}

  size(): Promise<PdfSize> {
    return this.document.pageSize(this.index);
  }

  /** Text extraction and search for this page. */
  /**
   * The objects this page is drawn from, in drawing order.
   *
   * A text page is loaded alongside, because an object's text can only be read through
   * one — the object itself holds glyph codes, not characters.
   */
  objects(): Promise<PdfPageObject[]> {
    return this.document.withPage(this.index, (page, m) => {
      const textPage = m.ccall('FPDFText_LoadPage', 'number', ['number'], [page]) as number;
      try {
        return readPageObjects(m, page, textPage);
      } finally {
        if (textPage) m.ccall('FPDFText_ClosePage', null, ['number'], [textPage]);
      }
    });
  }

  get text(): PdfTextPage {
    return new PdfTextPage(this.document, this.index);
  }

  /**
   * Renders the page to RGBA pixels.
   *
   * Pass `width` to scale by aspect ratio, or both `width` and `height` for an exact
   * size. The result can be handed straight to `ctx.putImageData`.
   */
  async render(options: PdfRenderOptions = {}): Promise<PdfImageData> {
    const size = await this.size();
    if (size.width <= 0 || size.height <= 0) {
      throw PdfError.corrupt(`page ${this.index} has zero size`);
    }
    const width = Math.max(1, Math.round(options.width ?? size.width));
    const height = Math.max(1, Math.round(
      options.height ?? (width * size.height) / size.width,
    ));

    const background = options.background ?? { red: 255, green: 255, blue: 255, alpha: 255 };
    const fill = ((background.alpha ?? 255) << 24 | background.red << 16
      | background.green << 8 | background.blue) >>> 0;

    let flags = 0;
    if (options.annotations !== false) flags |= 0x01;   // FPDF_ANNOT
    if (options.grayscale) flags |= 0x08;               // FPDF_GRAYSCALE

    // Needs the document handle as well as the page, because painting form field
    // values goes through the form-fill environment rather than the page itself.
    return this.document.run((doc, m) => {
      const page = m.ccall('FPDF_LoadPage', 'number', ['number', 'number'], [doc, this.index]) as number;
      if (!page) throw PdfError.corrupt(`page ${this.index} failed to load`);

      const bitmap = m.ccall(
        'FPDFBitmap_CreateEx', 'number',
        ['number', 'number', 'number', 'number', 'number'],
        [width, height, 4 /* BGRA */, 0, width * 4],
      ) as number;
      if (!bitmap) {
        m.ccall('FPDF_ClosePage', null, ['number'], [page]);
        throw PdfError.engine(-1);
      }

      try {
        m.ccall('FPDFBitmap_FillRect', null,
          ['number', 'number', 'number', 'number', 'number', 'number'],
          [bitmap, 0, 0, width, height, fill]);
        m.ccall('FPDF_RenderPageBitmap', null,
          ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
          [bitmap, page, 0, 0, width, height, 0, flags]);

        if (options.forms !== false) {
          const form = this.document.formHandle();
          m.ccall('FORM_OnAfterLoadPage', null, ['number', 'number'], [page, form]);
          m.ccall('FPDF_FFLDraw', null,
            ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
            [form, bitmap, page, 0, 0, width, height, 0, flags]);
        }

        const buffer = m.ccall('FPDFBitmap_GetBuffer', 'number', ['number'], [bitmap]) as number;
        if (!buffer) throw PdfError.engine(-1);

        // PDFium writes BGRA; ImageData wants RGBA.
        const source = m.HEAPU8.subarray(buffer, buffer + width * height * 4);
        const data = new Uint8ClampedArray(source.length);
        for (let i = 0; i < source.length; i += 4) {
          data[i] = source[i + 2];
          data[i + 1] = source[i + 1];
          data[i + 2] = source[i];
          data[i + 3] = source[i + 3];
        }
        return { width, height, data };
      } finally {
        m.ccall('FPDFBitmap_Destroy', null, ['number'], [bitmap]);
        m.ccall('FPDF_ClosePage', null, ['number'], [page]);
      }
    });
  }

  /** Link regions on this page, with their resolved targets. */
  links(): Promise<PdfLink[]> {
    return this.document.withPage(this.index, (page, m) =>
      readLinks(m, this.document.handleForLinks(), page));
  }

  /** The bounding box of one character, in page space. */
  characterBox(index: number): Promise<PdfRect> {
    return this.text.boundingBox(index);
  }

  /** All annotations on the page, in document order. */
  annotations(): Promise<PdfAnnotation[]> {
    return this.document.withPage(this.index, (page, m) => {
      const count = m.ccall('FPDFPage_GetAnnotCount', 'number', ['number'], [page]) as number;
      const result: PdfAnnotation[] = [];

      for (let i = 0; i < count; i++) {
        const annot = m.ccall('FPDFPage_GetAnnot', 'number', ['number', 'number'], [page, i]) as number;
        if (!annot) continue;
        try {
          result.push(readAnnotation(m, annot, this.index, i));
        } finally {
          m.ccall('FPDFPage_CloseAnnot', null, ['number'], [annot]);
        }
      }
      return result;
    });
  }

  /**
   * Adds one freehand ink annotation made of `strokes`. Resolves to the new annotation's
   * index.
   */
  addInk(strokes: readonly (readonly PdfPoint[])[], color: PdfColor = { red: 0, green: 0, blue: 0 }, lineWidth = 2): Promise<number> {
    return this.document.withPage(this.index, (page, m) => {
      const annot = m.ccall('FPDFPage_CreateAnnot', 'number', ['number', 'number'], [page, SUBTYPE.ink]) as number;
      if (!annot) throw PdfError.invalidOperation('ink annotation could not be created');

      try {
        for (const stroke of strokes) {
          if (stroke.length === 0) continue;
          withBuffer(m, stroke.length * 8, (ptr) => {
            const view = new Float32Array(m.HEAPU8.buffer, ptr, stroke.length * 2);
            stroke.forEach((p, i) => { view[i * 2] = p.x; view[i * 2 + 1] = p.y; });
            m.ccall('FPDFAnnot_AddInkStroke', 'number', ['number', 'number', 'number'], [annot, ptr, stroke.length]);
          });
        }
        const points = strokes.flat();
        if (points.length > 0) {
          const xs = points.map((p) => p.x);
          const ys = points.map((p) => p.y);
          setRect(m, annot, {
            left: Math.min(...xs), right: Math.max(...xs),
            bottom: Math.min(...ys), top: Math.max(...ys),
          });
        }
        setColor(m, annot, color);
        m.ccall('FPDFAnnot_SetBorder', 'number', ['number', 'number', 'number', 'number'], [annot, 0, 0, lineWidth]);
      } finally {
        m.ccall('FPDFPage_CloseAnnot', null, ['number'], [annot]);
      }
      m.ccall('FPDFPage_GenerateContent', 'number', ['number'], [page]);
      return (m.ccall('FPDFPage_GetAnnotCount', 'number', ['number'], [page]) as number) - 1;
    });
  }

  /** Adds a highlight covering `quads`. Resolves to the new annotation's index. */
  addHighlight(quads: readonly PdfQuad[], color: PdfColor = { red: 255, green: 255, blue: 0, alpha: 128 }): Promise<number> {
    return this.addMarkup(SUBTYPE.highlight, quads, color);
  }

  addUnderline(quads: readonly PdfQuad[], color: PdfColor = { red: 0, green: 0, blue: 255 }): Promise<number> {
    return this.addMarkup(SUBTYPE.underline, quads, color);
  }

  addStrikeout(quads: readonly PdfQuad[], color: PdfColor = { red: 255, green: 0, blue: 0 }): Promise<number> {
    return this.addMarkup(SUBTYPE.strikeout, quads, color);
  }

  private addMarkup(subtype: number, quads: readonly PdfQuad[], color: PdfColor): Promise<number> {
    return this.document.withPage(this.index, (page, m) => {
      const annot = m.ccall('FPDFPage_CreateAnnot', 'number', ['number', 'number'], [page, subtype]) as number;
      if (!annot) throw PdfError.invalidOperation('markup annotation could not be created');

      try {
        for (const q of quads) {
          withBuffer(m, 32, (ptr) => {
            new Float32Array(m.HEAPU8.buffer, ptr, 8).set([
              q.p1.x, q.p1.y, q.p2.x, q.p2.y, q.p3.x, q.p3.y, q.p4.x, q.p4.y,
            ]);
            m.ccall('FPDFAnnot_AppendAttachmentPoints', 'number', ['number', 'number'], [annot, ptr]);
          });
        }
        const xs = quads.flatMap((q) => [q.p1.x, q.p2.x, q.p3.x, q.p4.x]);
        const ys = quads.flatMap((q) => [q.p1.y, q.p2.y, q.p3.y, q.p4.y]);
        if (xs.length) {
          setRect(m, annot, {
            left: Math.min(...xs), right: Math.max(...xs),
            bottom: Math.min(...ys), top: Math.max(...ys),
          });
        }
        setColor(m, annot, color);
      } finally {
        m.ccall('FPDFPage_CloseAnnot', null, ['number'], [annot]);
      }
      m.ccall('FPDFPage_GenerateContent', 'number', ['number'], [page]);
      return (m.ccall('FPDFPage_GetAnnotCount', 'number', ['number'], [page]) as number) - 1;
    });
  }

  /** Adds a sticky note. Resolves to the new annotation's index. */
  addNote(rect: PdfRect, contents: string, color: PdfColor = { red: 255, green: 255, blue: 0, alpha: 128 }): Promise<number> {
    return this.document.withPage(this.index, (page, m) => {
      const annot = m.ccall('FPDFPage_CreateAnnot', 'number', ['number', 'number'], [page, SUBTYPE.text]) as number;
      if (!annot) throw PdfError.invalidOperation('note annotation could not be created');

      try {
        setRect(m, annot, rect);
        withUtf16(m, contents, (ptr) => {
          m.ccall('FPDFAnnot_SetStringValue', 'number', ['number', 'string', 'number'], [annot, 'Contents', ptr]);
        });
        setColor(m, annot, color);
      } finally {
        m.ccall('FPDFPage_CloseAnnot', null, ['number'], [annot]);
      }
      m.ccall('FPDFPage_GenerateContent', 'number', ['number'], [page]);
      return (m.ccall('FPDFPage_GetAnnotCount', 'number', ['number'], [page]) as number) - 1;
    });
  }

  removeAnnotation(annotationIndex: number): Promise<void> {
    return this.document.withPage(this.index, (page, m) => {
      const count = m.ccall('FPDFPage_GetAnnotCount', 'number', ['number'], [page]) as number;
      if (annotationIndex < 0 || annotationIndex >= count) {
        throw PdfError.pageOutOfRange(annotationIndex, count);
      }
      m.ccall('FPDFPage_RemoveAnnot', 'number', ['number', 'number'], [page, annotationIndex]);
      m.ccall('FPDFPage_GenerateContent', 'number', ['number'], [page]);
    });
  }

  /** Every interactive form field on this page. */
  formFields(): Promise<PdfFormField[]> {
    return this.document.run((h, m) => {
      const form = this.document.formHandle();
      const page = m.ccall('FPDF_LoadPage', 'number', ['number', 'number'], [h, this.index]) as number;
      if (!page) throw PdfError.corrupt(`page ${this.index} failed to load`);

      try {
        m.ccall('FORM_OnAfterLoadPage', null, ['number', 'number'], [page, form]);
        const count = m.ccall('FPDFPage_GetAnnotCount', 'number', ['number'], [page]) as number;
        const fields: PdfFormField[] = [];

        for (let i = 0; i < count; i++) {
          const annot = m.ccall('FPDFPage_GetAnnot', 'number', ['number', 'number'], [page, i]) as number;
          if (!annot) continue;
          try {
            if ((m.ccall('FPDFAnnot_GetSubtype', 'number', ['number'], [annot]) as number) !== SUBTYPE.widget) continue;
            fields.push(readFormField(m, form, annot, this.index, i));
          } finally {
            m.ccall('FPDFPage_CloseAnnot', null, ['number'], [annot]);
          }
        }
        return fields;
      } finally {
        m.ccall('FPDF_ClosePage', null, ['number'], [page]);
      }
    });
  }

  /** Sets a text field's value. */
  setText(value: string, fieldAt: number): Promise<void> {
    return this.withFormAnnotation(fieldAt, (m, form, page, annot) => {
      if (!m.ccall('FORM_SetFocusedAnnot', 'number', ['number', 'number'], [form, annot])) {
        throw PdfError.invalidOperation('field could not take focus');
      }
      m.ccall('FORM_SelectAllText', 'number', ['number', 'number'], [form, page]);
      withUtf16(m, value, (ptr) => {
        m.ccall('FORM_ReplaceSelection', null, ['number', 'number', 'number'], [form, page, ptr]);
      });
      m.ccall('FORM_ForceToKillFocus', 'number', ['number'], [form]);
    });
  }

  /**
   * Sets a checkbox or radio button's state.
   *
   * Writes the field value (`V`) and appearance state (`AS`) directly, rather than
   * simulating a click — PDFium's click path needs FFI callbacks this SDK does not install.
   */
  setChecked(checked: boolean, fieldAt: number): Promise<void> {
    return this.withFormAnnotation(fieldAt, (m, form, page, annot) => {
      const onValue = readUtf16(
        m,
        () => m.ccall('FPDFAnnot_GetFormFieldExportValue', 'number', ['number', 'number', 'number', 'number'], [form, annot, 0, 0]) as number,
        (ptr, size) => m.ccall('FPDFAnnot_GetFormFieldExportValue', 'number', ['number', 'number', 'number', 'number'], [form, annot, ptr, size]),
      ) || 'Yes';
      const target = checked ? onValue : 'Off';

      withUtf16(m, target, (ptr) => {
        const okV = m.ccall('FPDFAnnot_SetStringValue', 'number', ['number', 'string', 'number'], [annot, 'V', ptr]);
        const okAS = m.ccall('FPDFAnnot_SetStringValue', 'number', ['number', 'string', 'number'], [annot, 'AS', ptr]);
        if (!okV || !okAS) throw PdfError.invalidOperation('field state could not be set');
      });
      m.ccall('FPDFPage_GenerateContent', 'number', ['number'], [page]);
    });
  }

  /** Selects or deselects one option of a combo or list box. */
  setOption(optionIndex: number, selected: boolean, fieldAt: number): Promise<void> {
    return this.withFormAnnotation(fieldAt, (m, form, page, annot) => {
      if (!m.ccall('FORM_SetFocusedAnnot', 'number', ['number', 'number'], [form, annot])) {
        throw PdfError.invalidOperation('field could not take focus');
      }
      const ok = m.ccall('FORM_SetIndexSelected', 'number',
        ['number', 'number', 'number', 'number'], [form, page, optionIndex, selected ? 1 : 0]);
      m.ccall('FORM_ForceToKillFocus', 'number', ['number'], [form]);
      if (!ok) throw PdfError.invalidOperation(`option ${optionIndex} could not be selected`);
    });
  }

  private withFormAnnotation(
    annotationIndex: number,
    body: (m: PdfiumModule, form: number, page: number, annot: number) => void,
  ): Promise<void> {
    return this.document.run((h, m) => {
      const form = this.document.formHandle();
      const page = m.ccall('FPDF_LoadPage', 'number', ['number', 'number'], [h, this.index]) as number;
      if (!page) throw PdfError.corrupt(`page ${this.index} failed to load`);

      try {
        m.ccall('FORM_OnAfterLoadPage', null, ['number', 'number'], [page, form]);
        const annot = m.ccall('FPDFPage_GetAnnot', 'number', ['number', 'number'], [page, annotationIndex]) as number;
        if (!annot) {
          const count = m.ccall('FPDFPage_GetAnnotCount', 'number', ['number'], [page]) as number;
          throw PdfError.pageOutOfRange(annotationIndex, count);
        }
        try {
          body(m, form, page, annot);
        } finally {
          m.ccall('FPDFPage_CloseAnnot', null, ['number'], [annot]);
        }
      } finally {
        m.ccall('FPDF_ClosePage', null, ['number'], [page]);
      }
    });
  }
}

/** Text extraction and search for one page. */
export class PdfTextPage {
  constructor(
    private readonly document: PdfDocument,
    private readonly pageIndex: number,
  ) {}

  characterCount(): Promise<number> {
    return this.withTextPage((textPage, m) =>
      Math.max(0, m.ccall('FPDFText_CountChars', 'number', ['number'], [textPage]) as number));
  }

  /** The bounding box of one character, in page space. */
  boundingBox(index: number): Promise<PdfRect> {
    return this.withTextPage((textPage, m) => {
      const count = m.ccall('FPDFText_CountChars', 'number', ['number'], [textPage]) as number;
      if (index < 0 || index >= count) throw PdfError.pageOutOfRange(index, count);
      return withBuffer(m, 32, (ptr) => {
        // FPDFText_GetCharBox writes left, right, bottom, top as doubles.
        m.ccall('FPDFText_GetCharBox', 'number',
          ['number', 'number', 'number', 'number', 'number', 'number'],
          [textPage, index, ptr, ptr + 8, ptr + 16, ptr + 24]);
        const v = new Float64Array(m.HEAPU8.buffer, ptr, 4);
        return { left: v[0], right: v[1], bottom: v[2], top: v[3] };
      });
    });
  }

  /** The page's full text in reading order. */
  string(): Promise<string> {
    return this.withTextPage((textPage, m) => {
      const count = m.ccall('FPDFText_CountChars', 'number', ['number'], [textPage]) as number;
      if (count <= 0) return '';
      return withBuffer(m, (count + 1) * 2, (ptr) => {
        const written = m.ccall('FPDFText_GetText', 'number',
          ['number', 'number', 'number', 'number'], [textPage, 0, count, ptr]) as number;
        if (written <= 0) return '';
        const view = new Uint16Array(m.HEAPU8.buffer, ptr, written - 1);
        return String.fromCharCode(...view);
      });
    });
  }

  search(query: string, options: PdfSearchOptions = {}): Promise<PdfTextMatch[]> {
    if (!query) return Promise.resolve([]);
    return this.withTextPage((textPage, m) => {
      let flags = 0;
      if (options.caseSensitive) flags |= 0x01;
      if (options.wholeWord) flags |= 0x02;

      return withUtf16(m, query, (termPtr) => {
        const search = m.ccall('FPDFText_FindStart', 'number',
          ['number', 'number', 'number', 'number'], [textPage, termPtr, flags, 0]) as number;
        if (!search) return [];

        const matches: PdfTextMatch[] = [];
        try {
          while (m.ccall('FPDFText_FindNext', 'number', ['number'], [search])) {
            const start = m.ccall('FPDFText_GetSchResultIndex', 'number', ['number'], [search]) as number;
            const length = m.ccall('FPDFText_GetSchCount', 'number', ['number'], [search]) as number;
            if (length <= 0) continue;

            const rectCount = m.ccall('FPDFText_CountRects', 'number',
              ['number', 'number', 'number'], [textPage, start, length]) as number;
            const rects: PdfRect[] = [];
            for (let r = 0; r < Math.max(0, rectCount); r++) {
              withBuffer(m, 32, (ptr) => {
                m.ccall('FPDFText_GetRect', 'number',
                  ['number', 'number', 'number', 'number', 'number', 'number'],
                  [textPage, r, ptr, ptr + 8, ptr + 16, ptr + 24]);
                const v = new Float64Array(m.HEAPU8.buffer, ptr, 4);
                rects.push({ left: v[0], top: v[1], right: v[2], bottom: v[3] });
              });
            }
            matches.push({ start, length, rects });
          }
        } finally {
          m.ccall('FPDFText_FindClose', null, ['number'], [search]);
        }
        return matches;
      });
    });
  }

  private withTextPage<T>(body: (textPage: number, m: PdfiumModule) => T): Promise<T> {
    return this.document.withPage(this.pageIndex, (page, m) => {
      const textPage = m.ccall('FPDFText_LoadPage', 'number', ['number'], [page]) as number;
      if (!textPage) throw PdfError.corrupt(`text layer for page ${this.pageIndex} failed to load`);
      try {
        return body(textPage, m);
      } finally {
        m.ccall('FPDFText_ClosePage', null, ['number'], [textPage]);
      }
    });
  }
}

// MARK: - Internals


function setRect(m: PdfiumModule, annot: number, rect: PdfRect): void {
  withBuffer(m, 16, (ptr) => {
    // FS_RECTF is { left, top, right, bottom }
    new Float32Array(m.HEAPU8.buffer, ptr, 4).set([rect.left, rect.top, rect.right, rect.bottom]);
    m.ccall('FPDFAnnot_SetRect', 'number', ['number', 'number'], [annot, ptr]);
  });
}

function setColor(m: PdfiumModule, annot: number, color: PdfColor): void {
  m.ccall('FPDFAnnot_SetColor', 'number',
    ['number', 'number', 'number', 'number', 'number', 'number'],
    [annot, 0 /* Color */, color.red, color.green, color.blue, color.alpha ?? 255]);
}

function readRect(m: PdfiumModule, annot: number): PdfRect {
  return withBuffer(m, 16, (ptr) => {
    m.ccall('FPDFAnnot_GetRect', 'number', ['number', 'number'], [annot, ptr]);
    const v = new Float32Array(m.HEAPU8.buffer, ptr, 4);
    return { left: v[0], top: v[1], right: v[2], bottom: v[3] };
  });
}

function readAnnotationString(m: PdfiumModule, annot: number, key: string): string | undefined {
  const text = readUtf16(
    m,
    () => m.ccall('FPDFAnnot_GetStringValue', 'number', ['number', 'string', 'number', 'number'], [annot, key, 0, 0]) as number,
    (ptr, size) => m.ccall('FPDFAnnot_GetStringValue', 'number', ['number', 'string', 'number', 'number'], [annot, key, ptr, size]),
  );
  return text || undefined;
}

function readAnnotation(m: PdfiumModule, annot: number, pageIndex: number, index: number): PdfAnnotation {
  const base: PdfAnnotationBase = {
    pageIndex,
    index,
    rect: readRect(m, annot),
    color: readColor(m, annot),
    flags: m.ccall('FPDFAnnot_GetFlags', 'number', ['number'], [annot]) as number,
    contents: readAnnotationString(m, annot, 'Contents'),
  };

  const subtype = m.ccall('FPDFAnnot_GetSubtype', 'number', ['number'], [annot]) as number;
  switch (subtype) {
    case SUBTYPE.highlight: return { ...base, kind: 'highlight', quads: readQuads(m, annot) };
    case SUBTYPE.underline: return { ...base, kind: 'underline', quads: readQuads(m, annot) };
    case SUBTYPE.strikeout: return { ...base, kind: 'strikeout', quads: readQuads(m, annot) };
    case SUBTYPE.squiggly:  return { ...base, kind: 'squiggly', quads: readQuads(m, annot) };
    case SUBTYPE.ink:       return { ...base, kind: 'ink', strokes: readInkStrokes(m, annot) };
    case SUBTYPE.freeText:  return { ...base, kind: 'freeText' };
    case SUBTYPE.square:    return { ...base, kind: 'square' };
    case SUBTYPE.circle:    return { ...base, kind: 'circle' };
    case SUBTYPE.line:      return { ...base, kind: 'line' };
    case SUBTYPE.text:      return { ...base, kind: 'note' };
    case SUBTYPE.stamp:     return { ...base, kind: 'stamp' };
    case SUBTYPE.fileAttachment: return { ...base, kind: 'fileAttachment' };
    case SUBTYPE.link:      return { ...base, kind: 'link', uri: readAnnotationString(m, annot, 'A') };
    case SUBTYPE.widget:    return { ...base, kind: 'widget' };
    default:                return { ...base, kind: 'unknown', subtypeCode: subtype };
  }
}

function readColor(m: PdfiumModule, annot: number): PdfColor | undefined {
  return withBuffer(m, 16, (ptr) => {
    const ok = m.ccall('FPDFAnnot_GetColor', 'number',
      ['number', 'number', 'number', 'number', 'number', 'number'],
      [annot, 0, ptr, ptr + 4, ptr + 8, ptr + 12]);
    if (!ok) return undefined;
    const v = new Uint32Array(m.HEAPU8.buffer, ptr, 4);
    return { red: v[0], green: v[1], blue: v[2], alpha: v[3] };
  });
}

function readQuads(m: PdfiumModule, annot: number): PdfQuadList {
  const count = m.ccall('FPDFAnnot_CountAttachmentPoints', 'number', ['number'], [annot]) as number;
  const quads = [];
  for (let i = 0; i < Math.max(0, count); i++) {
    const quad = withBuffer(m, 32, (ptr) => {
      if (!m.ccall('FPDFAnnot_GetAttachmentPoints', 'number', ['number', 'number', 'number'], [annot, i, ptr])) {
        return undefined;
      }
      const v = new Float32Array(m.HEAPU8.buffer, ptr, 8);
      return {
        p1: { x: v[0], y: v[1] }, p2: { x: v[2], y: v[3] },
        p3: { x: v[4], y: v[5] }, p4: { x: v[6], y: v[7] },
      };
    });
    if (quad) quads.push(quad);
  }
  return quads;
}

type PdfQuadList = { p1: PdfPoint; p2: PdfPoint; p3: PdfPoint; p4: PdfPoint }[];

function readInkStrokes(m: PdfiumModule, annot: number): PdfPoint[][] {
  const pathCount = m.ccall('FPDFAnnot_GetInkListCount', 'number', ['number'], [annot]) as number;
  const strokes: PdfPoint[][] = [];

  for (let p = 0; p < Math.max(0, pathCount); p++) {
    const n = m.ccall('FPDFAnnot_GetInkListPath', 'number', ['number', 'number', 'number', 'number'], [annot, p, 0, 0]) as number;
    if (n <= 0) continue;
    strokes.push(withBuffer(m, n * 8, (ptr) => {
      const written = m.ccall('FPDFAnnot_GetInkListPath', 'number',
        ['number', 'number', 'number', 'number'], [annot, p, ptr, n]) as number;
      const v = new Float32Array(m.HEAPU8.buffer, ptr, written * 2);
      const points: PdfPoint[] = [];
      for (let i = 0; i < written; i++) points.push({ x: v[i * 2], y: v[i * 2 + 1] });
      return points;
    }));
  }
  return strokes;
}

function readFormFieldString(m: PdfiumModule, form: number, annot: number, fn: string): string | undefined {
  const text = readUtf16(
    m,
    () => m.ccall(fn, 'number', ['number', 'number', 'number', 'number'], [form, annot, 0, 0]) as number,
    (ptr, size) => m.ccall(fn, 'number', ['number', 'number', 'number', 'number'], [form, annot, ptr, size]),
  );
  return text || undefined;
}

function readFormField(
  m: PdfiumModule, form: number, annot: number, pageIndex: number, annotationIndex: number,
): PdfFormField {
  const flags = m.ccall('FPDFAnnot_GetFormFieldFlags', 'number', ['number', 'number'], [form, annot]) as number;
  const base: PdfFormFieldBase = {
    pageIndex,
    annotationIndex,
    name: readFormFieldString(m, form, annot, 'FPDFAnnot_GetFormFieldName'),
    alternateName: readFormFieldString(m, form, annot, 'FPDFAnnot_GetFormFieldAlternateName'),
    rect: readRect(m, annot),
    flags,
    isReadOnly: (flags & 1) !== 0,
    isRequired: (flags & 2) !== 0,
  };
  const value = readFormFieldString(m, form, annot, 'FPDFAnnot_GetFormFieldValue') ?? '';
  const exportValue = readFormFieldString(m, form, annot, 'FPDFAnnot_GetFormFieldExportValue');
  const isChecked = !!m.ccall('FPDFAnnot_IsChecked', 'number', ['number', 'number'], [form, annot]);

  switch (m.ccall('FPDFAnnot_GetFormFieldType', 'number', ['number', 'number'], [form, annot]) as number) {
    case FIELD.text:
      return { ...base, kind: 'text', value,
               isMultiline: (flags & (1 << 12)) !== 0, isPassword: (flags & (1 << 13)) !== 0 };
    case FIELD.checkBox:
      return { ...base, kind: 'checkBox', isChecked, exportValue };
    case FIELD.radioButton:
      return { ...base, kind: 'radioButton', isChecked, exportValue };
    case FIELD.comboBox: {
      const { options, selectedIndices } = readChoices(m, form, annot);
      return { ...base, kind: 'comboBox', value, options, selectedIndices };
    }
    case FIELD.listBox: {
      const { options, selectedIndices } = readChoices(m, form, annot);
      return { ...base, kind: 'listBox', value, options, selectedIndices };
    }
    case FIELD.pushButton: return { ...base, kind: 'pushButton' };
    case FIELD.signature:  return { ...base, kind: 'signature' };
    default:
      return { ...base, kind: 'unknown',
               typeCode: m.ccall('FPDFAnnot_GetFormFieldType', 'number', ['number', 'number'], [form, annot]) as number };
  }
}

function readChoices(m: PdfiumModule, form: number, annot: number) {
  const count = m.ccall('FPDFAnnot_GetOptionCount', 'number', ['number', 'number'], [form, annot]) as number;
  const options: string[] = [];
  const selectedIndices: number[] = [];

  for (let i = 0; i < Math.max(0, count); i++) {
    options.push(readUtf16(
      m,
      () => m.ccall('FPDFAnnot_GetOptionLabel', 'number', ['number', 'number', 'number', 'number', 'number'], [form, annot, i, 0, 0]) as number,
      (ptr, size) => m.ccall('FPDFAnnot_GetOptionLabel', 'number', ['number', 'number', 'number', 'number', 'number'], [form, annot, i, ptr, size]),
    ));
    if (m.ccall('FPDFAnnot_IsOptionSelected', 'number', ['number', 'number', 'number'], [form, annot, i])) {
      selectedIndices.push(i);
    }
  }
  return { options, selectedIndices };
}

// MARK: - Links

function readLinks(m: PdfiumModule, doc: number, page: number): PdfLink[] {
  const links: PdfLink[] = [];
  return withBuffer(m, 4, (posPtr) => {
    new Int32Array(m.HEAPU8.buffer, posPtr, 1)[0] = 0;
    return withBuffer(m, 4, (linkPtr) => {
      while (m.ccall('FPDFLink_Enumerate', 'number',
        ['number', 'number', 'number'], [page, posPtr, linkPtr])) {
        const link = new Int32Array(m.HEAPU8.buffer, linkPtr, 1)[0];
        if (!link) continue;

        const rect = withBuffer(m, 16, (rectPtr) => {
          if (!m.ccall('FPDFLink_GetAnnotRect', 'number', ['number', 'number'], [link, rectPtr])) {
            return undefined;
          }
          const v = new Float32Array(m.HEAPU8.buffer, rectPtr, 4);
          return { left: v[0], top: v[1], right: v[2], bottom: v[3] };
        });
        if (!rect) continue;
        links.push({ rect, target: linkTarget(m, doc, link) });
      }
      return links;
    });
  });
}

function linkTarget(m: PdfiumModule, doc: number, link: number): PdfLinkTarget {
  let dest = m.ccall('FPDFLink_GetDest', 'number', ['number', 'number'], [doc, link]) as number;
  const action = m.ccall('FPDFLink_GetAction', 'number', ['number'], [link]) as number;
  if (!dest && action) {
    dest = m.ccall('FPDFAction_GetDest', 'number', ['number', 'number'], [doc, action]) as number;
  }
  if (dest) {
    const index = m.ccall('FPDFDest_GetDestPageIndex', 'number', ['number', 'number'], [doc, dest]) as number;
    if (index >= 0) return { kind: 'page', pageIndex: index };
  }
  if (!action) return { kind: 'unresolved' };

  const size = m.ccall('FPDFAction_GetURIPath', 'number',
    ['number', 'number', 'number', 'number'], [doc, action, 0, 0]) as number;
  if (size <= 1) return { kind: 'unresolved' };

  const uri = withBuffer(m, size, (ptr) => {
    m.ccall('FPDFAction_GetURIPath', 'number',
      ['number', 'number', 'number', 'number'], [doc, action, ptr, size]);
    const bytes = m.HEAPU8.subarray(ptr, ptr + size - 1);
    return String.fromCharCode(...bytes);
  });
  return uri ? { kind: 'uri', uri } : { kind: 'unresolved' };
}
