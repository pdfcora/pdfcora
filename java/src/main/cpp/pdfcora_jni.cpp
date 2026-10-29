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
#include "fpdf_catalog.h"
#include "fpdf_doc.h"
#include "fpdf_edit.h"
#include "fpdf_formfill.h"
#include "fpdf_save.h"
#include "fpdf_signature.h"
#include "fpdf_text.h"

#include "pdfcora_docx.h"

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

JNIEXPORT void JNICALL Java_com_pdfcora_Native_initLibrary(JNIEnv*, jclass) {
  FPDF_InitLibrary();
}

/** Returns the document handle, or a negative error code. */
JNIEXPORT jlong JNICALL Java_com_pdfcora_Native_open(
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

// DOCX in, PDF out. Null with error[0] unset means "not a DOCX"; null with it set, a failure.
JNIEXPORT jbyteArray JNICALL Java_com_pdfcora_Native_convertDocx(
    JNIEnv* env, jclass, jbyteArray data, jobjectArray error) {
  const jsize size = env->GetArrayLength(data);
  std::vector<uint8_t> bytes(static_cast<size_t>(size));
  env->GetByteArrayRegion(data, 0, size, reinterpret_cast<jbyte*>(bytes.data()));

  uint8_t* out = nullptr;
  size_t outLength = 0;
  char* message = nullptr;
  const int32_t status = pdfcora_docx_convert(bytes.data(), bytes.size(), &out, &outLength, &message);
  if (status == 2) {
    env->SetObjectArrayElement(error, 0, env->NewStringUTF(message));
    pdfcora_docx_free_error(message);
    return nullptr;
  }
  if (status != 0) return nullptr;
  jbyteArray pdf = env->NewByteArray(static_cast<jsize>(outLength));
  if (pdf) env->SetByteArrayRegion(pdf, 0, static_cast<jsize>(outLength), reinterpret_cast<const jbyte*>(out));
  pdfcora_docx_free(out, outLength);
  return pdf;
}

JNIEXPORT void JNICALL Java_com_pdfcora_Native_close(JNIEnv*, jclass, jlong handle) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return;
  if (loaded->form) FPDFDOC_ExitFormFillEnvironment(loaded->form);
  FPDF_CloseDocument(loaded->document);
  delete loaded;
}

JNIEXPORT jint JNICALL Java_com_pdfcora_Native_pageCount(JNIEnv*, jclass, jlong handle) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  return loaded ? FPDF_GetPageCount(loaded->document) : 0;
}

