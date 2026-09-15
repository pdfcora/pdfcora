// JNI bridge to PDFium.
//
// The surface is deliberately flat: primitives and arrays only, with Kotlin assembling
// the typed object model. That keeps this file small enough to audit and avoids
// constructing Java objects from C++.

#include <jni.h>
#include <android/bitmap.h>
#include <android/log.h>
#include <cstring>
#include <algorithm>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "public/fpdfview.h"
#include "public/fpdf_doc.h"
#include "public/fpdf_text.h"
#include "public/fpdf_edit.h"
#include "public/fpdf_annot.h"
#include "public/fpdf_formfill.h"
#include "public/fpdf_save.h"
#include "public/fpdf_attachment.h"
#include "public/fpdf_signature.h"

#include "watermark.h"

#define LOG_TAG "pdfiumkit"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

struct Document {
    FPDF_DOCUMENT doc = nullptr;
    FPDF_FORMHANDLE form = nullptr;
    FPDF_FORMFILLINFO formInfo{};
    std::vector<uint8_t> bytes;   // PDFium reads lazily, so the buffer must outlive the doc

    /// Loaded pages, kept alive for the document's lifetime.
    ///
    /// Not just an optimisation: FORM_OnBeforeClosePage tears down the form-fill page
    /// view, which discards live field state. Reloading the page per call therefore
    /// loses a value that was typed but whose appearance has not been regenerated.
    std::map<jint, FPDF_PAGE> pages;
};

Document* asDoc(jlong handle) { return reinterpret_cast<Document*>(handle); }

std::u16string toU16(JNIEnv* env, jstring s) {
    if (!s) return u"";
    const jchar* chars = env->GetStringChars(s, nullptr);
    jsize len = env->GetStringLength(s);
    std::u16string out(reinterpret_cast<const char16_t*>(chars), static_cast<size_t>(len));
    env->ReleaseStringChars(s, chars);
    return out;
}

/// Wraps PDFium's two-call "ask for size, then fill" string convention.
template <typename Fn>
jstring utf16String(JNIEnv* env, Fn fn) {
    unsigned long byteCount = fn(nullptr, 0);
    if (byteCount <= 2) return env->NewStringUTF("");
    std::vector<unsigned short> buffer(byteCount / 2);
    fn(buffer.data(), byteCount);
    return env->NewString(reinterpret_cast<const jchar*>(buffer.data()),
                          static_cast<jsize>(buffer.size() - 1));
}

FPDF_PAGE loadPage(Document* d, jint index) {
    if (!d || !d->doc) return nullptr;
    auto it = d->pages.find(index);
    if (it != d->pages.end()) return it->second;

    FPDF_PAGE page = FPDF_LoadPage(d->doc, index);
    if (!page) {
        // Callers report a failed load as an empty result — zero annotations, zero
        // rotation — which is indistinguishable from a page that really is empty. Say
        // so in the log, so that case is not silent when it happens.
        LOGE("FPDF_LoadPage failed for page %d (error %lu)",
             static_cast<int>(index),
             static_cast<unsigned long>(FPDF_GetLastError()));
        return nullptr;
    }
    if (d->form) FORM_OnAfterLoadPage(page, d->form);
    d->pages[index] = page;
    return page;
}

/// Pages now live until the document closes, so per-call unloading is a no-op.
void unloadPage(Document*, FPDF_PAGE) {}

void releaseAllPages(Document* d) {
    if (!d) return;
    for (auto& [index, page] : d->pages) {
        if (d->form) FORM_OnBeforeClosePage(page, d->form);
        FPDF_ClosePage(page);
    }
    d->pages.clear();
}

struct SaveCollector {
    FPDF_FILEWRITE base;
    std::vector<uint8_t>* out;
};

int writeBlock(FPDF_FILEWRITE* fw, const void* data, unsigned long size) {
    auto* collector = reinterpret_cast<SaveCollector*>(fw);
    const auto* bytes = static_cast<const uint8_t*>(data);
    collector->out->insert(collector->out->end(), bytes, bytes + size);
    return 1;
}

}  // namespace

extern "C" {

JNIEXPORT void JNICALL
Java_com_pdfiumkit_Native_init(JNIEnv*, jclass) {
    FPDF_LIBRARY_CONFIG config{};
    config.version = 3;
    FPDF_InitLibraryWithConfig(&config);
}

JNIEXPORT jlong JNICALL
Java_com_pdfiumkit_Native_openDocument(JNIEnv* env, jclass, jbyteArray data, jstring password) {
    auto* d = new Document();
    jsize length = env->GetArrayLength(data);
    d->bytes.resize(static_cast<size_t>(length));
    env->GetByteArrayRegion(data, 0, length, reinterpret_cast<jbyte*>(d->bytes.data()));

    const char* pwd = password ? env->GetStringUTFChars(password, nullptr) : nullptr;
    d->doc = FPDF_LoadMemDocument(d->bytes.data(), length, pwd);
    if (password) env->ReleaseStringUTFChars(password, pwd);

    if (!d->doc) {
        delete d;
        return 0;
    }
    d->formInfo.version = 2;
    d->form = FPDFDOC_InitFormFillEnvironment(d->doc, &d->formInfo);
    if (d->form) {
        FORM_DoDocumentJSAction(d->form);
        FORM_DoDocumentOpenAction(d->form);
    }
    return reinterpret_cast<jlong>(d);
}

JNIEXPORT jint JNICALL
Java_com_pdfiumkit_Native_lastError(JNIEnv*, jclass) {
    return static_cast<jint>(FPDF_GetLastError());
}

JNIEXPORT void JNICALL
Java_com_pdfiumkit_Native_closeDocument(JNIEnv*, jclass, jlong handle) {
    auto* d = asDoc(handle);
    if (!d) return;
    releaseAllPages(d);
    if (d->form) FPDFDOC_ExitFormFillEnvironment(d->form);
    if (d->doc) FPDF_CloseDocument(d->doc);
    delete d;
}

JNIEXPORT jint JNICALL
Java_com_pdfiumkit_Native_pageCount(JNIEnv*, jclass, jlong handle) {
    auto* d = asDoc(handle);
    return (d && d->doc) ? FPDF_GetPageCount(d->doc) : 0;
}

JNIEXPORT jint JNICALL
Java_com_pdfiumkit_Native_permissions(JNIEnv*, jclass, jlong handle) {
    auto* d = asDoc(handle);
    return (d && d->doc) ? static_cast<jint>(FPDF_GetDocPermissions(d->doc)) : 0;
}

JNIEXPORT jfloatArray JNICALL
Java_com_pdfiumkit_Native_pageSize(JNIEnv* env, jclass, jlong handle, jint index) {
    auto* d = asDoc(handle);
    FS_SIZEF size{0, 0};
    if (d && d->doc) FPDF_GetPageSizeByIndexF(d->doc, index, &size);
    jfloat values[2] = {size.width, size.height};
    jfloatArray out = env->NewFloatArray(2);
    env->SetFloatArrayRegion(out, 0, 2, values);
    return out;
}

JNIEXPORT jint JNICALL
Java_com_pdfiumkit_Native_pageRotation(JNIEnv*, jclass, jlong handle, jint index) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = loadPage(d, index);
    if (!page) return 0;
    int rotation = FPDFPage_GetRotation(page);
    unloadPage(d, page);
    return rotation;
}

JNIEXPORT void JNICALL
Java_com_pdfiumkit_Native_setPageRotation(JNIEnv*, jclass, jlong handle, jint index, jint rotation) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = loadPage(d, index);
    if (!page) return;
    FPDFPage_SetRotation(page, rotation);
    unloadPage(d, page);
}

