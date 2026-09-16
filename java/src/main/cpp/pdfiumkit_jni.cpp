// JNI glue for the Java SDK. Deliberately thin: every call maps to one PDFium call and
// returns a plain Java value, so the behaviour that matters — serialisation, typed
// errors, the object model — lives in Java where it can be read and tested.
//
// Errors are returned as negative codes rather than thrown here; PdfError.java turns
// them into the same cases the other platforms raise.

#include <jni.h>
#include <cstring>
#include <algorithm>
#include <string>
#include <vector>

#include "fpdfview.h"
#include "fpdf_annot.h"
#include "fpdf_doc.h"
#include "fpdf_edit.h"
#include "fpdf_formfill.h"
#include "fpdf_save.h"
#include "fpdf_text.h"

namespace {

// Mirrors PdfError.Code in Java.
constexpr jint kOk = 0;
constexpr jint kPasswordRequired = -1;
constexpr jint kWrongPassword = -2;
constexpr jint kCorrupt = -3;
constexpr jint kPageOutOfRange = -4;
constexpr jint kSaveFailed = -5;
constexpr jint kInvalidOperation = -6;

jint errorFromEngine() {
  switch (FPDF_GetLastError()) {
    case FPDF_ERR_PASSWORD: return kPasswordRequired;
    case FPDF_ERR_FORMAT:
    case FPDF_ERR_FILE:     return kCorrupt;
    default:                return kCorrupt;
  }
}

FPDF_DOCUMENT asDocument(jlong handle) { return reinterpret_cast<FPDF_DOCUMENT>(handle); }

// PDFium keeps a document's bytes alive itself only for FPDF_LoadDocument; loading from
// memory requires the caller to own them for the document's lifetime.
struct Loaded {
  FPDF_DOCUMENT document;
  std::vector<uint8_t> bytes;
  // Created on first use: form fields are read and written through the form-fill
  // environment, which is also what makes PDFium regenerate a field's appearance.
  FPDF_FORMHANDLE form = nullptr;
  FPDF_FORMFILLINFO formInfo{};
};

FPDF_FORMHANDLE formHandle(Loaded* loaded) {
  if (!loaded->form) {
    loaded->formInfo.version = 2;
    loaded->form = FPDFDOC_InitFormFillEnvironment(loaded->document, &loaded->formInfo);
  }
  return loaded->form;
}

std::vector<unsigned short> toUtf16(JNIEnv* env, jstring value) {
  const jchar* chars = env->GetStringChars(value, nullptr);
  const jsize length = env->GetStringLength(value);
  std::vector<unsigned short> units(chars, chars + length);
  units.push_back(0);
  env->ReleaseStringChars(value, chars);
  return units;
}

struct Writer : FPDF_FILEWRITE {
  std::vector<uint8_t> out;
};

int writeBlock(FPDF_FILEWRITE* self, const void* data, unsigned long size) {
  auto* writer = static_cast<Writer*>(self);
  const auto* bytes = static_cast<const uint8_t*>(data);
  writer->out.insert(writer->out.end(), bytes, bytes + size);
  return 1;
}

std::string utf16ToUtf8(const std::vector<unsigned short>& units) {
  std::string out;
  out.reserve(units.size());
  for (size_t i = 0; i < units.size(); i++) {
    unsigned int c = units[i];
    if (c == 0) break;
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < units.size()) {
      unsigned int low = units[i + 1];
      if (low >= 0xDC00 && low <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (low - 0xDC00); i++; }
    }
    if (c < 0x80) { out += static_cast<char>(c); }
    else if (c < 0x800) { out += static_cast<char>(0xC0 | (c >> 6)); out += static_cast<char>(0x80 | (c & 0x3F)); }
    else if (c < 0x10000) {
      out += static_cast<char>(0xE0 | (c >> 12));
      out += static_cast<char>(0x80 | ((c >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (c & 0x3F));
    } else {
      out += static_cast<char>(0xF0 | (c >> 18));
      out += static_cast<char>(0x80 | ((c >> 12) & 0x3F));
      out += static_cast<char>(0x80 | ((c >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (c & 0x3F));
    }
  }
  return out;
}

}  // namespace

extern "C" {

JNIEXPORT void JNICALL Java_com_pdfiumkit_Native_initLibrary(JNIEnv*, jclass) {
  FPDF_InitLibrary();
}

/** Returns the document handle, or a negative error code. */
JNIEXPORT jlong JNICALL Java_com_pdfiumkit_Native_open(
    JNIEnv* env, jclass, jbyteArray data, jstring password) {
  const jsize size = env->GetArrayLength(data);
  auto* loaded = new Loaded();
  loaded->bytes.resize(static_cast<size_t>(size));
  env->GetByteArrayRegion(data, 0, size, reinterpret_cast<jbyte*>(loaded->bytes.data()));

  const char* pw = password ? env->GetStringUTFChars(password, nullptr) : nullptr;
  loaded->document = FPDF_LoadMemDocument(loaded->bytes.data(), size, pw);
  if (pw) env->ReleaseStringUTFChars(password, pw);

  if (!loaded->document) {
    const jint code = errorFromEngine();
    delete loaded;
    // A password was supplied and still refused: say so, as the other platforms do.
    return (code == kPasswordRequired && password) ? kWrongPassword : code;
  }
  return reinterpret_cast<jlong>(loaded);
}

JNIEXPORT void JNICALL Java_com_pdfiumkit_Native_close(JNIEnv*, jclass, jlong handle) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return;
  if (loaded->form) FPDFDOC_ExitFormFillEnvironment(loaded->form);
  FPDF_CloseDocument(loaded->document);
  delete loaded;
}

JNIEXPORT jint JNICALL Java_com_pdfiumkit_Native_pageCount(JNIEnv*, jclass, jlong handle) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  return loaded ? FPDF_GetPageCount(loaded->document) : 0;
}

/** Writes width and height into `out`; returns 0 or a negative code. */
JNIEXPORT jint JNICALL Java_com_pdfiumkit_Native_pageSize(
    JNIEnv* env, jclass, jlong handle, jint index, jfloatArray out) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return kCorrupt;
  FS_SIZEF size;
  if (!FPDF_GetPageSizeByIndexF(loaded->document, index, &size)) return kPageOutOfRange;
  jfloat values[2] = { size.width, size.height };
  env->SetFloatArrayRegion(out, 0, 2, values);
  return kOk;
}

/** Renders into an int[] of ARGB pixels, which is what BufferedImage.setRGB takes. */
JNIEXPORT jint JNICALL Java_com_pdfiumkit_Native_render(
    JNIEnv* env, jclass, jlong handle, jint index, jint width, jint height,
    jboolean withAnnotations, jintArray out) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return kCorrupt;
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page) return kPageOutOfRange;

  std::vector<uint8_t> buffer(static_cast<size_t>(width) * height * 4, 0xFF);
  FPDF_BITMAP bitmap = FPDFBitmap_CreateEx(width, height, FPDFBitmap_BGRA, buffer.data(), width * 4);
  if (!bitmap) { FPDF_ClosePage(page); return kCorrupt; }

  FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xFFFFFFFF);
  FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0,
                        withAnnotations ? FPDF_ANNOT : 0);
  if (withAnnotations) {
    // Widgets live in the form layer, so a filled field is otherwise invisible.
    FPDF_FORMHANDLE form = formHandle(loaded);
    if (form) {
      FORM_OnAfterLoadPage(page, form);
      FPDF_FFLDraw(form, bitmap, page, 0, 0, width, height, 0, FPDF_ANNOT);
      FORM_OnBeforeClosePage(page, form);
    }
  }

  // BGRA from the engine, ARGB for Java: one shuffle, no copy of the pixels twice.
  std::vector<jint> pixels(static_cast<size_t>(width) * height);
  for (size_t i = 0; i < pixels.size(); i++) {
    const uint8_t b = buffer[i * 4 + 0], g = buffer[i * 4 + 1];
    const uint8_t r = buffer[i * 4 + 2], a = buffer[i * 4 + 3];
    pixels[i] = (static_cast<jint>(a) << 24) | (static_cast<jint>(r) << 16) |
                (static_cast<jint>(g) << 8) | static_cast<jint>(b);
  }
  env->SetIntArrayRegion(out, 0, static_cast<jsize>(pixels.size()), pixels.data());

  FPDFBitmap_Destroy(bitmap);
  FPDF_ClosePage(page);
  return kOk;
}