/** Writes width and height into `out`; returns 0 or a negative code. */
JNIEXPORT jint JNICALL Java_com_pdfcora_Native_pageSize(
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
JNIEXPORT jint JNICALL Java_com_pdfcora_Native_render(
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

JNIEXPORT jstring JNICALL Java_com_pdfcora_Native_pageText(
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

JNIEXPORT jint JNICALL Java_com_pdfcora_Native_charCount(JNIEnv*, jclass, jlong handle, jint index) {
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
JNIEXPORT jint JNICALL Java_com_pdfcora_Native_search(
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

JNIEXPORT jstring JNICALL Java_com_pdfcora_Native_metadata(
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
JNIEXPORT jbyteArray JNICALL Java_com_pdfcora_Native_save(JNIEnv* env, jclass, jlong handle) {
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

JNIEXPORT jint JNICALL Java_com_pdfcora_Native_permissions(JNIEnv*, jclass, jlong handle) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  return loaded ? static_cast<jint>(FPDF_GetDocPermissions(loaded->document)) : 0;
}


// ---- Annotations ------------------------------------------------------------------

JNIEXPORT jint JNICALL Java_com_pdfcora_Native_annotationCount(JNIEnv*, jclass, jlong handle, jint index) {
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
JNIEXPORT jstring JNICALL Java_com_pdfcora_Native_annotation(
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
JNIEXPORT jint JNICALL Java_com_pdfcora_Native_addInk(
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
  FS_RECTF bounds{};
  bool any = false;
  for (jint length : strokeLengths) {
    std::vector<FS_POINTF> stroke(static_cast<size_t>(length));
    for (jint i = 0; i < length; i++) {
      stroke[i].x = flat[at++]; stroke[i].y = flat[at++];
      if (!any) { bounds = { stroke[i].x, stroke[i].y, stroke[i].x, stroke[i].y }; any = true; }
      bounds.left = std::min(bounds.left, stroke[i].x); bounds.right = std::max(bounds.right, stroke[i].x);
      bounds.bottom = std::min(bounds.bottom, stroke[i].y); bounds.top = std::max(bounds.top, stroke[i].y);
    }
    if (length > 0) FPDFAnnot_AddInkStroke(annot, stroke.data(), stroke.size());
  }
  // Without a /Rect the annotation sits at the origin, and PDFium grows that, not the strokes.
  if (any) FPDFAnnot_SetRect(annot, &bounds);
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
JNIEXPORT jint JNICALL Java_com_pdfcora_Native_addMarkup(
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
JNIEXPORT jint JNICALL Java_com_pdfcora_Native_addNote(
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

JNIEXPORT jint JNICALL Java_com_pdfcora_Native_removeAnnotation(
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
JNIEXPORT jstring JNICALL Java_com_pdfcora_Native_formField(
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
    while (!units.empty() && units.back() == 0) units.pop_back();
    return units;
  };
  // Built as UTF-16: NewStringUTF would mangle a character outside the BMP.
  std::vector<unsigned short> both = read(FPDFAnnot_GetFormFieldName);
  both.push_back(u'\n');
  const std::vector<unsigned short> value = read(FPDFAnnot_GetFormFieldValue);
  both.insert(both.end(), value.begin(), value.end());

  FPDFPage_CloseAnnot(annot);
  FORM_OnBeforeClosePage(page, form);
  FPDF_ClosePage(page);
  return env->NewString(reinterpret_cast<const jchar*>(both.data()), static_cast<jsize>(both.size()));
}

JNIEXPORT jint JNICALL Java_com_pdfcora_Native_setFieldText(
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
JNIEXPORT jint JNICALL Java_com_pdfcora_Native_setFieldChecked(
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

// ---- Redaction --------------------------------------------------------------------
//
// Objects a region touches are removed and the content stream regenerated, so the
// content leaves the file rather than being covered. Drawing a black box over text is
// the classic failure: it looks right and the words are still there. The document must
// then be saved in full — an incremental save keeps the original stream.

namespace {

struct Rect { float left, bottom, right, top; };

bool intersects(const Rect& a, const Rect& b) {
  return a.left <= b.right && a.right >= b.left && a.bottom <= b.top && a.top >= b.bottom;
}

Rect charBox(FPDF_TEXTPAGE text, int index) {
  double left = 0, right = 0, bottom = 0, top = 0;
  FPDFText_GetCharBox(text, index, &left, &right, &bottom, &top);
  // The out-parameters are left, right, bottom, top — not the usual rect order.
  return Rect{ static_cast<float>(std::min(left, right)), static_cast<float>(std::min(bottom, top)),
               static_cast<float>(std::max(left, right)), static_cast<float>(std::max(bottom, top)) };
}

struct Run { std::vector<unsigned short> text; float left; float bottom; };

/**
 * Rewrites a text object a region only partly covers: the covered characters go, the
 * rest stay legible, positioned and in the same font. Characters are dropped on
 * intersection, not containment — one half inside the region is still readable.
 */
bool replaceWithRuns(FPDF_DOCUMENT document, FPDF_PAGE page, FPDF_PAGEOBJECT original,
                     const std::vector<Run>& runs) {
  FPDF_FONT font = FPDFTextObj_GetFont(original);
  float fontSize = 0;
  if (!font || !FPDFTextObj_GetFontSize(original, &fontSize)) return false;

  std::vector<FPDF_PAGEOBJECT> created;
  for (const Run& run : runs) {
    FPDF_PAGEOBJECT object = FPDFPageObj_CreateTextObj(document, font, fontSize);
    if (!object) { for (auto* o : created) FPDFPageObj_Destroy(o); return false; }
    std::vector<unsigned short> units = run.text;
    units.push_back(0);
    if (!FPDFText_SetText(object, reinterpret_cast<FPDF_WIDESTRING>(units.data()))) {
      FPDFPageObj_Destroy(object);
      for (auto* o : created) FPDFPageObj_Destroy(o);
      return false;
    }
    // Identity translated to the run's origin, so the glyphs land where they were.
    FS_MATRIX matrix{ 1, 0, 0, 1, run.left, run.bottom };
    FPDFPageObj_SetMatrix(object, &matrix);
    created.push_back(object);
  }

  // Only now that every run exists is the original removed, so a failure part-way
  // through leaves the page as it was rather than half-redacted.
  if (!FPDFPage_RemoveObject(page, original)) {
    for (auto* o : created) FPDFPageObj_Destroy(o);
    return false;
  }
  FPDFPageObj_Destroy(original);
  for (auto* o : created) FPDFPage_InsertObject(page, o);
  return true;
}

}  // namespace

extern "C" {

/**
 * Redacts one page against rectangles given as [left, bottom, right, top] quads.
 * Returns counts as [textObjects, textObjectsSplit, images, paths, annotations].
 */
JNIEXPORT jint JNICALL Java_com_pdfcora_Native_redactPage(
    JNIEnv* env, jclass, jlong handle, jint index, jfloatArray regionArray, jintArray countsOut) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return kCorrupt;

  std::vector<jfloat> flat(env->GetArrayLength(regionArray));
  if (flat.empty()) return kOk;
  env->GetFloatArrayRegion(regionArray, 0, static_cast<jsize>(flat.size()), flat.data());
  std::vector<Rect> regions;
  for (size_t i = 0; i + 3 < flat.size(); i += 4) {
    regions.push_back(Rect{ flat[i], flat[i + 1], flat[i + 2], flat[i + 3] });
  }

  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page) return kPageOutOfRange;
  FPDF_TEXTPAGE text = FPDFText_LoadPage(page);

  jint counts[5] = { 0, 0, 0, 0, 0 };
  std::vector<FPDF_PAGEOBJECT> handled;

  // Partially covered runs first: they are rewritten rather than removed, and doing it
  // before the whole-object pass keeps the two from fighting over the same handles.
  if (text) {
    std::vector<std::pair<FPDF_PAGEOBJECT, std::vector<int>>> byObject;
    const int characters = FPDFText_CountChars(text);
    for (int i = 0; i < characters; i++) {
      FPDF_PAGEOBJECT object = FPDFText_GetTextObject(text, i);
      if (!object) continue;
      auto found = std::find_if(byObject.begin(), byObject.end(),
                                [&](const auto& entry) { return entry.first == object; });
      if (found == byObject.end()) byObject.push_back({ object, { i } });
      else found->second.push_back(i);
    }

    for (auto& [object, indices] : byObject) {
      std::vector<Rect> boxes;
      std::vector<bool> covered;
      size_t coveredCount = 0;
      for (int i : indices) {
        Rect box = charBox(text, i);
        bool hit = std::any_of(regions.begin(), regions.end(),
                               [&](const Rect& r) { return intersects(box, r); });
        boxes.push_back(box);
        covered.push_back(hit);
        if (hit) coveredCount++;
      }
      // Untouched, or covered outright: neither is this path's business.
      if (coveredCount == 0 || coveredCount == indices.size()) continue;

      std::vector<Run> runs;
      Run current{};
      bool open = false;
      for (size_t i = 0; i < indices.size(); i++) {
        if (covered[i]) {
          if (open) { runs.push_back(current); open = false; current = Run{}; }
          continue;
        }
        unsigned int unicode = FPDFText_GetUnicode(text, indices[i]);
        if (!open) { current = Run{ {}, boxes[i].left, boxes[i].bottom }; open = true; }
        current.text.push_back(static_cast<unsigned short>(unicode));
      }
      if (open) runs.push_back(current);

      if (replaceWithRuns(loaded->document, page, object, runs)) {
        handled.push_back(object);
        counts[1]++;
      }
    }
  }

  // Then every object a region touches, highest index first: removing one shifts every
  // index above it, and walking upward would silently skip objects.
  const int objectCount = FPDFPage_CountObjects(page);
  for (int i = objectCount - 1; i >= 0; i--) {
    FPDF_PAGEOBJECT object = FPDFPage_GetObject(page, i);
    if (!object) continue;
    if (std::find(handled.begin(), handled.end(), object) != handled.end()) continue;

    FS_RECTF bounds{};
    if (!FPDFPageObj_GetBounds(object, &bounds.left, &bounds.bottom, &bounds.right, &bounds.top)) continue;
    Rect rect{ bounds.left, bounds.bottom, bounds.right, bounds.top };
    if (!std::any_of(regions.begin(), regions.end(),
                     [&](const Rect& r) { return intersects(rect, r); })) continue;

    const int type = FPDFPageObj_GetType(object);
    if (!FPDFPage_RemoveObject(page, object)) continue;
    // RemoveObject detaches but does not free.
    FPDFPageObj_Destroy(object);
    if (type == FPDF_PAGEOBJ_TEXT) counts[0]++;
    else if (type == FPDF_PAGEOBJ_IMAGE) counts[2]++;
    else counts[3]++;
  }

  // Annotations a region touches go too: a comment or a filled field carries the text
  // straight back out of the document.
  const int annotCount = FPDFPage_GetAnnotCount(page);
  std::vector<int> doomed;
  for (int i = 0; i < annotCount; i++) {
    FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, i);
    if (!annot) continue;
    FS_RECTF box{};
    if (FPDFAnnot_GetRect(annot, &box)) {
      Rect rect{ box.left, box.bottom, box.right, box.top };
      if (std::any_of(regions.begin(), regions.end(),
                      [&](const Rect& r) { return intersects(rect, r); })) {
        // A field's value lives in the AcroForm dictionary, not on the page, so
        // removing the widget alone leaves the value in the file.
        unsigned short empty[1] = { 0 };
        FPDFAnnot_SetStringValue(annot, "V", reinterpret_cast<FPDF_WIDESTRING>(empty));
        doomed.push_back(i);
      }
    }
    FPDFPage_CloseAnnot(annot);
  }
  for (auto it = doomed.rbegin(); it != doomed.rend(); ++it) {
    if (FPDFPage_RemoveAnnot(page, *it)) counts[4]++;
  }

  const bool regenerated = FPDFPage_GenerateContent(page);
  if (text) FPDFText_ClosePage(text);
  FPDF_ClosePage(page);
  if (!regenerated) return kSaveFailed;

  env->SetIntArrayRegion(countsOut, 0, 5, counts);
  return kOk;
}

/** The rectangles a search match covers, as [left, bottom, right, top] per rect. */
JNIEXPORT jint JNICALL Java_com_pdfcora_Native_matchRects(
    JNIEnv* env, jclass, jlong handle, jint index, jint start, jint count, jfloatArray out) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return kCorrupt;
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page) return kPageOutOfRange;
  FPDF_TEXTPAGE text = FPDFText_LoadPage(page);
  if (!text) { FPDF_ClosePage(page); return kCorrupt; }

  const int rects = FPDFText_CountRects(text, start, count);
  const int capacity = env->GetArrayLength(out) / 4;
  std::vector<jfloat> values;
  for (int i = 0; i < rects && i < capacity; i++) {
    double left = 0, top = 0, right = 0, bottom = 0;
    FPDFText_GetRect(text, i, &left, &top, &right, &bottom);
    values.push_back(static_cast<jfloat>(std::min(left, right)));
    values.push_back(static_cast<jfloat>(std::min(bottom, top)));
    values.push_back(static_cast<jfloat>(std::max(left, right)));
    values.push_back(static_cast<jfloat>(std::max(bottom, top)));
  }
  if (!values.empty()) env->SetFloatArrayRegion(out, 0, static_cast<jsize>(values.size()), values.data());

  FPDFText_ClosePage(text);
  FPDF_ClosePage(page);
  return static_cast<jint>(values.size() / 4);
}

}  // extern "C"

// ---- Signatures -------------------------------------------------------------------

extern "C" {

JNIEXPORT jint JNICALL Java_com_pdfcora_Native_signatureCount(JNIEnv*, jclass, jlong handle) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  return loaded ? FPDF_GetSignatureCount(loaded->document) : 0;
}

/** The PKCS#7 blob of one signature, which is what a verifier checks. */
JNIEXPORT jbyteArray JNICALL Java_com_pdfcora_Native_signatureContents(
    JNIEnv* env, jclass, jlong handle, jint at) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return nullptr;
  FPDF_SIGNATURE signature = FPDF_GetSignatureObject(loaded->document, at);
  if (!signature) return nullptr;

  const unsigned long size = FPDFSignatureObj_GetContents(signature, nullptr, 0);
  std::vector<uint8_t> bytes(size);
  if (size) FPDFSignatureObj_GetContents(signature, bytes.data(), size);

  jbyteArray out = env->NewByteArray(static_cast<jsize>(size));
  if (size) env->SetByteArrayRegion(out, 0, static_cast<jsize>(size),
                                    reinterpret_cast<const jbyte*>(bytes.data()));
  return out;
}

/** The ByteRange pairs: offset, length, offset, length. */
JNIEXPORT jint JNICALL Java_com_pdfcora_Native_signatureByteRange(
    JNIEnv* env, jclass, jlong handle, jint at, jintArray out) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return 0;
  FPDF_SIGNATURE signature = FPDF_GetSignatureObject(loaded->document, at);
  if (!signature) return 0;

  const unsigned long count = FPDFSignatureObj_GetByteRange(signature, nullptr, 0);
  std::vector<int> values(count);
  if (count) FPDFSignatureObj_GetByteRange(signature, values.data(), count);
  const jsize capacity = env->GetArrayLength(out);
  const jsize written = static_cast<jsize>(std::min<unsigned long>(count, capacity));
  if (written) env->SetIntArrayRegion(out, 0, written, values.data());
  return written;
}

/** Reason, sub-filter and signing time, joined by newlines — three short strings. */
JNIEXPORT jstring JNICALL Java_com_pdfcora_Native_signatureInfo(
    JNIEnv* env, jclass, jlong handle, jint at, jintArray permissionOut) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return nullptr;
  FPDF_SIGNATURE signature = FPDF_GetSignatureObject(loaded->document, at);
  if (!signature) return nullptr;

  const unsigned long reasonSize = FPDFSignatureObj_GetReason(signature, nullptr, 0);
  std::vector<unsigned short> reasonUnits(reasonSize / 2 + 1, 0);
  if (reasonSize) FPDFSignatureObj_GetReason(signature, reasonUnits.data(), reasonSize);

  const unsigned long filterSize = FPDFSignatureObj_GetSubFilter(signature, nullptr, 0);
  std::vector<char> filter(filterSize + 1, 0);
  if (filterSize) FPDFSignatureObj_GetSubFilter(signature, filter.data(), filterSize);

  const unsigned long timeSize = FPDFSignatureObj_GetTime(signature, nullptr, 0);
  std::vector<char> time(timeSize + 1, 0);
  if (timeSize) FPDFSignatureObj_GetTime(signature, time.data(), timeSize);

  jint permission = FPDFSignatureObj_GetDocMDPPermission(signature);
  env->SetIntArrayRegion(permissionOut, 0, 1, &permission);

  const std::string joined = utf16ToUtf8(reasonUnits) + "\n" + filter.data() + "\n" + time.data();
  return env->NewStringUTF(joined.c_str());
}

}  // extern "C"

// ---- Tagging ----------------------------------------------------------------------
//
// Marking is all PDFium can do for a structure tree: it puts a marked-content id on each
// object. The tree itself — StructTreeRoot, the parent tree, the catalog entries — is
// appended by the writer in Java, because PDFium cannot create those objects.

extern "C" {

/**
 * Marks the objects of one page.
 *
 * `types` names each object's tag and `assignments` says which block each object belongs
 * to, one entry per object on the page, with -1 for "no block, so an artifact". Returns
 * the number of marked-content ids assigned.
 */
JNIEXPORT jint JNICALL Java_com_pdfcora_Native_markPage(
    JNIEnv* env, jclass, jlong handle, jint index, jobjectArray types, jintArray assignments) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return kCorrupt;
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page) return kPageOutOfRange;

  const int objectCount = FPDFPage_CountObjects(page);
  std::vector<jint> blockOf(objectCount, -1);
  const jsize given = env->GetArrayLength(assignments);
  env->GetIntArrayRegion(assignments, 0, std::min<jsize>(given, objectCount), blockOf.data());

  int nextMcid = 0;
  for (int i = 0; i < objectCount; i++) {
    FPDF_PAGEOBJECT object = FPDFPage_GetObject(page, i);
    if (!object) continue;

    const jint block = blockOf[i];
    if (block < 0) {
      // Objects in no block are artifacts: content a screen reader must skip rather
      // than content it has no tag for.
      FPDFPageObj_AddMark(object, "Artifact");
      continue;
    }
    auto* typeString = static_cast<jstring>(env->GetObjectArrayElement(types, block));
    const char* tag = env->GetStringUTFChars(typeString, nullptr);
    FPDF_PAGEOBJECTMARK mark = FPDFPageObj_AddMark(object, tag);
    env->ReleaseStringUTFChars(typeString, tag);
    if (!mark) continue;
    FPDFPageObjMark_SetIntParam(loaded->document, object, mark, "MCID", nextMcid++);
  }

  const bool regenerated = FPDFPage_GenerateContent(page);
  FPDF_ClosePage(page);
  return regenerated ? nextMcid : kSaveFailed;
}

/** Whether the document already has a structure tree; tagging a tagged file is refused. */
JNIEXPORT jboolean JNICALL Java_com_pdfcora_Native_isTagged(JNIEnv*, jclass, jlong handle) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  return loaded && FPDFCatalog_IsTagged(loaded->document) ? JNI_TRUE : JNI_FALSE;
}

/** How many objects a page has, which is what a caller addresses blocks by. */
JNIEXPORT jint JNICALL Java_com_pdfcora_Native_objectCount(JNIEnv*, jclass, jlong handle, jint index) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return kCorrupt;
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page) return kPageOutOfRange;
  const int count = FPDFPage_CountObjects(page);
  FPDF_ClosePage(page);
  return count;
}