JNIEXPORT jboolean JNICALL
Java_com_pdfiumkit_Native_renderPage(JNIEnv* env, jclass, jlong handle, jint index,
                                     jobject bitmap, jint flags, jint background,
                                     jboolean drawForms, jboolean watermark) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = loadPage(d, index);
    if (!page) return JNI_FALSE;

    AndroidBitmapInfo info;
    if (AndroidBitmap_getInfo(env, bitmap, &info) != ANDROID_BITMAP_RESULT_SUCCESS) {
        unloadPage(d, page);
        return JNI_FALSE;
    }
    // Only 8888 is supported; anything else would be written with the wrong stride.
    if (info.format != ANDROID_BITMAP_FORMAT_RGBA_8888) {
        LOGE("unsupported bitmap format %d; expected RGBA_8888", info.format);
        unloadPage(d, page);
        return JNI_FALSE;
    }

    void* pixels = nullptr;
    if (AndroidBitmap_lockPixels(env, bitmap, &pixels) != ANDROID_BITMAP_RESULT_SUCCESS) {
        unloadPage(d, page);
        return JNI_FALSE;
    }

    FPDF_BITMAP target = FPDFBitmap_CreateEx(static_cast<int>(info.width),
                                             static_cast<int>(info.height),
                                             FPDFBitmap_BGRA, pixels,
                                             static_cast<int>(info.stride));
    if (!target) {
        AndroidBitmap_unlockPixels(env, bitmap);
        unloadPage(d, page);
        return JNI_FALSE;
    }

    FPDFBitmap_FillRect(target, 0, 0, static_cast<int>(info.width),
                        static_cast<int>(info.height), static_cast<FPDF_DWORD>(background));
    FPDF_RenderPageBitmap(target, page, 0, 0, static_cast<int>(info.width),
                          static_cast<int>(info.height), 0, flags);
    // Only the form-fill layer paints live field values; callers building an inline
    // form editor need to omit it so a native control can own the field.
    if (drawForms && d->form) {
        FPDF_FFLDraw(d->form, target, page, 0, 0, static_cast<int>(info.width),
                     static_cast<int>(info.height), 0, flags);
    }
    // Before the channel swap below, so the watermark's pixels are swapped with the rest.
    if (watermark) {
        pdfiumkit_draw_watermark(target, static_cast<int>(info.width), static_cast<int>(info.height));
    }

    // PDFium writes BGRA; Android's RGBA_8888 wants R and B the other way round.
    auto* words = static_cast<uint32_t*>(pixels);
    size_t count = static_cast<size_t>(info.stride / 4) * info.height;
    for (size_t i = 0; i < count; ++i) {
        uint32_t p = words[i];
        words[i] = (p & 0xFF00FF00u) | ((p & 0x00FF0000u) >> 16) | ((p & 0x000000FFu) << 16);
    }

    FPDFBitmap_Destroy(target);
    AndroidBitmap_unlockPixels(env, bitmap);
    unloadPage(d, page);
    return JNI_TRUE;
}

JNIEXPORT jstring JNICALL
Java_com_pdfiumkit_Native_pageText(JNIEnv* env, jclass, jlong handle, jint index) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = loadPage(d, index);
    if (!page) return env->NewStringUTF("");
    FPDF_TEXTPAGE textPage = FPDFText_LoadPage(page);
    if (!textPage) {
        unloadPage(d, page);
        return env->NewStringUTF("");
    }
    int count = FPDFText_CountChars(textPage);
    jstring result = env->NewStringUTF("");
    if (count > 0) {
        std::vector<unsigned short> buffer(static_cast<size_t>(count) + 1);
        int written = FPDFText_GetText(textPage, 0, count, buffer.data());
        if (written > 0) {
            result = env->NewString(reinterpret_cast<const jchar*>(buffer.data()), written - 1);
        }
    }
    FPDFText_ClosePage(textPage);
    unloadPage(d, page);
    return result;
}

JNIEXPORT jint JNICALL
Java_com_pdfiumkit_Native_charCount(JNIEnv*, jclass, jlong handle, jint index) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = loadPage(d, index);
    if (!page) return 0;
    FPDF_TEXTPAGE textPage = FPDFText_LoadPage(page);
    int count = textPage ? FPDFText_CountChars(textPage) : 0;
    if (textPage) FPDFText_ClosePage(textPage);
    unloadPage(d, page);
    return count < 0 ? 0 : count;
}

/// Returns flat triples of (startIndex, length, rectCount) followed by 4 floats per rect.
JNIEXPORT jfloatArray JNICALL
Java_com_pdfiumkit_Native_search(JNIEnv* env, jclass, jlong handle, jint index,
                                 jstring query, jint flags) {
    auto* d = asDoc(handle);
    std::vector<jfloat> out;
    FPDF_PAGE page = loadPage(d, index);
    if (!page) return env->NewFloatArray(0);

    FPDF_TEXTPAGE textPage = FPDFText_LoadPage(page);
    if (!textPage) {
        unloadPage(d, page);
        return env->NewFloatArray(0);
    }

    std::u16string term = toU16(env, query);
    if (!term.empty()) {
        FPDF_SCHHANDLE search = FPDFText_FindStart(
            textPage, reinterpret_cast<FPDF_WIDESTRING>(term.c_str()),
            static_cast<unsigned long>(flags), 0);
        if (search) {
            while (FPDFText_FindNext(search)) {
                int start = FPDFText_GetSchResultIndex(search);
                int length = FPDFText_GetSchCount(search);
                if (length <= 0) continue;
                int rectCount = FPDFText_CountRects(textPage, start, length);
                if (rectCount < 0) rectCount = 0;
                out.push_back(static_cast<jfloat>(start));
                out.push_back(static_cast<jfloat>(length));
                out.push_back(static_cast<jfloat>(rectCount));
                for (int r = 0; r < rectCount; ++r) {
                    double left = 0, top = 0, right = 0, bottom = 0;
                    FPDFText_GetRect(textPage, r, &left, &top, &right, &bottom);
                    out.push_back(static_cast<jfloat>(left));
                    out.push_back(static_cast<jfloat>(bottom));
                    out.push_back(static_cast<jfloat>(right));
                    out.push_back(static_cast<jfloat>(top));
                }
            }
            FPDFText_FindClose(search);
        }
    }
    FPDFText_ClosePage(textPage);
    unloadPage(d, page);

    jfloatArray result = env->NewFloatArray(static_cast<jsize>(out.size()));
    if (!out.empty()) env->SetFloatArrayRegion(result, 0, static_cast<jsize>(out.size()), out.data());
    return result;
}

JNIEXPORT jstring JNICALL
Java_com_pdfiumkit_Native_metaText(JNIEnv* env, jclass, jlong handle, jstring key) {
    auto* d = asDoc(handle);
    if (!d || !d->doc) return env->NewStringUTF("");
    const char* k = env->GetStringUTFChars(key, nullptr);
    jstring result = utf16String(env, [&](unsigned short* buf, unsigned long size) {
        return FPDF_GetMetaText(d->doc, k, buf, size);
    });
    env->ReleaseStringUTFChars(key, k);
    return result;
}

// MARK: - Annotations

JNIEXPORT jint JNICALL
Java_com_pdfiumkit_Native_annotationCount(JNIEnv*, jclass, jlong handle, jint pageIndex) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = loadPage(d, pageIndex);
    if (!page) return 0;
    int count = FPDFPage_GetAnnotCount(page);
    unloadPage(d, page);
    return count;
}

