#pragma once
#include <cstddef>
#include <cstdint>
#include <vector>
#include "public/fpdfview.h"

/// Draws the trial watermark over an already rendered bitmap.
void pdfcora_draw_watermark(FPDF_BITMAP bitmap, int width, int height);

/// A full save of the document in `data` with the watermark in every page's content.
/// Empty when the bytes cannot be reopened or saved.
std::vector<uint8_t> pdfcora_stamp_watermark(const uint8_t* data, size_t size);
