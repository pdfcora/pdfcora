// JNI glue for the Java SDK. Deliberately thin: every call maps to one PDFium call and
// returns a plain Java value, so the behaviour that matters — serialisation, typed
// errors, the object model — lives in Java where it can be read and tested.
//
// Errors are returned as negative codes rather than thrown here; PdfError.java turns
// them into the same cases the other platforms raise.

#include <jni.h>
#include <cstring>
#include <string>
#include <vector>

#include "fpdfview.h"
#include "fpdf_doc.h"
#include "fpdf_edit.h"
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
};

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

}  // extern "C"
