cmake_minimum_required(VERSION 3.18)
project(pdfcora)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT DEFINED PDFIUM_VENDOR_DIR)
    message(FATAL_ERROR "PDFIUM_VENDOR_DIR not set. Run scripts/fetch-vendor.sh first.")
endif()

set(PDFIUM_LIB "${PDFIUM_VENDOR_DIR}/${ANDROID_ABI}/libpdfium.a")
if(NOT EXISTS "${PDFIUM_LIB}")
    message(FATAL_ERROR "Missing ${PDFIUM_LIB} — run scripts/fetch-vendor.sh")
endif()

add_library(pdfium STATIC IMPORTED GLOBAL)
set_target_properties(pdfium PROPERTIES IMPORTED_LOCATION "${PDFIUM_LIB}")

add_library(pdfcora SHARED pdfcora_jni.cpp watermark.cpp)

target_include_directories(pdfcora PRIVATE "${PDFIUM_VENDOR_DIR}/include")

# Keep PDFium's symbols out of our ABI: only JNI entry points are exported.
target_link_options(pdfcora PRIVATE
    "-Wl,--exclude-libs,ALL"
    "-Wl,--gc-sections"
)

target_link_libraries(pdfcora pdfium android log jnigraphics)
