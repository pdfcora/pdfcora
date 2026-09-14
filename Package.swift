// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PdfiumKit",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "PdfiumKit", targets: ["PdfiumKit"]),
        // Optional, and additive: the core product above is untouched (PKG-1).
        .library(name: "PdfiumKitAI", targets: ["PdfiumKitAI"]),
        // The UI layer. Optional: the headless PdfViewer stays usable alone.
        .library(name: "PdfiumKitUI", targets: ["PdfiumKitUI"]),
    ],
    targets: [
        .binaryTarget(name: "pdfium", path: "vendor/ios/pdfium.xcframework"),
        .target(
            name: "CPdfium",
            dependencies: ["pdfium"],
            path: "ios/Sources/CPdfium",
            publicHeadersPath: "include"
        ),
        .target(name: "PdfiumKit", dependencies: ["CPdfium"], path: "ios/Sources/PdfiumKit"),
        .testTarget(name: "PdfiumKitTests", dependencies: ["PdfiumKit"], path: "ios/Tests/PdfiumKitTests"),
        .target(name: "PdfiumKitAI", dependencies: ["PdfiumKit"], path: "ios/Sources/PdfiumKitAI"),
        .target(name: "PdfiumKitUI", dependencies: ["PdfiumKit"], path: "ios/Sources/PdfiumKitUI"),
        .testTarget(name: "PdfiumKitAITests", dependencies: ["PdfiumKitAI"], path: "ios/Tests/PdfiumKitAITests"),
    ]
)