JNIEXPORT jstring JNICALL Java_com_pdfiumkit_Native_pageText(
    JNIEnv* env, jclass, jlong handle, jint index) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return env->NewStringUTF("");
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page) return nullptr;
  FPDF_TEXTPAGE text = FPDFText_LoadPage(page);
  if (!text) { FPDF_ClosePage(page); return env->NewStringUTF(""); }

  const int count = FPDFText_CountChars(text);
  std::vector<unsigned short> units(static_cast<size_t>(count) + 1, 0);
  FPDFText_GetText(text, 0, count, units.data());
  const std::string utf8 = utf16ToUtf8(units);

  FPDFText_ClosePage(text);
  FPDF_ClosePage(page);
  return env->NewStringUTF(utf8.c_str());
}

JNIEXPORT jint JNICALL Java_com_pdfiumkit_Native_charCount(JNIEnv*, jclass, jlong handle, jint index) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return kCorrupt;
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page) return kPageOutOfRange;
  FPDF_TEXTPAGE text = FPDFText_LoadPage(page);
  const int count = text ? FPDFText_CountChars(text) : 0;
  if (text) FPDFText_ClosePage(text);
  FPDF_ClosePage(page);
  return count;
}

/** Search hits as [start, length, start, length, …]; returns how many pairs were written. */
JNIEXPORT jint JNICALL Java_com_pdfiumkit_Native_search(
    JNIEnv* env, jclass, jlong handle, jint index, jstring query,
    jboolean caseSensitive, jintArray out) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return 0;
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page) return kPageOutOfRange;
  FPDF_TEXTPAGE text = FPDFText_LoadPage(page);
  if (!text) { FPDF_ClosePage(page); return 0; }

  const jchar* chars = env->GetStringChars(query, nullptr);
  const jsize length = env->GetStringLength(query);
  std::vector<unsigned short> needle(chars, chars + length);
  needle.push_back(0);
  env->ReleaseStringChars(query, chars);

  const int capacity = env->GetArrayLength(out) / 2;
  std::vector<jint> hits;
  FPDF_SCHHANDLE search = FPDFText_FindStart(text, needle.data(), caseSensitive ? FPDF_MATCHCASE : 0, 0);
  while (FPDFText_FindNext(search) && static_cast<int>(hits.size()) / 2 < capacity) {
    hits.push_back(FPDFText_GetSchResultIndex(search));
    hits.push_back(FPDFText_GetSchCount(search));
  }
  FPDFText_FindClose(search);
  if (!hits.empty()) env->SetIntArrayRegion(out, 0, static_cast<jsize>(hits.size()), hits.data());

  FPDFText_ClosePage(text);
  FPDF_ClosePage(page);
  return static_cast<jint>(hits.size() / 2);
}

