// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PdfiumKit",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "PdfiumKit", targets: ["PdfiumKit"]),
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
    ]
)
