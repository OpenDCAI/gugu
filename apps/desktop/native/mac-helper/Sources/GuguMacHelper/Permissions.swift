// 系统授权:查(不弹窗)与请求(第一次会弹 macOS 的授权框)。咕咕设置里点「连接」时走 permissions.request,
// 各能力在做事前用 ensure* 判一次 —— 没授权回 os_permission 并写清去哪打开,❌ 在调用中途弹窗。
import ApplicationServices
import Contacts
import CoreGraphics
import CoreLocation
import EventKit
import Foundation

/// 全进程共用一个 EKEventStore(Apple 的建议;授权变了要 reset 才看得见新日历)。
final class EventStoreBox: @unchecked Sendable {
    static let shared = EventStoreBox()
    let store = EKEventStore()
}

func eventStatus(_ type: EKEntityType) -> String {
    let status = EKEventStore.authorizationStatus(for: type)
    if #available(macOS 14.0, *) {
        switch status {
        case .fullAccess: return "granted"
        case .writeOnly: return "write_only"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not_determined"
        @unknown default: return "unknown"
        }
    }
    switch status.rawValue {
    case 3: return "granted" // .authorized
    case 2: return "denied"
    case 1: return "restricted"
    default: return "not_determined"
    }
}

func contactsStatus() -> String {
    switch CNContactStore.authorizationStatus(for: .contacts) {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not_determined"
    default: return "granted" // .limited(macOS 不会出现)
    }
}

func locationStatus() -> String {
    let manager = CLLocationManager()
    if !CLLocationManager.locationServicesEnabled() { return "services_off" }
    switch manager.authorizationStatus {
    case .authorizedAlways: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not_determined"
    default: return "granted"
    }
}

let PRIVACY = "x-apple.systempreferences:com.apple.preference.security?"

/// 做事前判一次:没授权就回 os_permission(带去哪打开),❌ 在一次调用中途弹窗等人。
func ensureEvents(_ type: EKEntityType) throws {
    let status = eventStatus(type)
    let app = type == .event ? "日历" : "提醒事项"
    let pane = type == .event ? "Privacy_Calendars" : "Privacy_Reminders"
    switch status {
    case "granted": return
    case "write_only": throw HelperError(code: "os_permission", message: "macOS only gave 咕咕 write-only access to \(app == "日历" ? "Calendar" : "Reminders"). Open System Settings → Privacy & Security → \(app == "日历" ? "Calendars" : "Reminders") → 咕咕 and choose Full Access.", details: ["settingsUrl": PRIVACY + pane])
    case "not_determined": throw HelperError(code: "os_permission", message: "咕咕 has not been allowed to access \(app == "日历" ? "Calendar" : "Reminders") on this Mac yet. Connect \"\(app)\" in 咕咕 → Settings → Devices on this computer (macOS will ask once).", details: ["settingsUrl": PRIVACY + pane])
    default: throw HelperError(code: "os_permission", message: "macOS has not allowed 咕咕 to access \(app == "日历" ? "Calendar" : "Reminders"): System Settings → Privacy & Security → \(app == "日历" ? "Calendars" : "Reminders") → turn on 咕咕.", details: ["settingsUrl": PRIVACY + pane])
    }
}

func ensureContacts() throws {
    switch contactsStatus() {
    case "granted": return
    case "not_determined": throw HelperError(code: "os_permission", message: "咕咕 has not been allowed to access Contacts on this Mac yet. Connect \"通讯录\" in 咕咕 → Settings → Devices on this computer (macOS will ask once).", details: ["settingsUrl": PRIVACY + "Privacy_Contacts"])
    default: throw HelperError(code: "os_permission", message: "macOS has not allowed 咕咕 to access Contacts: System Settings → Privacy & Security → Contacts → turn on 咕咕.", details: ["settingsUrl": PRIVACY + "Privacy_Contacts"])
    }
}

func requestEvents(_ type: EKEntityType) async -> String {
    let store = EventStoreBox.shared.store
    do {
        if #available(macOS 14.0, *) {
            if type == .event { _ = try await store.requestFullAccessToEvents() } else { _ = try await store.requestFullAccessToReminders() }
        } else {
            _ = try await store.requestAccess(to: type)
        }
    } catch {
        FileHandle.standardError.write("permission request failed: \(error)\n".data(using: .utf8)!)
    }
    store.reset()
    return eventStatus(type)
}

/// 定位授权要等系统回调:放在主线程的 run loop 上,最多等 60 秒(用户还没点就回当前状态)。
final class LocationAuthorizer: NSObject, CLLocationManagerDelegate, @unchecked Sendable {
    private var manager: CLLocationManager?
    private var continuation: CheckedContinuation<String, Never>?

    func request() async -> String {
        await withCheckedContinuation { (cont: CheckedContinuation<String, Never>) in
            DispatchQueue.main.async {
                self.continuation = cont
                let manager = CLLocationManager()
                self.manager = manager
                manager.delegate = self
                if manager.authorizationStatus != .notDetermined {
                    self.finish()
                    return
                }
                manager.requestWhenInUseAuthorization()
                DispatchQueue.main.asyncAfter(deadline: .now() + 60) { self.finish() }
            }
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if manager.authorizationStatus != .notDetermined { finish() }
    }

    private func finish() {
        guard let cont = continuation else { return }
        continuation = nil
        cont.resume(returning: locationStatus())
    }
}

func registerPermissions(_ r: Router) {
    r.on("permissions.status") { _ in
        [
            "calendar": eventStatus(.event),
            "reminders": eventStatus(.reminder),
            "contacts": contactsStatus(),
            "location": locationStatus(),
            "accessibility": AXIsProcessTrusted() ? "granted" : "denied",
            "screen": CGPreflightScreenCaptureAccess() ? "granted" : "denied",
        ]
    }

    /// 请求一项授权;回请求之后的状态(granted / denied / not_determined …)与去哪打开。
    r.on("permissions.request") { p in
        let kind = try p.requireString("kind")
        switch kind {
        case "calendar":
            return ["status": await requestEvents(.event), "settingsUrl": PRIVACY + "Privacy_Calendars"]
        case "reminders":
            return ["status": await requestEvents(.reminder), "settingsUrl": PRIVACY + "Privacy_Reminders"]
        case "contacts":
            _ = try? await CNContactStore().requestAccess(for: .contacts)
            return ["status": contactsStatus(), "settingsUrl": PRIVACY + "Privacy_Contacts"]
        case "location":
            return ["status": await LocationAuthorizer().request(), "settingsUrl": PRIVACY + "Privacy_LocationServices"]
        case "accessibility":
            // 弹「“咕咕”想要使用辅助功能控制这台电脑」,用户要去系统设置里打开;这里只能回当前状态。
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            let trusted = AXIsProcessTrustedWithOptions(options)
            return ["status": trusted ? "granted" : "denied", "settingsUrl": PRIVACY + "Privacy_Accessibility"]
        case "screen":
            let granted = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
            return ["status": granted ? "granted" : "denied", "settingsUrl": PRIVACY + "Privacy_ScreenCapture"]
        default:
            throw HelperError.invalid("unknown permission kind \(kind)")
        }
    }
}