JNIEXPORT jstring JNICALL Java_com_pdfiumkit_Native_metadata(
    JNIEnv* env, jclass, jlong handle, jstring key) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return nullptr;
  const char* tag = env->GetStringUTFChars(key, nullptr);
  const unsigned long size = FPDF_GetMetaText(loaded->document, tag, nullptr, 0);
  std::vector<unsigned short> units(size / 2 + 1, 0);
  FPDF_GetMetaText(loaded->document, tag, units.data(), size);
  env->ReleaseStringUTFChars(key, tag);
  const std::string utf8 = utf16ToUtf8(units);
  return utf8.empty() ? nullptr : env->NewStringUTF(utf8.c_str());
}

/** Saves the whole document; returns the bytes, or null when the engine refuses. */
JNIEXPORT jbyteArray JNICALL Java_com_pdfiumkit_Native_save(JNIEnv* env, jclass, jlong handle) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return nullptr;
  Writer writer;
  writer.version = 1;
  writer.WriteBlock = writeBlock;
  if (!FPDF_SaveAsCopy(loaded->document, &writer, FPDF_NO_INCREMENTAL)) return nullptr;

  jbyteArray out = env->NewByteArray(static_cast<jsize>(writer.out.size()));
  env->SetByteArrayRegion(out, 0, static_cast<jsize>(writer.out.size()),
                          reinterpret_cast<const jbyte*>(writer.out.data()));
  return out;
}

