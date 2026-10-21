package app.gugu.chat;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.net.UnknownHostException;

import javax.net.ssl.SSLException;

/**
 * 下载站,从原生这边读 —— 页面(https://localhost)自己读会被浏览器层拦掉:下载站不发 CORS 头。
 *
 * 壳子在下载站上读的东西都走这一个读取器:
 * - 更新清单(GuguAppUpdatePlugin.fetchManifest):地址是打包时烘进来的(build.gradle);
 * - 新版安装包(GuguAppUpdatePlugin 下载时):地址是清单里写的那一个,只收 https://(那边核);
 * - App 市场的文件(GuguAppStorePlugin.marketRead):只读打包时烘进来的市场根下面 —— 页面只给相对路径,
 *   跟过重定向以后的地址也得还在根下面(`read` 的 `under`),跳去别处的不认。
 */
final class DownloadSite {
    private DownloadSite() {}

    /** 一个 200 的连接;别的状态码当场断开、抛出(报错原文带状态码,classifyUpdateError 认得出)。 */
    static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        // 问的是「线上现在是什么」,不是这台手机上次缓存的那份。
        connection.setUseCaches(false);
        int status = connection.getResponseCode();
        if (status != HttpURLConnection.HTTP_OK) {
            connection.disconnect();
            throw new IOException("HTTP " + status + " for " + url);
        }
        return connection;
    }

    /**
     * 整个读进来,读到超过 `maxBytes` 就当场停、抛出 `tooLarge`(调用方自己的那句话)—— ❌ 先读完再比。
     * `under`:跟过重定向以后的地址必须还以它开头(App 市场:市场根),不然正文一个字节都不读就抛出
     * (那一跳的请求已经发出去了,不读的是它回来的内容);null = 不限。
     */
    static byte[] read(String url, int maxBytes, String tooLarge, String under) throws IOException {
        HttpURLConnection connection = open(url);
        try {
            String landed = normalized(connection.getURL().toString());
            if (under != null && !landed.startsWith(under)) {
                throw new IOException(url + " was redirected outside " + under + " (to " + landed + ")");
            }
            try (InputStream in = connection.getInputStream()) {
                ByteArrayOutputStream body = new ByteArrayOutputStream();
                byte[] buffer = new byte[64 * 1024];
                int n;
                while ((n = in.read(buffer)) != -1) {
                    body.write(buffer, 0, n);
                    if (body.size() > maxBytes) throw new IOException(tooLarge);
                }
                return body.toByteArray();
            }
        } finally {
            connection.disconnect();
        }
    }

    /**
     * 比前缀之前先把 `.`、`..` 段规整掉 —— 不靠 HTTP 栈先替我们规整(Android 的会,JDK 的不会)。
     * `%2e` 就是 `.`(RFC 3986 §6.2.2.2),先解开再规整:`URI.normalize()` 自己不解,`%2e%2e` 会原样留在根下面。
     * 规整不了的地址(比如路径里有反斜杠)当场拒。
     */
    private static String normalized(String url) throws IOException {
        try {
            return new URI(url.replaceAll("(?i)%2e", ".")).normalize().toString();
        } catch (URISyntaxException error) {
            throw new IOException(url + " is not an address we can check: " + error.getMessage());
        }
    }

    /** 报错原文要让页面认得出是哪一类(网络 / 校验 / 找不到);认不出的原样带类名。 */
    static String describe(Throwable error) {
        if (error instanceof UnknownHostException || error instanceof SocketTimeoutException
                || error instanceof ConnectException || error instanceof SSLException) {
            return "network error: " + error;
        }
        String message = error.getMessage();
        return message != null ? message : error.toString();
    }
}
