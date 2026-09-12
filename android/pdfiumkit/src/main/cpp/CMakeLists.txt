cmake_minimum_required(VERSION 3.18)
project(pdfiumkit)

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

add_library(pdfiumkit SHARED pdfiumkit_jni.cpp)

target_include_directories(pdfiumkit PRIVATE "${PDFIUM_VENDOR_DIR}/include")

# Keep PDFium's symbols out of our ABI: only JNI entry points are exported.
target_link_options(pdfiumkit PRIVATE
    "-Wl,--exclude-libs,ALL"
    "-Wl,--gc-sections"
)

target_link_libraries(pdfiumkit pdfium android log jnigraphics)