JNIEXPORT jint JNICALL Java_com_pdfiumkit_Native_permissions(JNIEnv*, jclass, jlong handle) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  return loaded ? static_cast<jint>(FPDF_GetDocPermissions(loaded->document)) : 0;
}


// ---- Annotations ------------------------------------------------------------------

JNIEXPORT jint JNICALL Java_com_pdfiumkit_Native_annotationCount(JNIEnv*, jclass, jlong handle, jint index) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return kCorrupt;
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page) return kPageOutOfRange;
  const int count = FPDFPage_GetAnnotCount(page);
  FPDF_ClosePage(page);
  return count;
}

/**
 * One annotation as [subtype, left, bottom, right, top] in `out`, with its Contents
 * returned. Two calls would need the annotation opened twice, so this does both at once.
 */
JNIEXPORT jstring JNICALL Java_com_pdfiumkit_Native_annotation(
    JNIEnv* env, jclass, jlong handle, jint index, jint at, jfloatArray out) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return nullptr;
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page) return nullptr;
  FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, at);
  if (!annot) { FPDF_ClosePage(page); return nullptr; }

  FS_RECTF rect{};
  FPDFAnnot_GetRect(annot, &rect);
  jfloat values[5] = { static_cast<jfloat>(FPDFAnnot_GetSubtype(annot)),
                       rect.left, rect.bottom, rect.right, rect.top };
  env->SetFloatArrayRegion(out, 0, 5, values);

  const unsigned long size = FPDFAnnot_GetStringValue(annot, "Contents", nullptr, 0);
  std::vector<unsigned short> units(size / 2 + 1, 0);
  FPDFAnnot_GetStringValue(annot, "Contents", reinterpret_cast<FPDF_WCHAR*>(units.data()), size);
  const std::string contents = utf16ToUtf8(units);

  FPDFPage_CloseAnnot(annot);
  FPDF_ClosePage(page);
  return env->NewStringUTF(contents.c_str());
}

/** Ink strokes arrive flattened as x,y pairs with `lengths` saying where each stroke ends. */
JNIEXPORT jint JNICALL Java_com_pdfiumkit_Native_addInk(
    JNIEnv* env, jclass, jlong handle, jint index, jfloatArray points, jintArray lengths,
    jint red, jint green, jint blue, jfloat lineWidth) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return kCorrupt;
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page) return kPageOutOfRange;

  FPDF_ANNOTATION annot = FPDFPage_CreateAnnot(page, FPDF_ANNOT_INK);
  if (!annot) { FPDF_ClosePage(page); return kCorrupt; }

  const jsize strokeCount = env->GetArrayLength(lengths);
  std::vector<jint> strokeLengths(strokeCount);
  env->GetIntArrayRegion(lengths, 0, strokeCount, strokeLengths.data());
  std::vector<jfloat> flat(env->GetArrayLength(points));
  env->GetFloatArrayRegion(points, 0, static_cast<jsize>(flat.size()), flat.data());

  size_t at = 0;
  for (jint length : strokeLengths) {
    std::vector<FS_POINTF> stroke(static_cast<size_t>(length));
    for (jint i = 0; i < length; i++) { stroke[i].x = flat[at++]; stroke[i].y = flat[at++]; }
    if (length > 0) FPDFAnnot_AddInkStroke(annot, stroke.data(), stroke.size());
  }
  FPDFAnnot_SetColor(annot, FPDFANNOT_COLORTYPE_Color,
                     static_cast<unsigned int>(red), static_cast<unsigned int>(green),
                     static_cast<unsigned int>(blue), 255);
  FPDFAnnot_SetBorder(annot, 0, 0, lineWidth);

  FPDFPage_CloseAnnot(annot);
  const int created = FPDFPage_GetAnnotCount(page) - 1;
  FPDF_ClosePage(page);
  return created;
}

