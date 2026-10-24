package app.gugu.chat;

import java.net.URI;
import java.util.UUID;

/** Validation that runs before credentials are persisted or a host is started. */
final class GuguAgentHostPolicy {
    static String owner(String value) {
        if (value == null) throw new IllegalArgumentException("缺少账号标识");
        String canonical = UUID.fromString(value).toString();
        if (!canonical.equalsIgnoreCase(value)) throw new IllegalArgumentException("账号标识无效");
        return canonical;
    }

    static void device(String owner, String installId, String deviceId) {
        String install = owner(installId);
        if (!("phone-" + install + "-" + owner(owner)).equals(deviceId)) throw new IllegalArgumentException("手机设备标识与当前账号不匹配");
    }

    static void endpoint(String value) {
        URI uri = URI.create(value == null ? "" : value);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null)
            throw new IllegalArgumentException("手机宿主连接必须使用有效 HTTPS 地址");
    }

    static String publicMessage(String message, String... secrets) {
        String safe = message == null ? "手机运行时发生错误" : message;
        for (String secret : secrets) if (secret != null && !secret.isEmpty()) safe = safe.replace(secret, "[redacted]");
        return safe.replaceAll("(?i)Bearer\\s+[A-Za-z0-9._~+/=-]+", "Bearer [redacted]")
            .replaceAll("eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+", "[redacted]")
            .replaceAll("(?i)((?:access_token|refresh_token|api_key|apiKey)[\\\"']?\\s*[:=]\\s*[\\\"']?)[^\\s,\\\"']+", "$1[redacted]");
    }
}
