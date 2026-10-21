// 位置(CoreLocation)—— location.get / location.geocode,见 apps/desktop/electron/device-actions/families/device.ts。
// 定位器要在主线程上建(回调回到建它的线程的 run loop;main.swift 让主线程一直跑着 RunLoop.main)。
// 反查地址用 CLGeocoder:要联网、走 Apple 的服务,不要定位授权;location.get 里它只是「尽力」—— 查不到地址也回坐标。
// (CLGeocoder 在 macOS 26 标了弃用,换 MapKit 的 MKReverseGeocodingRequest 要 26 起;我们最低 13,先用它。)
import Contacts
// CLGeocoder / CLLocationManager 只在主线程上碰(见上),跨线程的 Sendable 告警不适用。
@preconcurrency import CoreLocation
import Foundation

private let LOCATE_TIMEOUT: TimeInterval = 20
private let GEOCODE_TIMEOUT: TimeInterval = 6

/// 做事前判一次定位授权与「定位服务」总开关。
func ensureLocation() throws {
    let details = ["settingsUrl": PRIVACY + "Privacy_LocationServices"]
    switch locationStatus() {
    case "granted": return
    case "services_off":
        throw HelperError(code: "os_permission", message: "Location Services are turned off on this Mac: System Settings → Privacy & Security → Location Services → turn the switch on and allow 咕咕.", details: details)
    case "not_determined":
        throw HelperError(code: "os_permission", message: "咕咕 has not been allowed to use this Mac's location yet. Connect \"位置\" in 咕咕 → Settings → Devices on this computer.", details: details)
    default:
        throw HelperError(code: "os_permission", message: "macOS has not allowed 咕咕 to use this Mac's location: System Settings → Privacy & Security → Location Services → turn on 咕咕.", details: details)
    }
}

/// 一次定位:requestLocation;系统说「暂时定不出来」(locationUnknown)就隔一秒再要,直到时限。
final class OneShotLocator: NSObject, CLLocationManagerDelegate, @unchecked Sendable {
    private var manager: CLLocationManager?
    private var continuation: CheckedContinuation<CLLocation, Error>?
    private var deadline = Date.distantFuture

    func locate(timeout: TimeInterval) async throws -> CLLocation {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<CLLocation, Error>) in
            DispatchQueue.main.async {
                self.continuation = cont
                self.deadline = Date().addingTimeInterval(timeout)
                let manager = CLLocationManager()
                self.manager = manager
                manager.delegate = self
                manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
                manager.requestLocation()
                DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
                    self.finish(.failure(HelperError(code: "timeout", message: "This Mac could not work out its location within \(Int(timeout)) s (Location Services usually need Wi-Fi turned on). Try again later.")))
                }
            }
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last(where: { $0.horizontalAccuracy >= 0 }) else {
            retrySoon()
            return
        }
        finish(.success(location))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let code = (error as? CLError)?.code
        if code == .denied {
            finish(.failure(HelperError(code: "os_permission", message: "macOS has not allowed 咕咕 to use this Mac's location: System Settings → Privacy & Security → Location Services → turn on 咕咕.", details: ["settingsUrl": PRIVACY + "Privacy_LocationServices"])))
            return
        }
        if code == .locationUnknown, Date().addingTimeInterval(1.5) < deadline {
            retrySoon()
            return
        }
        finish(.failure(HelperError.failed("This Mac could not work out its location: \(error.localizedDescription)")))
    }

    private func retrySoon() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, self.continuation != nil else { return }
            self.manager?.requestLocation()
        }
    }

    private func finish(_ result: Result<CLLocation, Error>) {
        guard let cont = continuation else { return }
        continuation = nil
        manager?.stopUpdatingLocation()
        manager?.delegate = nil
        manager = nil
        cont.resume(with: result)
    }
}

