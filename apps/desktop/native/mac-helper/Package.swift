// swift-tools-version: 5.9
// #7199 咕咕的 Mac 原生助手:日历 / 提醒事项 / 通讯录 / 定位 / 文字识别 / 系统授权这些只有原生接口的能力。
// 由 scripts/build/build-mac-native.mjs 编译(按架构),打包进 咕咕.app/Contents/Resources/mac-native/gugu-mac-helper。
// Info.plist 嵌进二进制(-sectcreate):系统框架读用途说明时找得到,❌ 因缺说明直接崩。
import PackageDescription

let package = Package(
    name: "GuguMacHelper",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "gugu-mac-helper", targets: ["GuguMacHelper"]),
    ],
    targets: [
        .executableTarget(
            name: "GuguMacHelper",
            path: "Sources/GuguMacHelper",
            exclude: ["Info.plist"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("EventKit"),
                .linkedFramework("Contacts"),
                .linkedFramework("CoreLocation"),
                .linkedFramework("Vision"),
                .linkedFramework("IOKit"),
                .linkedFramework("ApplicationServices"),
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/GuguMacHelper/Info.plist",
                ]),
            ]
        ),
    ]
)
