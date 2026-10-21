// 电池(battery.get:电量 / 充电 / 温控 / 电源);设置页各分组的 App 图标;前台 App。
import AppKit
import Foundation
import IOKit.ps

/// 一个文件 / App 的图标画成 size×size 的 PNG(base64)。
/// ❌ Electron 的 app.getFileIcon(size: 'large'):Electron 44 在 macOS 26 上取 .app 的大图标会把整个咕咕带崩(SIGTRAP,2026-10-15 实测)。
@MainActor
func iconPNG(path: String, size: Int) -> String? {
    let image = NSWorkspace.shared.icon(forFile: path)
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                                     hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let context = NSGraphicsContext(bitmapImageRep: rep)
    else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    image.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])?.base64EncodedString()
}

func registerSystem(_ r: Router) {
    /// 一批路径的图标:{ paths: [...], size: 96 } → { icons: [{ path, mimeType, data }] }(取不到的那个不在结果里)。
    r.on("icons.files") { p in
        let paths = p.strings("paths") ?? []
        let size = max(16, min(p.int("size") ?? 96, 512))
        var icons: [[String: Any]] = []
        for path in paths where FileManager.default.fileExists(atPath: path) {
            if let data = await MainActor.run(body: { iconPNG(path: path, size: size) }) {
                icons.append(["path": path, "mimeType": "image/png", "data": data])
            }
        }
        return ["icons": icons]
    }

    r.on("battery.status") { _ in
        let info = IOPSCopyPowerSourcesInfo().takeRetainedValue()
        let sources = IOPSCopyPowerSourcesList(info).takeRetainedValue() as [CFTypeRef]
        let providing = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() as String?
        var batteries: [[String: Any]] = []
        for source in sources {
            guard let d = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue() as? [String: Any] else { continue }
            guard (d[kIOPSTypeKey] as? String) == kIOPSInternalBatteryType else { continue }
            let current = d[kIOPSCurrentCapacityKey] as? Int
            let max = d[kIOPSMaxCapacityKey] as? Int
            var row: [String: Any] = [
                "name": d[kIOPSNameKey] as? String ?? "battery",
                "percent": (current != nil && max != nil && max! > 0) ? Int((Double(current!) / Double(max!) * 100).rounded()) : NSNull(),
                "charging": d[kIOPSIsChargingKey] as? Bool ?? false,
                "charged": d[kIOPSIsChargedKey] as? Bool ?? false,
                "power_source": d[kIOPSPowerSourceStateKey] as? String ?? "",
            ]
            if let t = d[kIOPSTimeToEmptyKey] as? Int, t > 0 { row["minutes_to_empty"] = t }
            if let t = d[kIOPSTimeToFullChargeKey] as? Int, t > 0 { row["minutes_to_full"] = t }
            if let health = d["BatteryHealth"] as? String { row["health"] = health }
            batteries.append(row)
        }
        let thermal: String
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: thermal = "nominal"
        case .fair: thermal = "fair"
        case .serious: thermal = "serious"
        case .critical: thermal = "critical"
        @unknown default: thermal = "unknown"
        }
        return [
            "has_battery": !batteries.isEmpty,
            "batteries": batteries,
            "providing_power_source": providing ?? "",
            "low_power_mode": ProcessInfo.processInfo.isLowPowerModeEnabled,
            "thermal_state": thermal,
        ]
    }
}