/// [subtype, flags, r, g, b, a, left, bottom, right, top, inkStrokeCount, quadCount]
JNIEXPORT jfloatArray JNICALL
Java_com_pdfiumkit_Native_annotationInfo(JNIEnv* env, jclass, jlong handle,
                                         jint pageIndex, jint annotIndex) {
    auto* d = asDoc(handle);
    jfloat values[12] = {0};
    FPDF_PAGE page = loadPage(d, pageIndex);
    if (!page) { jfloatArray o = env->NewFloatArray(12); env->SetFloatArrayRegion(o, 0, 12, values); return o; }

    FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, annotIndex);
    if (annot) {
        values[0] = static_cast<jfloat>(FPDFAnnot_GetSubtype(annot));
        values[1] = static_cast<jfloat>(FPDFAnnot_GetFlags(annot));
        unsigned int r = 0, g = 0, b = 0, a = 0;
        if (FPDFAnnot_GetColor(annot, FPDFANNOT_COLORTYPE_Color, &r, &g, &b, &a)) {
            values[2] = static_cast<jfloat>(r); values[3] = static_cast<jfloat>(g);
            values[4] = static_cast<jfloat>(b); values[5] = static_cast<jfloat>(a);
        } else {
            values[5] = -1;   // signals "no colour", distinct from transparent black
        }
        FS_RECTF rect{};
        FPDFAnnot_GetRect(annot, &rect);
        values[6] = rect.left; values[7] = rect.bottom;
        values[8] = rect.right; values[9] = rect.top;
        values[10] = static_cast<jfloat>(FPDFAnnot_GetInkListCount(annot));
        values[11] = static_cast<jfloat>(FPDFAnnot_CountAttachmentPoints(annot));
        FPDFPage_CloseAnnot(annot);
    }
    unloadPage(d, page);
    jfloatArray out = env->NewFloatArray(12);
    env->SetFloatArrayRegion(out, 0, 12, values);
    return out;
}

JNIEXPORT jstring JNICALL
Java_com_pdfiumkit_Native_annotationString(JNIEnv* env, jclass, jlong handle,
                                           jint pageIndex, jint annotIndex, jstring key) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = loadPage(d, pageIndex);
    if (!page) return env->NewStringUTF("");
    FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, annotIndex);
    jstring result = env->NewStringUTF("");
    if (annot) {
        const char* k = env->GetStringUTFChars(key, nullptr);
        result = utf16String(env, [&](unsigned short* buf, unsigned long size) {
            return FPDFAnnot_GetStringValue(annot, k, buf, size);
        });
        env->ReleaseStringUTFChars(key, k);
        FPDFPage_CloseAnnot(annot);
    }
    unloadPage(d, page);
    return result;
}

/// Flat x,y pairs for one ink stroke.
JNIEXPORT jfloatArray JNICALL
Java_com_pdfiumkit_Native_inkStroke(JNIEnv* env, jclass, jlong handle, jint pageIndex,
                                    jint annotIndex, jint strokeIndex) {
    auto* d = asDoc(handle);
    std::vector<jfloat> out;
    FPDF_PAGE page = loadPage(d, pageIndex);
    if (page) {
        FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, annotIndex);
        if (annot) {
            unsigned long n = FPDFAnnot_GetInkListPath(annot, strokeIndex, nullptr, 0);
            if (n > 0) {
                std::vector<FS_POINTF> points(n);
                unsigned long written = FPDFAnnot_GetInkListPath(annot, strokeIndex, points.data(), n);
                for (unsigned long i = 0; i < written; ++i) {
                    out.push_back(points[i].x);
                    out.push_back(points[i].y);
                }
            }
            FPDFPage_CloseAnnot(annot);
        }
        unloadPage(d, page);
    }
    jfloatArray result = env->NewFloatArray(static_cast<jsize>(out.size()));
    if (!out.empty()) env->SetFloatArrayRegion(result, 0, static_cast<jsize>(out.size()), out.data());
    return result;
}

JNIEXPORT jint JNICALL
Java_com_pdfiumkit_Native_addInk(JNIEnv* env, jclass, jlong handle, jint pageIndex,
                                 jfloatArray points, jintArray strokeLengths,
                                 jint r, jint g, jint b, jint a, jfloat width) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = loadPage(d, pageIndex);
    if (!page) return -1;

    FPDF_ANNOTATION annot = FPDFPage_CreateAnnot(page, FPDF_ANNOT_INK);
    if (!annot) { unloadPage(d, page); return -1; }

    // points is every stroke's x,y pairs end to end; strokeLengths says where each ends.
    jsize n = env->GetArrayLength(points);
    std::vector<jfloat> flat(static_cast<size_t>(n));
    env->GetFloatArrayRegion(points, 0, n, flat.data());
    jsize strokeCount = env->GetArrayLength(strokeLengths);
    std::vector<jint> lengths(static_cast<size_t>(strokeCount));
    env->GetIntArrayRegion(strokeLengths, 0, strokeCount, lengths.data());

    float minX = 1e9f, minY = 1e9f, maxX = -1e9f, maxY = -1e9f;
    size_t offset = 0;
    for (jint length : lengths) {
        std::vector<FS_POINTF> stroke;
        for (jint i = 0; i < length && offset + 1 < flat.size(); i++, offset += 2) {
            stroke.push_back(FS_POINTF{flat[offset], flat[offset + 1]});
            minX = std::min(minX, flat[offset]);   maxX = std::max(maxX, flat[offset]);
            minY = std::min(minY, flat[offset + 1]); maxY = std::max(maxY, flat[offset + 1]);
        }
        if (!stroke.empty()) FPDFAnnot_AddInkStroke(annot, stroke.data(), stroke.size());
    }
    if (offset > 0) {
        FS_RECTF rect{minX, maxY, maxX, minY};
        FPDFAnnot_SetRect(annot, &rect);
    }
    FPDFAnnot_SetColor(annot, FPDFANNOT_COLORTYPE_Color, r, g, b, a);
    FPDFAnnot_SetBorder(annot, 0, 0, width);
    FPDFPage_CloseAnnot(annot);
    FPDFPage_GenerateContent(page);

    int count = FPDFPage_GetAnnotCount(page);
    unloadPage(d, page);
    return count - 1;
}

/// quads is a flat run of 8 floats per quad: x1,y1,x2,y2,x3,y3,x4,y4.
JNIEXPORT jint JNICALL
Java_com_pdfiumkit_Native_addMarkup(JNIEnv* env, jclass, jlong handle, jint pageIndex,
                                    jint subtype, jfloatArray quads,
                                    jint r, jint g, jint b, jint a) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = loadPage(d, pageIndex);
    if (!page) return -1;

    FPDF_ANNOTATION annot = FPDFPage_CreateAnnot(page, static_cast<FPDF_ANNOTATION_SUBTYPE>(subtype));
    if (!annot) { unloadPage(d, page); return -1; }

    jsize n = env->GetArrayLength(quads);
    std::vector<jfloat> flat(static_cast<size_t>(n));
    env->GetFloatArrayRegion(quads, 0, n, flat.data());

    float minX = 1e9f, minY = 1e9f, maxX = -1e9f, maxY = -1e9f;
    for (jsize i = 0; i + 7 < n; i += 8) {
        FS_QUADPOINTSF q{flat[i], flat[i+1], flat[i+2], flat[i+3],
                         flat[i+4], flat[i+5], flat[i+6], flat[i+7]};
        FPDFAnnot_AppendAttachmentPoints(annot, &q);
        for (int k = 0; k < 8; k += 2) {
            minX = std::min(minX, flat[i+k]);   maxX = std::max(maxX, flat[i+k]);
            minY = std::min(minY, flat[i+k+1]); maxY = std::max(maxY, flat[i+k+1]);
        }
    }
    if (n >= 8) {
        FS_RECTF rect{minX, maxY, maxX, minY};
        FPDFAnnot_SetRect(annot, &rect);
    }
    FPDFAnnot_SetColor(annot, FPDFANNOT_COLORTYPE_Color, r, g, b, a);
    FPDFPage_CloseAnnot(annot);
    FPDFPage_GenerateContent(page);

    int count = FPDFPage_GetAnnotCount(page);
    unloadPage(d, page);
    return count - 1;
}

