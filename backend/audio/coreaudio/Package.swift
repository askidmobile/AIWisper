// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "coreaudio-tap",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        .executableTarget(
            name: "coreaudio-tap",
            path: "Sources",
            linkerSettings: [
                .linkedFramework("CoreAudio"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("AVFoundation")
            ]
        )
    ]
)