/** One object's type and bounds, so a caller can decide which block it belongs to. */
JNIEXPORT jint JNICALL Java_com_pdfcora_Native_objectInfo(
    JNIEnv* env, jclass, jlong handle, jint index, jint at, jfloatArray out) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return kCorrupt;
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page) return kPageOutOfRange;
  FPDF_PAGEOBJECT object = FPDFPage_GetObject(page, at);
  if (!object) { FPDF_ClosePage(page); return kPageOutOfRange; }

  FS_RECTF bounds{};
  FPDFPageObj_GetBounds(object, &bounds.left, &bounds.bottom, &bounds.right, &bounds.top);
  jfloat values[5] = { static_cast<jfloat>(FPDFPageObj_GetType(object)),
                       bounds.left, bounds.bottom, bounds.right, bounds.top };
  env->SetFloatArrayRegion(out, 0, 5, values);
  FPDF_ClosePage(page);
  return kOk;
}

}  // extern "C"

// ---- XFDF ------------------------------------------------------------------------
// Internal: the annotation and form details XFDF carries that the public Java model does
// not. Every call loads the page and closes it again, like the rest of this file.

namespace {

using Utf16 = std::vector<unsigned short>;

/**
 * A Java string straight from UTF-16. NewStringUTF wants modified UTF-8, which encodes a
 * character outside the BMP (an emoji) differently from standard UTF-8 and mangles it.
 */
jstring javaString(JNIEnv* env, const Utf16& units) {
  size_t length = 0;
  while (length < units.size() && units[length] != 0) length++;
  return env->NewString(reinterpret_cast<const jchar*>(units.data()), static_cast<jsize>(length));
}

jobjectArray stringArray(JNIEnv* env, const std::vector<Utf16>& values) {
  jobjectArray out = env->NewObjectArray(static_cast<jsize>(values.size()), env->FindClass("java/lang/String"), nullptr);
  for (size_t i = 0; i < values.size(); i++) {
    jstring s = javaString(env, values[i]);
    env->SetObjectArrayElement(out, static_cast<jsize>(i), s);
    env->DeleteLocalRef(s);
  }
  return out;
}

Utf16 annotString(FPDF_ANNOTATION annot, const char* key) {
  const unsigned long size = FPDFAnnot_GetStringValue(annot, key, nullptr, 0);
  if (size <= 2) return {};
  Utf16 units(size / 2 + 1, 0);
  FPDFAnnot_GetStringValue(annot, key, reinterpret_cast<FPDF_WCHAR*>(units.data()), size);
  return units;
}

}  // namespace