private func placemarkInfo(_ pm: CLPlacemark) -> [String: Any] {
    var row: [String: Any] = ["found": true]
    let street = [pm.subThoroughfare, pm.thoroughfare].compactMap { $0 }.joined(separator: " ").trimmingCharacters(in: .whitespaces)
    let fields: [(String, String?)] = [
        ("name", pm.name), ("street", street.isEmpty ? nil : street), ("sub_locality", pm.subLocality), ("locality", pm.locality),
        ("sub_administrative_area", pm.subAdministrativeArea), ("administrative_area", pm.administrativeArea),
        ("postal_code", pm.postalCode), ("country", pm.country), ("country_code", pm.isoCountryCode),
        ("ocean", pm.ocean), ("inland_water", pm.inlandWater), ("time_zone", pm.timeZone?.identifier),
    ]
    for (key, value) in fields {
        if let value, !value.isEmpty { row[key] = value }
    }
    if let address = pm.postalAddress {
        let line = CNPostalAddressFormatter.string(from: address, style: .mailingAddress)
            .split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: ", ")
        if !line.isEmpty { row["formatted"] = line }
    }
    return row
}

/// 坐标 → 地址。查不到(海上、荒野)回 found: false;超时 / 没网抛错。
func reverseGeocode(_ location: CLLocation, timeout: TimeInterval) async throws -> [String: Any] {
    let geocoder = CLGeocoder()
    return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<[String: Any], Error>) in
        DispatchQueue.main.async {
            // 完成回调只来一次(取消也回一次 geocodeCanceled):在这里收口。
            geocoder.reverseGeocodeLocation(location) { placemarks, error in
                // 带着地址的「部分结果」也算查到了。
                if let pm = placemarks?.first {
                    cont.resume(returning: placemarkInfo(pm))
                    return
                }
                guard let error else {
                    cont.resume(returning: ["found": false])
                    return
                }
                switch (error as? CLError)?.code {
                case .geocodeFoundNoResult?, .geocodeFoundPartialResult?:
                    cont.resume(returning: ["found": false])
                case .geocodeCanceled?:
                    cont.resume(throwing: HelperError(code: "timeout", message: "Looking up the address took more than \(Int(timeout)) s (it needs the internet)."))
                case .network?:
                    cont.resume(throwing: HelperError.failed("Looking up the address needs the internet (or Apple's geocoding service is limiting requests; wait a minute)."))
                default:
                    cont.resume(throwing: HelperError.failed("Looking up the address failed: \(error.localizedDescription)"))
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
                if geocoder.isGeocoding { geocoder.cancelGeocode() }
            }
        }
    }
}

private func coordinate(_ p: Params) throws -> CLLocation {
    guard let lat = p.double("latitude"), let lon = p.double("longitude") else { throw HelperError.invalid("latitude and longitude are required numbers") }
    guard (-90...90).contains(lat) else { throw HelperError.invalid("latitude must be within [-90, 90], got \(lat)") }
    guard (-180...180).contains(lon) else { throw HelperError.invalid("longitude must be within [-180, 180], got \(lon)") }
    return CLLocation(latitude: lat, longitude: lon)
}

func registerLocation(_ r: Router) {
    r.on("location.get") { _ in
        try ensureLocation()
        let location = try await OneShotLocator().locate(timeout: LOCATE_TIMEOUT)
        var row: [String: Any] = [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracy_m": (location.horizontalAccuracy * 10).rounded() / 10,
            "timestamp": isoLocal(location.timestamp) ?? "",
        ]
        if location.verticalAccuracy >= 0 { row["altitude_m"] = (location.altitude * 10).rounded() / 10 }
        do {
            row["address"] = try await reverseGeocode(location, timeout: GEOCODE_TIMEOUT)
        } catch {
            // 地址是附带的:查不到照样回坐标,并说清为什么没有地址。
            row["address"] = NSNull()
            row["address_error"] = (error as? HelperError)?.message ?? error.localizedDescription
        }
        return row
    }

    r.on("location.geocode") { p in
        let location = try coordinate(p)
        var row = try await reverseGeocode(location, timeout: GEOCODE_TIMEOUT * 2)
        row["latitude"] = location.coordinate.latitude
        row["longitude"] = location.coordinate.longitude
        return row
    }
}
