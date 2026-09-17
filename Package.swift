// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PDFCora",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "PDFCora", targets: ["PDFCora"]),
        // Optional, and additive: the core product above is untouched (PKG-1).
        .library(name: "PDFCoraAI", targets: ["PDFCoraAI"]),
        // The UI layer. Optional: the headless PdfViewer stays usable alone.
        .library(name: "PDFCoraUI", targets: ["PDFCoraUI"]),
    ],
    targets: [
        .binaryTarget(name: "pdfium", path: "vendor/ios/pdfium.xcframework"),
        .target(
            name: "CPdfium",
            dependencies: ["pdfium"],
            path: "ios/Sources/CPdfium",
            publicHeadersPath: "include"
        ),
        .target(name: "PDFCora", dependencies: ["CPdfium"], path: "ios/Sources/PDFCora"),
        .testTarget(name: "PDFCoraTests", dependencies: ["PDFCora"], path: "ios/Tests/PDFCoraTests"),
        .target(name: "PDFCoraAI", dependencies: ["PDFCora"], path: "ios/Sources/PDFCoraAI"),
        .target(name: "PDFCoraUI", dependencies: ["PDFCora"], path: "ios/Sources/PDFCoraUI"),
        .testTarget(name: "PDFCoraAITests", dependencies: ["PDFCoraAI"], path: "ios/Tests/PDFCoraAITests"),
    ]
)