extern "C" {

/**
 * Fills `numbers` with subtype, flags, hasOpacity, /CA, hasBorder, border width, hasLine,
 * x1, y1, x2, y2, quad count and ink stroke count; returns Contents, NM, T, M, CreationDate,
 * DA and Name, empty when absent. Null when the annotation does not exist.
 */
JNIEXPORT jobjectArray JNICALL Java_com_pdfcora_Native_xfdfAnnotation(
    JNIEnv* env, jclass, jlong handle, jint index, jint at, jfloatArray numbers) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return nullptr;
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page) return nullptr;
  FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, at);
  if (!annot) { FPDF_ClosePage(page); return nullptr; }

  jfloat values[13] = {0};
  values[0] = static_cast<jfloat>(FPDFAnnot_GetSubtype(annot));
  values[1] = static_cast<jfloat>(FPDFAnnot_GetFlags(annot));
  float opacity = 0;
  if (FPDFAnnot_GetNumberValue(annot, "CA", &opacity)) { values[2] = 1; values[3] = opacity; }
  float h = 0, v = 0, w = 0;
  if (FPDFAnnot_GetBorder(annot, &h, &v, &w)) { values[4] = 1; values[5] = w; }
  FS_POINTF start{}, end{};
  if (FPDFAnnot_GetLine(annot, &start, &end)) {
    values[6] = 1; values[7] = start.x; values[8] = start.y; values[9] = end.x; values[10] = end.y;
  }
  values[11] = static_cast<jfloat>(FPDFAnnot_CountAttachmentPoints(annot));
  values[12] = static_cast<jfloat>(FPDFAnnot_GetInkListCount(annot));
  env->SetFloatArrayRegion(numbers, 0, 13, values);

  std::vector<Utf16> strings;
  for (const char* key : {"Contents", "NM", "T", "M", "CreationDate", "DA", "Name"}) strings.push_back(annotString(annot, key));
  FPDFPage_CloseAnnot(annot);
  FPDF_ClosePage(page);
  return stringArray(env, strings);
}