JNIEXPORT jint JNICALL
Java_com_pdfiumkit_Native_addNote(JNIEnv* env, jclass, jlong handle, jint pageIndex,
                                  jfloat left, jfloat bottom, jfloat right, jfloat top,
                                  jstring contents, jint r, jint g, jint b, jint a) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = loadPage(d, pageIndex);
    if (!page) return -1;

    FPDF_ANNOTATION annot = FPDFPage_CreateAnnot(page, FPDF_ANNOT_TEXT);
    if (!annot) { unloadPage(d, page); return -1; }

    FS_RECTF rect{left, top, right, bottom};
    FPDFAnnot_SetRect(annot, &rect);
    std::u16string text = toU16(env, contents);
    FPDFAnnot_SetStringValue(annot, "Contents", reinterpret_cast<FPDF_WIDESTRING>(text.c_str()));
    FPDFAnnot_SetColor(annot, FPDFANNOT_COLORTYPE_Color, r, g, b, a);
    FPDFPage_CloseAnnot(annot);
    FPDFPage_GenerateContent(page);

    int count = FPDFPage_GetAnnotCount(page);
    unloadPage(d, page);
    return count - 1;
}

JNIEXPORT jboolean JNICALL
Java_com_pdfiumkit_Native_removeAnnotation(JNIEnv*, jclass, jlong handle,
                                           jint pageIndex, jint annotIndex) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = loadPage(d, pageIndex);
    if (!page) return JNI_FALSE;
    FPDF_BOOL ok = FPDFPage_RemoveAnnot(page, annotIndex);
    if (ok) FPDFPage_GenerateContent(page);
    unloadPage(d, page);
    return ok ? JNI_TRUE : JNI_FALSE;
}

// MARK: - Form fields

/// [fieldType, flags, isChecked, optionCount, left, bottom, right, top]
JNIEXPORT jfloatArray JNICALL
Java_com_pdfiumkit_Native_formFieldInfo(JNIEnv* env, jclass, jlong handle,
                                        jint pageIndex, jint annotIndex) {
    auto* d = asDoc(handle);
    jfloat values[8] = {0};
    values[0] = -1;   // not a widget unless proven otherwise

    FPDF_PAGE page = loadPage(d, pageIndex);
    if (page && d->form) {
        FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, annotIndex);
        if (annot) {
            if (FPDFAnnot_GetSubtype(annot) == FPDF_ANNOT_WIDGET) {
                values[0] = static_cast<jfloat>(FPDFAnnot_GetFormFieldType(d->form, annot));
                values[1] = static_cast<jfloat>(FPDFAnnot_GetFormFieldFlags(d->form, annot));
                values[2] = FPDFAnnot_IsChecked(d->form, annot) ? 1.0f : 0.0f;
                values[3] = static_cast<jfloat>(FPDFAnnot_GetOptionCount(d->form, annot));
                FS_RECTF rect{};
                FPDFAnnot_GetRect(annot, &rect);
                values[4] = rect.left; values[5] = rect.bottom;
                values[6] = rect.right; values[7] = rect.top;
            }
            FPDFPage_CloseAnnot(annot);
        }
    }
    if (page) unloadPage(d, page);
    jfloatArray out = env->NewFloatArray(8);
    env->SetFloatArrayRegion(out, 0, 8, values);
    return out;
}

/// which: 0 name, 1 alternate name, 2 value, 3 export value
JNIEXPORT jstring JNICALL
Java_com_pdfiumkit_Native_formFieldString(JNIEnv* env, jclass, jlong handle,
                                          jint pageIndex, jint annotIndex, jint which) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = loadPage(d, pageIndex);
    if (!page || !d->form) { if (page) unloadPage(d, page); return env->NewStringUTF(""); }

    FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, annotIndex);
    jstring result = env->NewStringUTF("");
    if (annot) {
        result = utf16String(env, [&](unsigned short* buf, unsigned long size) -> unsigned long {
            switch (which) {
                case 0: return FPDFAnnot_GetFormFieldName(d->form, annot, buf, size);
                case 1: return FPDFAnnot_GetFormFieldAlternateName(d->form, annot, buf, size);
                case 2: return FPDFAnnot_GetFormFieldValue(d->form, annot, buf, size);
                default: return FPDFAnnot_GetFormFieldExportValue(d->form, annot, buf, size);
            }
        });
        FPDFPage_CloseAnnot(annot);
    }
    unloadPage(d, page);
    return result;
}

JNIEXPORT jstring JNICALL
Java_com_pdfiumkit_Native_formOptionLabel(JNIEnv* env, jclass, jlong handle, jint pageIndex,
                                          jint annotIndex, jint optionIndex) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = loadPage(d, pageIndex);
    if (!page || !d->form) { if (page) unloadPage(d, page); return env->NewStringUTF(""); }
    FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, annotIndex);
    jstring result = env->NewStringUTF("");
    if (annot) {
        result = utf16String(env, [&](unsigned short* buf, unsigned long size) {
            return FPDFAnnot_GetOptionLabel(d->form, annot, optionIndex, buf, size);
        });
        FPDFPage_CloseAnnot(annot);
    }
    unloadPage(d, page);
    return result;
}

JNIEXPORT jboolean JNICALL
Java_com_pdfiumkit_Native_isOptionSelected(JNIEnv*, jclass, jlong handle, jint pageIndex,
                                           jint annotIndex, jint optionIndex) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = loadPage(d, pageIndex);
    if (!page || !d->form) { if (page) unloadPage(d, page); return JNI_FALSE; }
    FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, annotIndex);
    jboolean result = JNI_FALSE;
    if (annot) {
        result = FPDFAnnot_IsOptionSelected(d->form, annot, optionIndex) ? JNI_TRUE : JNI_FALSE;
        FPDFPage_CloseAnnot(annot);
    }
    unloadPage(d, page);
    return result;
}

JNIEXPORT jboolean JNICALL
Java_com_pdfiumkit_Native_setFormText(JNIEnv* env, jclass, jlong handle, jint pageIndex,
                                      jint annotIndex, jstring value) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = loadPage(d, pageIndex);
    if (!page || !d->form) { if (page) unloadPage(d, page); return JNI_FALSE; }

    FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, annotIndex);
    jboolean ok = JNI_FALSE;
    if (annot) {
        if (FORM_SetFocusedAnnot(d->form, annot)) {
            FORM_SelectAllText(d->form, page);
            std::u16string text = toU16(env, value);
            FORM_ReplaceSelection(d->form, page, reinterpret_cast<FPDF_WIDESTRING>(text.c_str()));
            FORM_ForceToKillFocus(d->form);
            ok = JNI_TRUE;
        }
        FPDFPage_CloseAnnot(annot);
    }
    unloadPage(d, page);
    return ok;
}

/// Writes the field value and appearance state directly. PDFium's synthetic-click path
/// needs FFI callbacks this bridge does not install, so it is not used here.
JNIEXPORT jboolean JNICALL
Java_com_pdfiumkit_Native_setFormChecked(JNIEnv* env, jclass, jlong handle, jint pageIndex,
                                         jint annotIndex, jboolean checked) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = loadPage(d, pageIndex);
    if (!page || !d->form) { if (page) unloadPage(d, page); return JNI_FALSE; }

    FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, annotIndex);
    jboolean ok = JNI_FALSE;
    if (annot) {
        std::u16string target = u"Off";
        if (checked) {
            unsigned long n = FPDFAnnot_GetFormFieldExportValue(d->form, annot, nullptr, 0);
            if (n > 2) {
                std::vector<unsigned short> buffer(n / 2);
                FPDFAnnot_GetFormFieldExportValue(d->form, annot, buffer.data(), n);
                target.assign(reinterpret_cast<char16_t*>(buffer.data()), buffer.size() - 1);
            } else {
                target = u"Yes";
            }
        }
        auto* wide = reinterpret_cast<FPDF_WIDESTRING>(target.c_str());
        ok = (FPDFAnnot_SetStringValue(annot, "V", wide) &&
              FPDFAnnot_SetStringValue(annot, "AS", wide)) ? JNI_TRUE : JNI_FALSE;
        FPDFPage_CloseAnnot(annot);
        if (ok) FPDFPage_GenerateContent(page);
    }
    unloadPage(d, page);
    return ok;
}

