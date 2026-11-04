package app.gugu.chat;

import android.util.Base64;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A chat folder's HTML document on the phone, previewed with its folder: https://<previewId>.preview.gugu.invalid/<path>.
 * `.invalid` never resolves, so nothing but this shell answers there; each preview is an origin of its own.
 *
 * The WebView client hands every request of such an origin to the gugu page (`guguPreviewRequest`), which finds the file
 * beside the document in its chat's folder and reads it the one way the desktop does (chat-folder-preview.ts), and gives
 * the answer back here (`answer`). Nothing about the file is decided in Java: this is only the carrier.
 */
@CapacitorPlugin(name = "GuguPreviewOrigins")
public class GuguPreviewOrigins extends Plugin {
    private static final String TAG = "GuguPreviewOrigins";
    private static final Pattern HOST = Pattern.compile("^([0-9a-f]{32})\\.preview\\.gugu\\.invalid$");
    private static final Pattern RANGE = Pattern.compile("^bytes=(\\d*)-(\\d*)$");
    /** As long as the desktop's handler waits for one answer (PREVIEW_REQUEST_DEADLINE_MS). */
    private static final long DEADLINE_SECONDS = 90;
    private static final Map<String, CompletableFuture<JSONObject>> waiting = new ConcurrentHashMap<>();

    /** The preview id a host names, or null for any other host. */
    static String previewOf(String host) {
        if (host == null) return null;
        Matcher matcher = HOST.matcher(host.toLowerCase(Locale.ROOT));
        return matcher.matches() ? matcher.group(1) : null;
    }

    /** Called on the WebView's request thread: asks the page and waits for its answer. */
    static WebResourceResponse serve(Bridge bridge, String previewId, WebResourceRequest request) {
        String requestId = UUID.randomUUID().toString();
        CompletableFuture<JSONObject> answer = new CompletableFuture<>();
        waiting.put(requestId, answer);
        try {
            JSObject asked = new JSObject();
            asked.put("requestId", requestId);
            asked.put("previewId", previewId);
            // Not "path": Capacitor copies these onto an Event, and an older WebView's Event has a read-only `path` (WebView 113).
            asked.put("resource", request.getUrl().getEncodedPath());
            String range = header(request.getRequestHeaders(), "Range");
            asked.put("range", range == null ? JSONObject.NULL : range);
            bridge.triggerWindowJSEvent("guguPreviewRequest", asked.toString());
            return responseOf(answer.get(DEADLINE_SECONDS, TimeUnit.SECONDS), range);
        } catch (Exception error) {
            Log.w(TAG, "a preview request had no answer: " + error);
            return new WebResourceResponse("text/plain", "utf-8", 504, "Gateway Timeout", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
        } finally {
            waiting.remove(requestId);
        }
    }

    @PluginMethod
    public void answer(PluginCall call) {
        String requestId = call.getString("requestId");
        CompletableFuture<JSONObject> pending = requestId == null ? null : waiting.get(requestId);
        if (pending == null) { call.reject("No such preview request"); return; }
        pending.complete(call.getData());
        call.resolve();
    }

    /**
     * A `Range` (a video being sought) is answered the way Capacitor's own server answers one (WebViewLocalServer): 206
     * and the range's Content-Range over the whole file, which the WebView then cuts itself. A body that is only the range
     * is read by WebView 113 as the file's start, and it asks for the same range again and again.
     */
    private static WebResourceResponse responseOf(JSONObject answer, String range) throws JSONException {
        int status = answer.getInt("status");
        Map<String, String> headers = new HashMap<>();
        JSONObject given = answer.optJSONObject("headers");
        if (given != null) {
            for (Iterator<String> names = given.keys(); names.hasNext(); ) {
                String name = names.next();
                headers.put(name, given.getString(name));
            }
        }
        String contentType = headers.getOrDefault("Content-Type", "application/octet-stream");
        String mime = contentType.split(";", 2)[0].trim();
        String charset = contentType.contains("charset=") ? contentType.substring(contentType.indexOf("charset=") + 8).trim() : null;
        byte[] body = answer.isNull("body") ? new byte[0] : Base64.decode(answer.getString("body"), Base64.DEFAULT);
        Matcher ranged = range == null ? null : RANGE.matcher(range.trim());
        if (status == 200 && ranged != null && ranged.matches() && !ranged.group(1).isEmpty() && body.length > 0) {
            long from = Long.parseLong(ranged.group(1));
            long to = ranged.group(2).isEmpty() ? body.length - 1 : Math.min(Long.parseLong(ranged.group(2)), body.length - 1);
            status = 206;
            headers.remove("Content-Length");
            headers.put("Content-Range", "bytes " + from + "-" + to + "/" + body.length);
        }
        return new WebResourceResponse(mime, charset, status, reason(status), headers, new ByteArrayInputStream(body));
    }

    private static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 206: return "Partial Content";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 413: return "Payload Too Large";
            case 416: return "Range Not Satisfiable";
            case 503: return "Service Unavailable";
            default: return "Error";
        }
    }

    private static String header(Map<String, String> headers, String name) {
        if (headers == null) return null;
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (entry.getKey() != null && entry.getKey().equalsIgnoreCase(name)) return entry.getValue();
        }
        return null;
    }
}
