#include "watermark.h"

#include <algorithm>
#include <cmath>
#include "public/fpdf_edit.h"
#include "public/fpdf_save.h"
#include "public/fpdf_transformpage.h"

namespace {

const char16_t kText[] = u"PdfiumKit trial";

void place(FPDF_DOCUMENT document, FPDF_PAGE page, float left, float bottom, float width, float height) {
    FPDF_PAGEOBJECT object = FPDFPageObj_NewTextObj(document, "Helvetica-Bold", 100.0f);
    if (!object) return;
    FPDFText_SetText(object, reinterpret_cast<FPDF_WIDESTRING>(kText));
    FPDFPageObj_SetFillColor(object, 128, 128, 128, 64);

    float l = 0, b = 0, r = 0, t = 0;
    FPDFPageObj_GetBounds(object, &l, &b, &r, &t);
    double angle = std::atan2(static_cast<double>(height), static_cast<double>(width));
    double scale = std::hypot(width, height) * 0.6 / std::max(1.0, static_cast<double>(r - l));
    double c = std::cos(angle) * scale;
    double s = std::sin(angle) * scale;
    FPDFPageObj_Transform(object, 1, 0, 0, 1, -(l + r) / 2.0, -(b + t) / 2.0);
    FPDFPageObj_Transform(object, c, s, -s, c, left + width / 2.0, bottom + height / 2.0);
    FPDFPage_InsertObject(page, object);
    FPDFPage_GenerateContent(page);
}

struct Collector {
    FPDF_FILEWRITE base;
    std::vector<uint8_t>* out;
};

int collect(FPDF_FILEWRITE* self, const void* data, unsigned long size) {
    auto* collector = reinterpret_cast<Collector*>(self);
    auto* bytes = static_cast<const uint8_t*>(data);
    collector->out->insert(collector->out->end(), bytes, bytes + size);
    return 1;
}

}  // namespace

void pdfiumkit_draw_watermark(FPDF_BITMAP bitmap, int width, int height) {
    FPDF_DOCUMENT scratch = FPDF_CreateNewDocument();
    if (!scratch) return;
    FPDF_PAGE page = FPDFPage_New(scratch, 0, width, height);
    if (page) {
        place(scratch, page, 0, 0, static_cast<float>(width), static_cast<float>(height));
        FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0);
        FPDF_ClosePage(page);
    }
    FPDF_CloseDocument(scratch);
}

std::vector<uint8_t> pdfiumkit_stamp_watermark(const uint8_t* data, size_t size) {
    std::vector<uint8_t> out;
    FPDF_DOCUMENT document = FPDF_LoadMemDocument(data, static_cast<int>(size), nullptr);
    if (!document) return out;
    int count = FPDF_GetPageCount(document);
    for (int index = 0; index < count; ++index) {
        FPDF_PAGE page = FPDF_LoadPage(document, index);
        if (!page) continue;
        float l = 0, b = 0, r = 0, t = 0;
        bool box = FPDFPage_GetMediaBox(page, &l, &b, &r, &t);
        place(document, page, box ? l : 0, box ? b : 0, FPDF_GetPageWidthF(page), FPDF_GetPageHeightF(page));
        FPDF_ClosePage(page);
    }
    Collector collector{};
    collector.base.version = 1;
    collector.base.WriteBlock = collect;
    collector.out = &out;
    if (!FPDF_SaveAsCopy(document, &collector.base, FPDF_NO_INCREMENTAL)) out.clear();
    FPDF_CloseDocument(document);
    return out;
}