JNIEXPORT jboolean JNICALL
Java_com_pdfiumkit_Native_setFormOption(JNIEnv*, jclass, jlong handle, jint pageIndex,
                                        jint annotIndex, jint optionIndex, jboolean selected) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = loadPage(d, pageIndex);
    if (!page || !d->form) { if (page) unloadPage(d, page); return JNI_FALSE; }

    FPDF_ANNOTATION annot = FPDFPage_GetAnnot(page, annotIndex);
    jboolean ok = JNI_FALSE;
    if (annot) {
        if (FORM_SetFocusedAnnot(d->form, annot)) {
            ok = FORM_SetIndexSelected(d->form, page, optionIndex, selected) ? JNI_TRUE : JNI_FALSE;
            FORM_ForceToKillFocus(d->form);
        }
        FPDFPage_CloseAnnot(annot);
    }
    unloadPage(d, page);
    return ok;
}

// MARK: - Links

/// Returns flat 5-tuples per link: left, bottom, right, top, targetPage.
/// targetPage is >= 0 for an internal destination, -1 when the target is a URI or
/// unresolved; the URI itself is fetched separately by index.
JNIEXPORT jfloatArray JNICALL
Java_com_pdfiumkit_Native_links(JNIEnv* env, jclass, jlong handle, jint pageIndex) {
    auto* d = asDoc(handle);
    std::vector<jfloat> out;
    FPDF_PAGE page = loadPage(d, pageIndex);
    if (page) {
        int pos = 0;
        FPDF_LINK link = nullptr;
        while (FPDFLink_Enumerate(page, &pos, &link)) {
            if (!link) continue;
            FS_RECTF rect{};
            if (!FPDFLink_GetAnnotRect(link, &rect)) continue;

            int targetPage = -1;
            FPDF_DEST dest = FPDFLink_GetDest(d->doc, link);
            if (!dest) {
                FPDF_ACTION action = FPDFLink_GetAction(link);
                if (action) dest = FPDFAction_GetDest(d->doc, action);
            }
            if (dest) targetPage = FPDFDest_GetDestPageIndex(d->doc, dest);

            out.push_back(rect.left);
            out.push_back(rect.bottom);
            out.push_back(rect.right);
            out.push_back(rect.top);
            out.push_back(static_cast<jfloat>(targetPage));
        }
        unloadPage(d, page);
    }
    jfloatArray result = env->NewFloatArray(static_cast<jsize>(out.size()));
    if (!out.empty()) env->SetFloatArrayRegion(result, 0, static_cast<jsize>(out.size()), out.data());
    return result;
}

JNIEXPORT jstring JNICALL
Java_com_pdfiumkit_Native_linkUri(JNIEnv* env, jclass, jlong handle, jint pageIndex, jint linkIndex) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = loadPage(d, pageIndex);
    if (!page) return env->NewStringUTF("");

    jstring result = env->NewStringUTF("");
    int pos = 0, seen = 0;
    FPDF_LINK link = nullptr;
    while (FPDFLink_Enumerate(page, &pos, &link)) {
        if (!link) continue;
        FS_RECTF rect{};
        if (!FPDFLink_GetAnnotRect(link, &rect)) continue;
        if (seen++ != linkIndex) continue;

        FPDF_ACTION action = FPDFLink_GetAction(link);
        if (action) {
            unsigned long n = FPDFAction_GetURIPath(d->doc, action, nullptr, 0);
            if (n > 1) {
                std::vector<char> buffer(n);
                FPDFAction_GetURIPath(d->doc, action, buffer.data(), n);
                result = env->NewStringUTF(buffer.data());
            }
        }
        break;
    }
    unloadPage(d, page);
    return result;
}

/// left, right, bottom, top for one character.
JNIEXPORT jdoubleArray JNICALL
Java_com_pdfiumkit_Native_charBox(JNIEnv* env, jclass, jlong handle, jint pageIndex, jint charIndex) {
    auto* d = asDoc(handle);
    jdouble values[4] = {0, 0, 0, 0};
    FPDF_PAGE page = loadPage(d, pageIndex);
    if (page) {
        FPDF_TEXTPAGE textPage = FPDFText_LoadPage(page);
        if (textPage) {
            FPDFText_GetCharBox(textPage, charIndex, &values[0], &values[1], &values[2], &values[3]);
            FPDFText_ClosePage(textPage);
        }
        unloadPage(d, page);
    }
    jdoubleArray out = env->NewDoubleArray(4);
    env->SetDoubleArrayRegion(out, 0, 4, values);
    return out;
}

// MARK: - Outline, links, attachments, save

JNIEXPORT jint JNICALL
Java_com_pdfiumkit_Native_attachmentCount(JNIEnv*, jclass, jlong handle) {
    auto* d = asDoc(handle);
    return (d && d->doc) ? FPDFDoc_GetAttachmentCount(d->doc) : 0;
}

JNIEXPORT jstring JNICALL
Java_com_pdfiumkit_Native_attachmentName(JNIEnv* env, jclass, jlong handle, jint index) {
    auto* d = asDoc(handle);
    if (!d || !d->doc) return env->NewStringUTF("");
    FPDF_ATTACHMENT attachment = FPDFDoc_GetAttachment(d->doc, index);
    if (!attachment) return env->NewStringUTF("");
    return utf16String(env, [&](unsigned short* buf, unsigned long size) {
        return FPDFAttachment_GetName(attachment, buf, size);
    });
}

/// Bookmarks are addressed by path: a list of child indices from the root.
static FPDF_BOOKMARK resolveBookmark(FPDF_DOCUMENT doc, const jint* path, jsize depth) {
    FPDF_BOOKMARK current = nullptr;
    for (jsize level = 0; level < depth; ++level) {
        FPDF_BOOKMARK child = FPDFBookmark_GetFirstChild(doc, current);
        for (jint i = 0; i < path[level] && child; ++i) {
            child = FPDFBookmark_GetNextSibling(doc, child);
        }
        if (!child) return nullptr;
        current = child;
    }
    return current;
}

JNIEXPORT jint JNICALL
Java_com_pdfiumkit_Native_bookmarkChildCount(JNIEnv* env, jclass, jlong handle, jintArray jpath) {
    auto* d = asDoc(handle);
    if (!d || !d->doc) return 0;
    jsize depth = jpath ? env->GetArrayLength(jpath) : 0;
    std::vector<jint> path(static_cast<size_t>(depth));
    if (depth) env->GetIntArrayRegion(jpath, 0, depth, path.data());

    FPDF_BOOKMARK parent = depth ? resolveBookmark(d->doc, path.data(), depth) : nullptr;
    if (depth && !parent) return 0;

    int count = 0;
    FPDF_BOOKMARK child = FPDFBookmark_GetFirstChild(d->doc, parent);
    while (child && count < 4096) {
        ++count;
        child = FPDFBookmark_GetNextSibling(d->doc, child);
    }
    return count;
}

JNIEXPORT jstring JNICALL
Java_com_pdfiumkit_Native_bookmarkTitle(JNIEnv* env, jclass, jlong handle, jintArray jpath) {
    auto* d = asDoc(handle);
    if (!d || !d->doc || !jpath) return env->NewStringUTF("");
    jsize depth = env->GetArrayLength(jpath);
    std::vector<jint> path(static_cast<size_t>(depth));
    env->GetIntArrayRegion(jpath, 0, depth, path.data());

    FPDF_BOOKMARK bookmark = resolveBookmark(d->doc, path.data(), depth);
    if (!bookmark) return env->NewStringUTF("");
    return utf16String(env, [&](unsigned short* buf, unsigned long size) {
        return FPDFBookmark_GetTitle(bookmark, buf, size);
    });
}