/** Quads as 8 floats each, in /QuadPoints order. */
JNIEXPORT jfloatArray JNICALL Java_com_pdfcora_Native_annotationQuads(
    JNIEnv* env, jclass, jlong handle, jint index, jint at) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  std::vector<jfloat> values;
  FPDF_PAGE page = loaded ? FPDF_LoadPage(loaded->document, index) : nullptr;
  if (page) {
    if (FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, at)) {
      const size_t count = FPDFAnnot_CountAttachmentPoints(annot);
      for (size_t i = 0; i < count; i++) {
        FS_QUADPOINTSF q{};
        if (FPDFAnnot_GetAttachmentPoints(annot, i, &q)) values.insert(values.end(), {q.x1, q.y1, q.x2, q.y2, q.x3, q.y3, q.x4, q.y4});
      }
      FPDFPage_CloseAnnot(annot);
    }
    FPDF_ClosePage(page);
  }
  jfloatArray out = env->NewFloatArray(static_cast<jsize>(values.size()));
  env->SetFloatArrayRegion(out, 0, static_cast<jsize>(values.size()), values.data());
  return out;
}

/** One ink stroke as x,y pairs. */
JNIEXPORT jfloatArray JNICALL Java_com_pdfcora_Native_inkStroke(
    JNIEnv* env, jclass, jlong handle, jint index, jint at, jint stroke) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  std::vector<jfloat> values;
  FPDF_PAGE page = loaded ? FPDF_LoadPage(loaded->document, index) : nullptr;
  if (page) {
    if (FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, at)) {
      const unsigned long n = FPDFAnnot_GetInkListPath(annot, stroke, nullptr, 0);
      std::vector<FS_POINTF> points(n);
      if (n > 0) FPDFAnnot_GetInkListPath(annot, stroke, points.data(), n);
      for (const auto& p : points) values.insert(values.end(), {p.x, p.y});
      FPDFPage_CloseAnnot(annot);
    }
    FPDF_ClosePage(page);
  }
  jfloatArray out = env->NewFloatArray(static_cast<jsize>(values.size()));
  env->SetFloatArrayRegion(out, 0, static_cast<jsize>(values.size()), values.data());
  return out;
}

