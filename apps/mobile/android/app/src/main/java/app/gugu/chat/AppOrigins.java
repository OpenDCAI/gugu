package app.gugu.chat;

import android.content.Context;
import android.content.res.AssetManager;
import android.webkit.WebResourceResponse;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * @@@app-origins (L9, 摩擦单 F76) — On the phone every App runs in an origin of its own:
 * https://<appId>.apps.gugu.invalid/ — never gugu's (https://localhost), never another App's. `.invalid` never
 * resolves, so nothing but this shell ever answers there. Its storage
 * (localStorage, IndexedDB …) is then its own, as each App's partition is on the desktop.
 *
 * What an origin serves comes from the index the gugu page writes (phoneApps.ts): the App's files — shipped in this
 * bundle (asset:) or installed from a chat (file:) — with the CSP the page computed from its manifest (the desktop's
 * policy, app-csp.ts). The platform runtime is served under each origin's /_gugu/ from this build, as the desktop does,
 * so the tag the page injected (/_gugu/1/gugu.js) and the App's module imports are same-origin.
 */
final class AppOrigins {
    static final String DOMAIN = ".apps.gugu.invalid";
    /** The host's shape is the page's (phoneApps.ts `appOrigin`): the App id under the domain. */
    private static final Pattern HOST = Pattern.compile("^([a-z0-9][a-z0-9-]{1,63})" + Pattern.quote(DOMAIN) + "$");
    private static final String RUNTIME_PREFIX = "/_gugu/";

    private static volatile Map<String, Served> served = null;

    private static final class Served {
        final String root;
        final String csp;

        Served(String root, String csp) {
            this.root = root;
            this.csp = csp;
        }
    }

    private AppOrigins() {}

    static File root(Context context) {
        File root = new File(context.getFilesDir(), "gugu-apps");
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
        return root;
    }

    /** The App id an origin's host names, or null for any other host. */
    static String appOf(String host) {
        if (host == null) return null;
        Matcher matcher = HOST.matcher(host.toLowerCase(Locale.ROOT));
        return matcher.matches() ? matcher.group(1) : null;
    }

    static String readIndex(Context context) {
        File file = new File(root(context), "index.json");
        try {
            return file.isFile() ? new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8) : null;
        } catch (IOException error) {
            return null;
        }
    }

    static void writeIndex(Context context, String json) throws IOException {
        Map<String, Served> next = parse(json);
        writeAtomically(new File(root(context), "index.json"), json.getBytes(StandardCharsets.UTF_8));
        served = next;
    }

    static void writeAtomically(File file, byte[] bytes) throws IOException {
        File temp = new File(file.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temp)) {
            out.write(bytes);
            out.getFD().sync();
        }
        if (!temp.renameTo(file)) throw new IOException("could not replace " + file.getName());
    }

    /** `{ serve: { <appId>: { root: "asset:public/apps/<id>" | "file:<id>@<version>", csp } } }` — the rest is the page's. */
    private static Map<String, Served> parse(String json) {
        Map<String, Served> map = new HashMap<>();
        try {
            JSONObject serve = new JSONObject(json).optJSONObject("serve");
            if (serve == null) return map;
            for (java.util.Iterator<String> ids = serve.keys(); ids.hasNext(); ) {
                String id = ids.next();
                JSONObject entry = serve.optJSONObject(id);
                if (entry != null && entry.has("root") && entry.has("csp")) map.put(id, new Served(entry.getString("root"), entry.getString("csp")));
            }
        } catch (JSONException error) {
            return Collections.emptyMap();
        }
        return map;
    }

    private static Map<String, Served> served(Context context) {
        Map<String, Served> current = served;
        if (current == null) {
            String json = readIndex(context);
            current = json == null ? Collections.emptyMap() : parse(json);
            served = current;
        }
        return current;
    }

    /** A file of App `appId` at `path`, as its origin serves it; 404 for anything it does not have. */
    static WebResourceResponse serve(Context context, String appId, String path) {
        Served app = served(context).get(appId);
        if (app == null || path == null) return empty(404, Collections.emptyMap());
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Security-Policy", app.csp);
        headers.put("Cache-Control", "no-cache");
        try {
            InputStream body = open(context, app.root, path);
            if (body == null) return empty(404, headers);
            String mime = mimeOf(path);
            return new WebResourceResponse(mime, mime.startsWith("text/") || mime.endsWith("javascript") || mime.endsWith("json") ? "utf-8" : null, 200, "OK", headers, body);
        } catch (IOException error) {
            return empty(404, headers);
        }
    }

    private static InputStream open(Context context, String root, String path) throws IOException {
        if (path.contains("\\") || path.contains("/../") || path.endsWith("/..") || path.contains("\u0000")) return null;
        AssetManager assets = context.getAssets();
        // The runtime is this build's, whatever the App shipped (a bundle cannot ship /_gugu/: bundleEntryRejection).
        if (path.startsWith(RUNTIME_PREFIX)) return assets.open("public" + path);
        if (root.startsWith("asset:")) return assets.open(root.substring("asset:".length()) + path);
        if (!root.startsWith("file:")) return null;
        File base = new File(root(context), root.substring("file:".length())).getCanonicalFile();
        File file = new File(base, path.substring(1)).getCanonicalFile();
        if (!file.getPath().startsWith(base.getPath() + File.separator) || !file.isFile()) return null;
        return new FileInputStream(file);
    }

    private static final Map<String, String> TYPES = new HashMap<>();

    static {
        TYPES.put("html", "text/html");
        TYPES.put("htm", "text/html");
        TYPES.put("js", "text/javascript");
        TYPES.put("mjs", "text/javascript");
        TYPES.put("css", "text/css");
        TYPES.put("json", "application/json");
        TYPES.put("map", "application/json");
        TYPES.put("txt", "text/plain");
        TYPES.put("md", "text/markdown");
        TYPES.put("svg", "image/svg+xml");
        TYPES.put("png", "image/png");
        TYPES.put("jpg", "image/jpeg");
        TYPES.put("jpeg", "image/jpeg");
        TYPES.put("gif", "image/gif");
        TYPES.put("webp", "image/webp");
        TYPES.put("ico", "image/x-icon");
        TYPES.put("woff", "font/woff");
        TYPES.put("woff2", "font/woff2");
        TYPES.put("ttf", "font/ttf");
        TYPES.put("otf", "font/otf");
        TYPES.put("wasm", "application/wasm");
        TYPES.put("mp3", "audio/mpeg");
        TYPES.put("wav", "audio/wav");
        TYPES.put("ogg", "audio/ogg");
        TYPES.put("mp4", "video/mp4");
        TYPES.put("webm", "video/webm");
    }

    private static String mimeOf(String path) {
        int dot = path.lastIndexOf('.');
        String type = dot < 0 ? null : TYPES.get(path.substring(dot + 1).toLowerCase(Locale.ROOT));
        return type == null ? "application/octet-stream" : type;
    }

    static WebResourceResponse empty(int status, Map<String, String> headers) {
        String reason = status == 204 ? "No Content" : status == 403 ? "Forbidden" : "Not Found";
        return new WebResourceResponse("text/plain", "utf-8", status, reason, headers, new ByteArrayInputStream(new byte[0]));
    }
}