/// Returns the destination page index, or -1 when the bookmark resolves to none.
JNIEXPORT jint JNICALL
Java_com_pdfiumkit_Native_bookmarkPageIndex(JNIEnv* env, jclass, jlong handle, jintArray jpath) {
    auto* d = asDoc(handle);
    if (!d || !d->doc || !jpath) return -1;
    jsize depth = env->GetArrayLength(jpath);
    std::vector<jint> path(static_cast<size_t>(depth));
    env->GetIntArrayRegion(jpath, 0, depth, path.data());

    FPDF_BOOKMARK bookmark = resolveBookmark(d->doc, path.data(), depth);
    if (!bookmark) return -1;

    FPDF_DEST dest = FPDFBookmark_GetDest(d->doc, bookmark);
    if (!dest) {
        FPDF_ACTION action = FPDFBookmark_GetAction(bookmark);
        if (action) dest = FPDFAction_GetDest(d->doc, action);
    }
    if (!dest) return -1;
    return FPDFDest_GetDestPageIndex(d->doc, dest);
}

JNIEXPORT jbyteArray JNICALL
Java_com_pdfiumkit_Native_attachmentData(JNIEnv* env, jclass, jlong handle, jint index) {
    auto* d = asDoc(handle);
    if (!d || !d->doc) return env->NewByteArray(0);
    FPDF_ATTACHMENT attachment = FPDFDoc_GetAttachment(d->doc, index);
    if (!attachment) return env->NewByteArray(0);

    unsigned long size = 0;
    FPDFAttachment_GetFile(attachment, nullptr, 0, &size);
    if (size == 0) return env->NewByteArray(0);

    std::vector<uint8_t> bytes(size);
    unsigned long written = 0;
    FPDFAttachment_GetFile(attachment, bytes.data(), size, &written);

    jbyteArray out = env->NewByteArray(static_cast<jsize>(written));
    env->SetByteArrayRegion(out, 0, static_cast<jsize>(written),
                            reinterpret_cast<const jbyte*>(bytes.data()));
    return out;
}

JNIEXPORT jbyteArray JNICALL
Java_com_pdfiumkit_Native_saveDocument(JNIEnv* env, jclass, jlong handle, jint flags) {
    auto* d = asDoc(handle);
    if (!d || !d->doc) return env->NewByteArray(0);
    if (d->form) FORM_ForceToKillFocus(d->form);

    std::vector<uint8_t> out;
    SaveCollector collector{};
    collector.base.version = 1;
    collector.base.WriteBlock = writeBlock;
    collector.out = &out;

    if (!FPDF_SaveAsCopy(d->doc, &collector.base, static_cast<FPDF_DWORD>(flags))) {
        return env->NewByteArray(0);
    }
    jbyteArray result = env->NewByteArray(static_cast<jsize>(out.size()));
    if (!out.empty()) {
        env->SetByteArrayRegion(result, 0, static_cast<jsize>(out.size()),
                                reinterpret_cast<const jbyte*>(out.data()));
    }
    return result;
}

/// A full save of `bytes` with the trial watermark in every page's content.
JNIEXPORT jbyteArray JNICALL
Java_com_pdfiumkit_Native_stampWatermark(JNIEnv* env, jclass, jbyteArray bytes) {
    jsize size = env->GetArrayLength(bytes);
    std::vector<uint8_t> input(static_cast<size_t>(size));
    env->GetByteArrayRegion(bytes, 0, size, reinterpret_cast<jbyte*>(input.data()));
    std::vector<uint8_t> out = pdfiumkit_stamp_watermark(input.data(), input.size());
    jbyteArray result = env->NewByteArray(static_cast<jsize>(out.size()));
    if (!out.empty()) {
        env->SetByteArrayRegion(result, 0, static_cast<jsize>(out.size()),
                                reinterpret_cast<const jbyte*>(out.data()));
    }
    return result;
}

}  // extern "C"

// MARK: - Signatures
//
// Reading only. PDFium exposes no way to create a signature and no crypto at all, so
// the PKCS#7 blob is handed back untouched for a verifier to check.

extern "C" JNIEXPORT jint JNICALL
Java_com_pdfiumkit_Native_signatureCount(JNIEnv*, jclass, jlong handle) {
    auto* d = asDoc(handle);
    if (!d || !d->doc) return 0;
    return FPDF_GetSignatureCount(d->doc);
}

/// Length of the bytes the document was opened from, which a byte range is measured
/// against to decide whether a signature covers the whole file.
extern "C" JNIEXPORT jlong JNICALL
Java_com_pdfiumkit_Native_documentByteLength(JNIEnv*, jclass, jlong handle) {
    auto* d = asDoc(handle);
    return d ? static_cast<jlong>(d->bytes.size()) : 0;
}

namespace {
FPDF_SIGNATURE signatureAt(Document* d, jint index) {
    if (!d || !d->doc) return nullptr;
    return FPDF_GetSignatureObject(d->doc, index);
}
}  // namespace