/**
 * A widget's export value, then its options, each prefixed "1" when selected and "0" when
 * not. Null when the annotation is not a widget.
 */
JNIEXPORT jobjectArray JNICALL Java_com_pdfcora_Native_formFieldChoices(
    JNIEnv* env, jclass, jlong handle, jint index, jint at) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return nullptr;
  FPDF_FORMHANDLE form = formHandle(loaded);
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page || !form) { if (page) FPDF_ClosePage(page); return nullptr; }
  FORM_OnAfterLoadPage(page, form);
  FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, at);
  jobjectArray result = nullptr;
  if (annot && FPDFAnnot_GetSubtype(annot) == FPDF_ANNOT_WIDGET) {
    std::vector<Utf16> values;
    const unsigned long size = FPDFAnnot_GetFormFieldExportValue(form, annot, nullptr, 0);
    Utf16 units(size / 2 + 1, 0);
    if (size > 0) FPDFAnnot_GetFormFieldExportValue(form, annot, reinterpret_cast<FPDF_WCHAR*>(units.data()), size);
    values.push_back(size > 2 ? units : Utf16{});
    const int count = FPDFAnnot_GetOptionCount(form, annot);
    for (int i = 0; i < count; i++) {
      const unsigned long n = FPDFAnnot_GetOptionLabel(form, annot, i, nullptr, 0);
      Utf16 label(n / 2 + 1, 0);
      if (n > 0) FPDFAnnot_GetOptionLabel(form, annot, i, reinterpret_cast<FPDF_WCHAR*>(label.data()), n);
      label.insert(label.begin(), FPDFAnnot_IsOptionSelected(form, annot, i) ? u'1' : u'0');
      values.push_back(label);
    }
    result = stringArray(env, values);
  }
  if (annot) FPDFPage_CloseAnnot(annot);
  FORM_OnBeforeClosePage(page, form);
  FPDF_ClosePage(page);
  return result;
}