/** A text-markup annotation — highlight, underline, strikeout — over quads. */
JNIEXPORT jint JNICALL Java_com_pdfiumkit_Native_addMarkup(
    JNIEnv* env, jclass, jlong handle, jint index, jint subtype, jfloatArray quads,
    jint red, jint green, jint blue, jint alpha) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return kCorrupt;
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page) return kPageOutOfRange;

  FPDF_ANNOTATION annot = FPDFPage_CreateAnnot(page, static_cast<FPDF_ANNOTATION_SUBTYPE>(subtype));
  if (!annot) { FPDF_ClosePage(page); return kCorrupt; }

  std::vector<jfloat> flat(env->GetArrayLength(quads));
  env->GetFloatArrayRegion(quads, 0, static_cast<jsize>(flat.size()), flat.data());
  FS_RECTF bounds{ flat[0], flat[1], flat[0], flat[1] };
  for (size_t i = 0; i + 7 < flat.size(); i += 8) {
    FS_QUADPOINTSF quad{ flat[i], flat[i + 1], flat[i + 2], flat[i + 3],
                         flat[i + 4], flat[i + 5], flat[i + 6], flat[i + 7] };
    FPDFAnnot_AppendAttachmentPoints(annot, &quad);
    for (int c = 0; c < 8; c += 2) {
      bounds.left = std::min(bounds.left, flat[i + c]);
      bounds.right = std::max(bounds.right, flat[i + c]);
      bounds.bottom = std::min(bounds.bottom, flat[i + c + 1]);
      bounds.top = std::max(bounds.top, flat[i + c + 1]);
    }
  }
  FPDFAnnot_SetRect(annot, &bounds);
  FPDFAnnot_SetColor(annot, FPDFANNOT_COLORTYPE_Color,
                     static_cast<unsigned int>(red), static_cast<unsigned int>(green),
                     static_cast<unsigned int>(blue), static_cast<unsigned int>(alpha));

  FPDFPage_CloseAnnot(annot);
  const int created = FPDFPage_GetAnnotCount(page) - 1;
  FPDF_ClosePage(page);
  return created;
}

/** A sticky note: a text annotation with contents at a point. */
JNIEXPORT jint JNICALL Java_com_pdfiumkit_Native_addNote(
    JNIEnv* env, jclass, jlong handle, jint index, jfloat x, jfloat y, jstring contents) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return kCorrupt;
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page) return kPageOutOfRange;

  FPDF_ANNOTATION annot = FPDFPage_CreateAnnot(page, FPDF_ANNOT_TEXT);
  if (!annot) { FPDF_ClosePage(page); return kCorrupt; }

  FS_RECTF rect{ x, y + 20.0f, x + 20.0f, y };
  FPDFAnnot_SetRect(annot, &rect);
  std::vector<unsigned short> units = toUtf16(env, contents);
  FPDFAnnot_SetStringValue(annot, "Contents", reinterpret_cast<FPDF_WIDESTRING>(units.data()));

  FPDFPage_CloseAnnot(annot);
  const int created = FPDFPage_GetAnnotCount(page) - 1;
  FPDF_ClosePage(page);
  return created;
}

JNIEXPORT jint JNICALL Java_com_pdfiumkit_Native_removeAnnotation(
    JNIEnv*, jclass, jlong handle, jint index, jint at) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return kCorrupt;
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page) return kPageOutOfRange;
  if (at < 0 || at >= FPDFPage_GetAnnotCount(page)) { FPDF_ClosePage(page); return kPageOutOfRange; }
  const bool ok = FPDFPage_RemoveAnnot(page, at);
  FPDF_ClosePage(page);
  return ok ? kOk : kInvalidOperation;
}

// ---- Form fields ------------------------------------------------------------------

/**
 * A field as [kind, flags, checked, left, bottom, right, top] in `out`, returning
 * "name\nvalue" — the two strings a caller always wants together.
 */
