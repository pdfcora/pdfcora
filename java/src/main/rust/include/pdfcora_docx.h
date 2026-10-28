// DOCX to PDF, for the JNI glue. Built from java/src/main/rust.
#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// 0 = converted (*out, *out_len set), 1 = not a DOCX, 2 = failed (*error set, UTF-8, NUL-terminated)
int32_t pdfcora_docx_convert(const uint8_t* data, size_t len,
                             uint8_t** out, size_t* out_len, char** error);
void pdfcora_docx_free(uint8_t* out, size_t len);
void pdfcora_docx_free_error(char* error);

#ifdef __cplusplus
}
#endif
