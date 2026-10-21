// 分派、错误、参数取值、JSON 输出 —— 各能力文件(Calendar.swift …)共用。
import Foundation

/// 回给咕咕的错:code 与设备动作的错误码同名(os_permission / invalid_args / not_found / needs_confirmation / execution_failed / unsupported)。
struct HelperError: Error {
    let code: String
    let message: String
    var details: Any? = nil

    static func invalid(_ message: String) -> HelperError { HelperError(code: "invalid_args", message: message) }
    static func notFound(_ message: String) -> HelperError { HelperError(code: "invalid_args", message: message) }
    static func permission(_ message: String) -> HelperError { HelperError(code: "os_permission", message: message) }
    static func failed(_ message: String) -> HelperError { HelperError(code: "execution_failed", message: message) }
    static func confirm(_ question: String, details: Any? = nil) -> HelperError { HelperError(code: "needs_confirmation", message: question, details: details) }
}

typealias Handler = (Params) async throws -> Any?

final class Router: @unchecked Sendable {
    private var handlers: [String: Handler] = [:]

    func on(_ method: String, _ handler: @escaping Handler) {
        handlers[method] = handler
    }

    func handle(_ method: String, _ params: Params) async throws -> Any? {
        guard let handler = handlers[method] else {
            throw HelperError(code: "unknown_action", message: "gugu-mac-helper has no method \(method)")
        }
        return try await handler(params)
    }
}

/// 参数取值:缺 / 类型不对的,`require*` 抛 invalid_args,其余回 nil。
struct Params {
    let raw: [String: Any]
    init(_ raw: [String: Any]) { self.raw = raw }

    func string(_ key: String) -> String? {
        guard let value = raw[key] as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    func requireString(_ key: String) throws -> String {
        guard let value = string(key) else { throw HelperError.invalid("\(key) is required") }
        return value
    }
    func int(_ key: String) -> Int? {
        if let n = raw[key] as? Int { return n }
        if let d = raw[key] as? Double, d.isFinite { return Int(d) }
        return nil
    }
    func double(_ key: String) -> Double? {
        if let d = raw[key] as? Double { return d }
        if let n = raw[key] as? Int { return Double(n) }
        return nil
    }
    func bool(_ key: String) -> Bool? { raw[key] as? Bool }
    func strings(_ key: String) -> [String]? {
        if let list = raw[key] as? [Any] { return list.compactMap { $0 as? String } }
        if let one = string(key) { return [one] }
        return nil
    }
    func object(_ key: String) -> [String: Any]? { raw[key] as? [String: Any] }
    func objects(_ key: String) -> [[String: Any]]? { (raw[key] as? [Any])?.compactMap { $0 as? [String: Any] } }
    func date(_ key: String) throws -> Date? {
        guard let text = string(key) else { return nil }
        guard let date = parseDate(text) else { throw HelperError.invalid("\(key) must be an ISO 8601 date/time, got \(text)") }
        return date
    }
    func requireDate(_ key: String) throws -> Date {
        guard let date = try date(key) else { throw HelperError.invalid("\(key) is required") }
        return date
    }
}

/// ISO 8601:带偏移的按偏移;不带偏移的按这台电脑的本地时间(agent 用设备时区算好再传);只有日期的 = 当地那天 0 点。
func parseDate(_ text: String) -> Date? {
    let withZone = ISO8601DateFormatter()
    withZone.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = withZone.date(from: text) { return d }
    withZone.formatOptions = [.withInternetDateTime]
    if let d = withZone.date(from: text) { return d }
    let local = DateFormatter()
    local.locale = Locale(identifier: "en_US_POSIX")
    local.timeZone = TimeZone.current
    for format in ["yyyy-MM-dd'T'HH:mm:ss.SSS", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd"] {
        local.dateFormat = format
        if let d = local.date(from: text) { return d }
    }
    return nil
}

/// 回给 agent 的时间:带本地偏移的 ISO 8601(2026-10-16T15:00:00+08:00),一眼看得出是当地几点。
func isoLocal(_ date: Date?) -> String? {
    guard let date else { return nil }
    let f = ISO8601DateFormatter()
    f.timeZone = TimeZone.current
    f.formatOptions = [.withInternetDateTime]
    return f.string(from: date)
}

/// 只有日期(全天事件、提醒的到期日)。
func isoDay(_ date: Date?) -> String? {
    guard let date else { return nil }
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone.current
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: date)
}

/// 把结果里 JSON 不认的东西(Date、URL、nil、NSNumber 以外的)换成能写的。
func jsonSafe(_ value: Any?) -> Any {
    guard let value else { return NSNull() }
    switch value {
    case let d as Date: return isoLocal(d) ?? NSNull()
    case let u as URL: return u.absoluteString
    case let s as String: return s
    case let n as NSNumber: return n
    case let b as Bool: return b
    case let i as Int: return i
    case let d as Double: return d.isFinite ? d : NSNull()
    case let a as [Any?]: return a.map { jsonSafe($0) }
    case let a as [Any]: return a.map { jsonSafe($0) }
    case let o as [String: Any?]: return o.mapValues { jsonSafe($0) }
    case let o as [String: Any]: return o.mapValues { jsonSafe($0) }
    case is NSNull: return NSNull()
    default: return "\(value)"
    }
}

/// 回复一行一个 JSON;多个 Task 并发回复,串起来写。
final class OutputWriter: @unchecked Sendable {
    private let queue = DispatchQueue(label: "gugu-mac-helper.output")

    func reply(_ message: [String: Any]) {
        queue.sync {
            guard let data = try? JSONSerialization.data(withJSONObject: message, options: []) else {
                FileHandle.standardError.write("gugu-mac-helper: unserializable reply\n".data(using: .utf8)!)
                return
            }
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write("\n".data(using: .utf8)!)
        }
    }
}