JNIEXPORT jstring JNICALL Java_com_pdfiumkit_Native_formField(
    JNIEnv* env, jclass, jlong handle, jint index, jint at, jintArray out, jfloatArray rectOut) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return nullptr;
  FPDF_FORMHANDLE form = formHandle(loaded);
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page || !form) { if (page) FPDF_ClosePage(page); return nullptr; }
  FORM_OnAfterLoadPage(page, form);

  FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, at);
  if (!annot || FPDFAnnot_GetSubtype(annot) != FPDF_ANNOT_WIDGET) {
    if (annot) FPDFPage_CloseAnnot(annot);
    FORM_OnBeforeClosePage(page, form);
    FPDF_ClosePage(page);
    return nullptr;
  }

  jint values[3] = { FPDFAnnot_GetFormFieldType(form, annot),
                     FPDFAnnot_GetFormFieldFlags(form, annot),
                     FPDFAnnot_IsChecked(form, annot) ? 1 : 0 };
  env->SetIntArrayRegion(out, 0, 3, values);

  FS_RECTF rect{};
  FPDFAnnot_GetRect(annot, &rect);
  jfloat bounds[4] = { rect.left, rect.bottom, rect.right, rect.top };
  env->SetFloatArrayRegion(rectOut, 0, 4, bounds);

  auto read = [&](unsigned long (*fn)(FPDF_FORMHANDLE, FPDF_ANNOTATION, FPDF_WCHAR*, unsigned long)) {
    const unsigned long size = fn(form, annot, nullptr, 0);
    std::vector<unsigned short> units(size / 2 + 1, 0);
    fn(form, annot, reinterpret_cast<FPDF_WCHAR*>(units.data()), size);
    return utf16ToUtf8(units);
  };
  const std::string both = read(FPDFAnnot_GetFormFieldName) + "\n" + read(FPDFAnnot_GetFormFieldValue);

  FPDFPage_CloseAnnot(annot);
  FORM_OnBeforeClosePage(page, form);
  FPDF_ClosePage(page);
  return env->NewStringUTF(both.c_str());
}

JNIEXPORT jint JNICALL Java_com_pdfiumkit_Native_setFieldText(
    JNIEnv* env, jclass, jlong handle, jint index, jint at, jstring value) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return kCorrupt;
  FPDF_FORMHANDLE form = formHandle(loaded);
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page || !form) { if (page) FPDF_ClosePage(page); return kCorrupt; }
  FORM_OnAfterLoadPage(page, form);

  FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, at);
  jint result = kInvalidOperation;
  if (annot && FORM_SetFocusedAnnot(form, annot)) {
    FORM_SelectAllText(form, page);
    std::vector<unsigned short> units = toUtf16(env, value);
    FORM_ReplaceSelection(form, page, reinterpret_cast<FPDF_WIDESTRING>(units.data()));
    FORM_ForceToKillFocus(form);
    result = kOk;
  }
  if (annot) FPDFPage_CloseAnnot(annot);
  FORM_OnBeforeClosePage(page, form);
  FPDF_ClosePage(page);
  return result;
}

/**
 * Toggles a checkbox or radio button with a space key through the form-fill
 * environment, so PDFium writes /V and /AS as names and regenerates the appearance.
 * Setting the strings directly stores values PDFium reads back but other viewers show
 * as unchecked, which is how the other platforms learned to do it this way.
 */
JNIEXPORT jint JNICALL Java_com_pdfiumkit_Native_setFieldChecked(
    JNIEnv*, jclass, jlong handle, jint index, jint at, jboolean checked) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return kCorrupt;
  FPDF_FORMHANDLE form = formHandle(loaded);
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page || !form) { if (page) FPDF_ClosePage(page); return kCorrupt; }
  FORM_OnAfterLoadPage(page, form);

  FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, at);
  jint result = kInvalidOperation;
  if (annot) {
    const bool wanted = checked == JNI_TRUE;
    if (FPDFAnnot_IsChecked(form, annot) == wanted) {
      result = kOk;
    } else {
      // A read-only field ignores keys; the flag comes off for the toggle and goes back.
      const int flags = FPDFAnnot_GetFormFieldFlags(form, annot);
      if (flags & 1) FPDFAnnot_SetFormFieldFlags(form, annot, flags & ~1);
      if (FORM_SetFocusedAnnot(form, annot)) {
        FORM_OnChar(form, page, 0x20, 0);
        FORM_ForceToKillFocus(form);
      }
      if (flags & 1) FPDFAnnot_SetFormFieldFlags(form, annot, flags);
      result = (FPDFAnnot_IsChecked(form, annot) == wanted) ? kOk : kInvalidOperation;
    }
    FPDFPage_CloseAnnot(annot);
  }
  FORM_OnBeforeClosePage(page, form);
  FPDF_ClosePage(page);
  return result;
}

}  // extern "C"
