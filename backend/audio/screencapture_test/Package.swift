// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ScreenCaptureTest",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "screencapture-test", targets: ["ScreenCaptureTest"])
    ],
    targets: [
        .executableTarget(
            name: "ScreenCaptureTest",
            path: "Sources",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("Foundation")
            ]
        )
    ]
)
