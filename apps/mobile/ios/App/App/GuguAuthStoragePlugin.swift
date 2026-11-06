import Capacitor
import Foundation
import Security

/** Same boundary as Android: retirement is an envelope write, never a generic session delete. */
@objc(GuguAuthStoragePlugin)
public final class GuguAuthStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GuguAuthStoragePlugin"
    public let jsName = "GuguAuthStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]
    private let queue = DispatchQueue(label: "app.gugu.auth-storage")
    private let service = (Bundle.main.bundleIdentifier ?? "app.gugu.chat") + ".auth-storage"
    private let temporaryKeys: Set<String> = ["sb-main-code-verifier", "sb-main-oauth-pending"]

    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: key]
    }

    private func key(_ call: CAPPluginCall, temporaryOnly: Bool = false) -> String? {
        guard let key = call.getString("key"),
              temporaryKeys.contains(key) || (!temporaryOnly && key == "sb-main") else {
            call.reject("Unsupported storage key")
            return nil
        }
        return key
    }

    @objc public func get(_ call: CAPPluginCall) {
        guard let key = key(call) else { return }
        queue.async {
            var query = self.query(key)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            if status == errSecItemNotFound { call.resolve(["value": NSNull()]); return }
            guard status == errSecSuccess, let data = result as? Data,
                  let value = String(data: data, encoding: .utf8) else {
                call.reject("Auth storage read failed", "KEYCHAIN_\(status)")
                return
            }
            call.resolve(["value": value])
        }
    }

    @objc public func write(_ call: CAPPluginCall) {
        guard let key = key(call) else { return }
        guard let value = call.getString("value") else { call.reject("Missing storage value"); return }
        queue.async {
            let query = self.query(key)
            let attributes: [String: Any] = [
                kSecValueData as String: Data(value.utf8),
                kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            ]
            var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            if status == errSecItemNotFound {
                status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
            }
            guard status == errSecSuccess else {
                call.reject("Auth storage write failed", "KEYCHAIN_\(status)")
                return
            }
            call.resolve()
        }
    }

    @objc public func remove(_ call: CAPPluginCall) {
        guard let key = key(call, temporaryOnly: true) else { return }
        queue.async {
            let status = SecItemDelete(self.query(key) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                call.reject("Auth storage removal failed", "KEYCHAIN_\(status)")
                return
            }
            call.resolve()
        }
    }
}
