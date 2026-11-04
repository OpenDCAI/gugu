package app.gugu.chat;

/** Native storage boundary: session retirement is never a generic remove operation. */
final class AuthStorageKeys {
    static boolean isTemporary(String key) {
        return "sb-main-code-verifier".equals(key) || "sb-main-oauth-pending".equals(key);
    }
    static boolean isAllowed(String key) {
        return "sb-main".equals(key) || isTemporary(key);
    }
    private AuthStorageKeys() {}
}