JNIEXPORT jint JNICALL Java_com_pdfcora_Native_setFieldOption(
    JNIEnv*, jclass, jlong handle, jint index, jint at, jint option, jboolean selected) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return kCorrupt;
  FPDF_FORMHANDLE form = formHandle(loaded);
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page || !form) { if (page) FPDF_ClosePage(page); return kCorrupt; }
  FORM_OnAfterLoadPage(page, form);
  FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, at);
  jint result = kInvalidOperation;
  if (annot && FORM_SetFocusedAnnot(form, annot)) {
    if (FORM_SetIndexSelected(form, page, option, selected)) result = kOk;
    FORM_ForceToKillFocus(form);
  }
  if (annot) FPDFPage_CloseAnnot(annot);
  FORM_OnBeforeClosePage(page, form);
  FPDF_ClosePage(page);
  return result;
}

/** A sticky note with an explicit rectangle and colour; returns its index. */
JNIEXPORT jint JNICALL Java_com_pdfcora_Native_addNoteInRect(
    JNIEnv* env, jclass, jlong handle, jint index, jfloat left, jfloat bottom, jfloat right, jfloat top,
    jstring contents, jint red, jint green, jint blue, jint alpha) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return kCorrupt;
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page) return kPageOutOfRange;
  FPDF_ANNOTATION annot = FPDFPage_CreateAnnot(page, FPDF_ANNOT_TEXT);
  if (!annot) { FPDF_ClosePage(page); return kCorrupt; }
  FS_RECTF rect{ left, top, right, bottom };
  FPDFAnnot_SetRect(annot, &rect);
  FPDFAnnot_SetColor(annot, FPDFANNOT_COLORTYPE_Color, red, green, blue, alpha);
  std::vector<unsigned short> units = toUtf16(env, contents);
  FPDFAnnot_SetStringValue(annot, "Contents", reinterpret_cast<FPDF_WIDESTRING>(units.data()));
  FPDFPage_CloseAnnot(annot);
  const int created = FPDFPage_GetAnnotCount(page) - 1;
  FPDF_ClosePage(page);
  return created;
}

JNIEXPORT jint JNICALL Java_com_pdfcora_Native_setAnnotationString(
    JNIEnv* env, jclass, jlong handle, jint index, jint at, jstring key, jstring value) {
  auto* loaded = reinterpret_cast<Loaded*>(handle);
  if (!loaded) return kCorrupt;
  FPDF_PAGE page = FPDF_LoadPage(loaded->document, index);
  if (!page) return kPageOutOfRange;
  FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, at);
  jint result = kInvalidOperation;
  if (annot) {
    const char* k = env->GetStringUTFChars(key, nullptr);
    std::vector<unsigned short> units = toUtf16(env, value);
    if (FPDFAnnot_SetStringValue(annot, k, reinterpret_cast<FPDF_WIDESTRING>(units.data()))) result = kOk;
    env->ReleaseStringUTFChars(key, k);
    FPDFPage_CloseAnnot(annot);
  }
  FPDF_ClosePage(page);
  return result;
}

}  // extern "C"