extern "C" JNIEXPORT jintArray JNICALL
Java_com_pdfiumkit_Native_signatureByteRange(JNIEnv* env, jclass, jlong handle, jint index) {
    FPDF_SIGNATURE signature = signatureAt(asDoc(handle), index);
    if (!signature) return env->NewIntArray(0);

    unsigned long count = FPDFSignatureObj_GetByteRange(signature, nullptr, 0);
    if (count == 0) return env->NewIntArray(0);

    std::vector<int> values(count);
    FPDFSignatureObj_GetByteRange(signature, values.data(), count);

    jintArray out = env->NewIntArray(static_cast<jsize>(count));
    env->SetIntArrayRegion(out, 0, static_cast<jsize>(count), values.data());
    return out;
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_pdfiumkit_Native_signatureContents(JNIEnv* env, jclass, jlong handle, jint index) {
    FPDF_SIGNATURE signature = signatureAt(asDoc(handle), index);
    if (!signature) return env->NewByteArray(0);

    unsigned long size = FPDFSignatureObj_GetContents(signature, nullptr, 0);
    if (size == 0) return env->NewByteArray(0);

    std::vector<uint8_t> bytes(size);
    FPDFSignatureObj_GetContents(signature, bytes.data(), size);

    jbyteArray out = env->NewByteArray(static_cast<jsize>(size));
    env->SetByteArrayRegion(out, 0, static_cast<jsize>(size),
                            reinterpret_cast<const jbyte*>(bytes.data()));
    return out;
}

/// The sub-filter and time are 7-bit ASCII byte strings, unlike PDFium's usual UTF-16.
/// `which`: 0 = sub-filter, 1 = time.
extern "C" JNIEXPORT jstring JNICALL
Java_com_pdfiumkit_Native_signatureAscii(JNIEnv* env, jclass, jlong handle, jint index, jint which) {
    FPDF_SIGNATURE signature = signatureAt(asDoc(handle), index);
    if (!signature) return env->NewStringUTF("");

    auto read = [&](char* buffer, unsigned long length) -> unsigned long {
        return which == 0 ? FPDFSignatureObj_GetSubFilter(signature, buffer, length)
                          : FPDFSignatureObj_GetTime(signature, buffer, length);
    };

    unsigned long size = read(nullptr, 0);
    if (size == 0) return env->NewStringUTF("");

    std::vector<char> buffer(size + 1, 0);
    read(buffer.data(), size);
    buffer[size] = 0;   // PDFium counts the NUL in the size, but do not rely on it
    return env->NewStringUTF(buffer.data());
}

/// `/Reason` is UTF-16LE, unlike the sub-filter and time.
extern "C" JNIEXPORT jstring JNICALL
Java_com_pdfiumkit_Native_signatureReason(JNIEnv* env, jclass, jlong handle, jint index) {
    FPDF_SIGNATURE signature = signatureAt(asDoc(handle), index);
    if (!signature) return env->NewStringUTF("");

    unsigned long size = FPDFSignatureObj_GetReason(signature, nullptr, 0);
    if (size <= 2) return env->NewStringUTF("");   // a lone terminator means absent

    std::vector<unsigned short> units(size / 2);
    FPDFSignatureObj_GetReason(signature, units.data(), size);
    jsize length = static_cast<jsize>(units.size());
    if (length > 0 && units[length - 1] == 0) length -= 1;
    return env->NewString(units.data(), length);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_pdfiumkit_Native_signatureDocMdp(JNIEnv*, jclass, jlong handle, jint index) {
    FPDF_SIGNATURE signature = signatureAt(asDoc(handle), index);
    return signature ? FPDFSignatureObj_GetDocMDPPermission(signature) : 0;
}

// MARK: - Redaction
//
// Removing the objects a region touches and regenerating the content stream, so content
// leaves the file. Drawing a black rectangle over text is the classic redaction failure:
// it looks right and every word is still there.

namespace {

struct Rect { float left, bottom, right, top; };

bool overlaps(const Rect& a, const Rect& b) {
    // Touching edges count, deliberately.
    return a.left <= b.right && a.right >= b.left && a.bottom <= b.top && a.top >= b.bottom;
}

Rect objectBounds(FPDF_PAGEOBJECT object) {
    float l = 0, b = 0, r = 0, t = 0;
    FPDFPageObj_GetBounds(object, &l, &b, &r, &t);
    return { std::min(l, r), std::min(b, t), std::max(l, r), std::max(b, t) };
}

Rect charBox(FPDF_TEXTPAGE textPage, int index) {
    double l = 0, r = 0, b = 0, t = 0;
    // The out-parameters are left, right, bottom, top — not the usual rect order.
    FPDFText_GetCharBox(textPage, index, &l, &r, &b, &t);
    return { static_cast<float>(std::min(l, r)), static_cast<float>(std::min(b, t)),
             static_cast<float>(std::max(l, r)), static_cast<float>(std::max(b, t)) };
}

/// Field names cleared during the last redaction of a page, collected for the report.
std::vector<std::string> lastClearedFields;

}  // namespace

extern "C" JNIEXPORT jintArray JNICALL
Java_com_pdfiumkit_Native_redactPage(
        JNIEnv* env, jclass, jlong handle, jint pageIndex, jfloatArray regionsArray) {
    auto* d = asDoc(handle);
    jintArray empty = env->NewIntArray(0);
    if (!d || !d->doc) return empty;

    FPDF_PAGE page = loadPage(d, pageIndex);
    if (!page) return empty;

    jsize length = env->GetArrayLength(regionsArray);
    std::vector<float> flat(length);
    env->GetFloatArrayRegion(regionsArray, 0, length, flat.data());

    std::vector<Rect> regions;
    for (jsize i = 0; i + 3 < length; i += 4) {
        regions.push_back({ flat[i], flat[i + 1], flat[i + 2], flat[i + 3] });
    }
    if (regions.empty()) return empty;

    FPDF_TEXTPAGE textPage = FPDFText_LoadPage(page);
    lastClearedFields.clear();

    int textObjects = 0, split = 0, images = 0, paths = 0, annotations = 0;
    std::set<FPDF_PAGEOBJECT> handled;

    // Partially covered runs first: they are rewritten rather than removed, and doing it
    // before the whole-object pass keeps the two from fighting over the same handles.
    if (textPage) {
        std::map<FPDF_PAGEOBJECT, std::vector<int>> byObject;
        int chars = FPDFText_CountChars(textPage);
        for (int i = 0; i < chars; i++) {
            FPDF_PAGEOBJECT owner = FPDFText_GetTextObject(textPage, i);
            if (owner) byObject[owner].push_back(i);
        }

        for (auto& [object, indices] : byObject) {
            std::vector<int> surviving;
            int covered = 0;
            for (int index : indices) {
                Rect box = charBox(textPage, index);
                bool hit = false;
                for (const auto& region : regions) if (overlaps(box, region)) { hit = true; break; }
                // Characters are dropped on intersection, not containment: a character
                // half inside the region is still legible.
                if (hit) covered++; else surviving.push_back(index);
            }
            if (covered == 0 || surviving.empty()) continue;   // untouched, or covered outright

            FPDF_FONT font = FPDFTextObj_GetFont(object);
            float fontSize = 0;
            if (!font || !FPDFTextObj_GetFontSize(object, &fontSize)) continue;

            // Contiguous stretches that survived, each drawn where it was.
            std::vector<FPDF_PAGEOBJECT> created;
            size_t at = 0;
            bool ok = true;
            while (at < surviving.size() && ok) {
                size_t end = at + 1;
                while (end < surviving.size() && surviving[end] == surviving[end - 1] + 1) end++;

                std::vector<unsigned short> text;
                for (size_t i = at; i < end; i++) {
                    text.push_back(static_cast<unsigned short>(
                        FPDFText_GetUnicode(textPage, surviving[i])));
                }
                text.push_back(0);

                FPDF_PAGEOBJECT replacement = FPDFPageObj_CreateTextObj(d->doc, font, fontSize);
                if (!replacement || !FPDFText_SetText(replacement, text.data())) {
                    if (replacement) FPDFPageObj_Destroy(replacement);
                    ok = false;
                    break;
                }
                // An identity matrix translated to the run's origin, so the glyphs land
                // where they were. SetText keeps the object's matrix, so a run that no
                // longer starts where the object did would render in the wrong place.
                Rect origin = charBox(textPage, surviving[at]);
                FS_MATRIX matrix = { 1, 0, 0, 1, origin.left, origin.bottom };
                FPDFPageObj_SetMatrix(replacement, &matrix);
                created.push_back(replacement);
                at = end;
            }

            // Only now that every run is built is the original removed, so a failure
            // part-way through leaves the page as it was rather than half-redacted.
            if (!ok || !FPDFPage_RemoveObject(page, object)) {
                for (auto* c : created) FPDFPageObj_Destroy(c);
                continue;
            }
            FPDFPageObj_Destroy(object);
            for (auto* c : created) FPDFPage_InsertObject(page, c);
            handled.insert(object);
            split++;
        }
    }

    // Whole objects, highest index first: removing one shifts every index above it.
    int count = FPDFPage_CountObjects(page);
    for (int index = count - 1; index >= 0; index--) {
        FPDF_PAGEOBJECT object = FPDFPage_GetObject(page, index);
        if (!object || handled.count(object)) continue;

        Rect bounds = objectBounds(object);
        bool hit = false;
        for (const auto& region : regions) if (overlaps(bounds, region)) { hit = true; break; }
        if (!hit) continue;

        int type = FPDFPageObj_GetType(object);
        if (!FPDFPage_RemoveObject(page, object)) continue;
        // RemoveObject detaches but does not free.
        FPDFPageObj_Destroy(object);

        if (type == FPDF_PAGEOBJ_TEXT) textObjects++;
        else if (type == FPDF_PAGEOBJ_IMAGE) images++;
        else paths++;
    }

    FPDFPage_GenerateContent(page);

    // Annotations sit on the page but outside its content stream, so a comment over
    // redacted text survives unless it is removed explicitly.
    std::vector<int> doomed;
    int annotCount = FPDFPage_GetAnnotCount(page);
    for (int index = 0; index < annotCount; index++) {
        FPDF_ANNOTATION annotation = FPDFPage_GetAnnot(page, index);
        if (!annotation) continue;

        FS_RECTF rect;
        if (FPDFAnnot_GetRect(annotation, &rect)) {
            Rect bounds = { std::min(rect.left, rect.right), std::min(rect.bottom, rect.top),
                            std::max(rect.left, rect.right), std::max(rect.bottom, rect.top) };
            bool hit = false;
            for (const auto& region : regions) if (overlaps(bounds, region)) { hit = true; break; }
            if (hit) {
                // A form field's value lives in the AcroForm field dictionary, not on the
                // page, so removing the widget alone leaves the value in the file.
                const unsigned short empty[1] = { 0 };
                if (FPDFAnnot_SetStringValue(annotation, "V", empty)) {
                    unsigned long need = FPDFAnnot_GetStringValue(annotation, "T", nullptr, 0);
                    std::string name = "(unnamed)";
                    if (need > 2) {
                        std::vector<unsigned short> buffer(need / 2);
                        FPDFAnnot_GetStringValue(annotation, "T", buffer.data(), need);
                        name.clear();
                        for (size_t i = 0; i + 1 < buffer.size(); i++) {
                            name.push_back(static_cast<char>(buffer[i] & 0xff));
                        }
                    }
                    lastClearedFields.push_back(name);
                }
                doomed.push_back(index);
            }
        }
        FPDFPage_CloseAnnot(annotation);
    }
    for (auto it = doomed.rbegin(); it != doomed.rend(); ++it) {
        if (FPDFPage_RemoveAnnot(page, *it)) annotations++;
    }

    if (textPage) FPDFText_ClosePage(textPage);

    int changed = (textObjects || split || images || paths || annotations) ? 1 : 0;
    jint values[6] = { textObjects, split, images, paths, annotations, changed };
    jintArray out = env->NewIntArray(6);
    env->SetIntArrayRegion(out, 0, 6, values);
    return out;
}

extern "C" JNIEXPORT jobjectArray JNICALL
Java_com_pdfiumkit_Native_redactedFieldNames(JNIEnv* env, jclass, jlong, jint) {
    jobjectArray out = env->NewObjectArray(
            static_cast<jsize>(lastClearedFields.size()),
            env->FindClass("java/lang/String"), nullptr);
    for (size_t i = 0; i < lastClearedFields.size(); i++) {
        env->SetObjectArrayElement(out, static_cast<jsize>(i),
                                   env->NewStringUTF(lastClearedFields[i].c_str()));
    }
    return out;
}

/// An attachment is the easiest way for removed text to walk out of a document.
extern "C" JNIEXPORT jobjectArray JNICALL
Java_com_pdfiumkit_Native_scrubAttachments(
        JNIEnv* env, jclass, jlong handle, jobjectArray needlesArray) {
    auto* d = asDoc(handle);
    jclass stringClass = env->FindClass("java/lang/String");
    if (!d || !d->doc) return env->NewObjectArray(0, stringClass, nullptr);

    std::vector<std::string> needles;
    jsize needleCount = env->GetArrayLength(needlesArray);
    for (jsize i = 0; i < needleCount; i++) {
        auto s = reinterpret_cast<jstring>(env->GetObjectArrayElement(needlesArray, i));
        const char* chars = env->GetStringUTFChars(s, nullptr);
        needles.emplace_back(chars);
        env->ReleaseStringUTFChars(s, chars);
    }

    std::vector<std::string> removed;
    std::vector<int> doomed;
    int count = FPDFDoc_GetAttachmentCount(d->doc);

    for (int index = 0; index < count; index++) {
        FPDF_ATTACHMENT attachment = FPDFDoc_GetAttachment(d->doc, index);
        if (!attachment) continue;

        std::string name;
        unsigned long need = FPDFAttachment_GetName(attachment, nullptr, 0);
        if (need > 2) {
            std::vector<unsigned short> buffer(need / 2);
            FPDFAttachment_GetName(attachment, buffer.data(), need);
            for (size_t i = 0; i + 1 < buffer.size(); i++) {
                name.push_back(static_cast<char>(buffer[i] & 0xff));
            }
        }

        std::string content;
        unsigned long size = 0;
        FPDFAttachment_GetFile(attachment, nullptr, 0, &size);
        if (size > 0) {
            std::vector<uint8_t> bytes(size);
            FPDFAttachment_GetFile(attachment, bytes.data(), size, &size);
            content.assign(bytes.begin(), bytes.end());
        }

        for (const auto& needle : needles) {
            if (name.find(needle) != std::string::npos ||
                content.find(needle) != std::string::npos) {
                doomed.push_back(index);
                removed.push_back(name);
                break;
            }
        }
    }

    // Highest index first, for the same reason as annotations.
    for (auto it = doomed.rbegin(); it != doomed.rend(); ++it) {
        FPDFDoc_DeleteAttachment(d->doc, *it);
    }

    jobjectArray out = env->NewObjectArray(
            static_cast<jsize>(removed.size()), stringClass, nullptr);
    for (size_t i = 0; i < removed.size(); i++) {
        env->SetObjectArrayElement(out, static_cast<jsize>(i),
                                   env->NewStringUTF(removed[i].c_str()));
    }
    return out;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_pdfiumkit_Native_pageObjectCount(JNIEnv*, jclass, jlong handle, jint pageIndex) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = d ? loadPage(d, pageIndex) : nullptr;
    return page ? FPDFPage_CountObjects(page) : 0;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_pdfiumkit_Native_pageObjectType(JNIEnv*, jclass, jlong handle, jint pageIndex, jint index) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = d ? loadPage(d, pageIndex) : nullptr;
    if (!page) return 0;
    FPDF_PAGEOBJECT object = FPDFPage_GetObject(page, index);
    return object ? FPDFPageObj_GetType(object) : 0;
}

extern "C" JNIEXPORT jfloatArray JNICALL
Java_com_pdfiumkit_Native_pageObjectBounds(
        JNIEnv* env, jclass, jlong handle, jint pageIndex, jint index) {
    jfloatArray out = env->NewFloatArray(4);
    auto* d = asDoc(handle);
    FPDF_PAGE page = d ? loadPage(d, pageIndex) : nullptr;
    if (!page) return out;

    FPDF_PAGEOBJECT object = FPDFPage_GetObject(page, index);
    if (!object) return out;

    Rect bounds = objectBounds(object);
    jfloat values[4] = { bounds.left, bounds.bottom, bounds.right, bounds.top };
    env->SetFloatArrayRegion(out, 0, 4, values);
    return out;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_pdfiumkit_Native_pageObjectText(
        JNIEnv* env, jclass, jlong handle, jint pageIndex, jint index) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = d ? loadPage(d, pageIndex) : nullptr;
    if (!page) return env->NewStringUTF("");

    FPDF_PAGEOBJECT object = FPDFPage_GetObject(page, index);
    if (!object || FPDFPageObj_GetType(object) != FPDF_PAGEOBJ_TEXT) return env->NewStringUTF("");

    FPDF_TEXTPAGE textPage = FPDFText_LoadPage(page);
    if (!textPage) return env->NewStringUTF("");

    // A text object holds glyph codes; the text page is the only thing that knows what
    // they say.
    unsigned long need = FPDFTextObj_GetText(object, textPage, nullptr, 0);
    jstring result = env->NewStringUTF("");
    if (need > 2) {
        std::vector<unsigned short> buffer(need / 2);
        FPDFTextObj_GetText(object, textPage, buffer.data(), need);
        jsize length = static_cast<jsize>(buffer.size());
        if (length > 0 && buffer[length - 1] == 0) length--;
        result = env->NewString(buffer.data(), length);
    }
    FPDFText_ClosePage(textPage);
    return result;
}

extern "C" JNIEXPORT jfloat JNICALL
Java_com_pdfiumkit_Native_pageObjectFontSize(
        JNIEnv*, jclass, jlong handle, jint pageIndex, jint index) {
    auto* d = asDoc(handle);
    FPDF_PAGE page = d ? loadPage(d, pageIndex) : nullptr;
    if (!page) return 0;

    FPDF_PAGEOBJECT object = FPDFPage_GetObject(page, index);
    if (!object) return 0;

    float size = 0;
    return FPDFTextObj_GetFontSize(object, &size) ? size : 0;
}
