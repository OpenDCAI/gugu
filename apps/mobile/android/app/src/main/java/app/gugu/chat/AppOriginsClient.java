package app.gugu.chat;

import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.util.Collections;
import java.util.Map;

/**
 * @@@app-origins (L9) — The gugu page's WebView client: it answers the Apps' own origins (AppOrigins), and it keeps an
 * App's frame from leaving its origin.
 *
 * Every other way out of an App frame is closed by its CSP (fetch, beacon, WebSocket, images, workers — L9 probe,
 * gugu-base evidence/2026-09-30-l9-mobile-apps). Navigating the frame itself is not a CSP matter, so it is refused
 * here, as the desktop refuses it in `will-navigate` (isAllowedExtensionNavigation): a frame's document request whose
 * Referer is an App's origin — or that sent none — may only go to that same origin. Frames the gugu page opens itself
 * (an App's first load, a chat widget) carry the page's Referer and are left alone; a widget's own navigation carries
 * the widget's. An App has no use for leaving its origin: it cannot frame anything (frame-src 'none'), and links go
 * out through gugu.openBrowserTab.
 *
 * Refused is answered here, never sent on: `204 No Content`, so the navigation does not happen and the frame keeps the
 * App's page, as the desktop keeps it. (Why is said to the author on the desktop, where Apps are written and checked.)
 */
public class AppOriginsClient extends BridgeWebViewClient {
    private static final String TAG = "GuguAppOrigins";

    public AppOriginsClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        String host = url.getHost();
        if (!request.isForMainFrame() && isDocument(request)) {
            String referer = header(request.getRequestHeaders(), "Referer");
            String from = referer == null ? null : Uri.parse(referer).getHost();
            boolean fromApp = referer == null || AppOrigins.appOf(from) != null;
            if (fromApp && (host == null || !host.equalsIgnoreCase(from))) {
                Log.w(TAG, "refused a frame leaving an App's origin: " + (from == null ? "(no referrer)" : from) + " -> " + url.getScheme() + "://" + host);
                return AppOrigins.empty(204, Collections.emptyMap());
            }
        }
        String appId = AppOrigins.appOf(host);
        if (appId != null && "https".equals(url.getScheme())) return AppOrigins.serve(view.getContext(), appId, url.getPath());
        return super.shouldInterceptRequest(view, request);
    }

    /** A frame's document (a navigation), as the WebView asks for one: the navigation Accept header. */
    private static boolean isDocument(WebResourceRequest request) {
        String accept = header(request.getRequestHeaders(), "Accept");
        return accept != null && accept.startsWith("text/html");
    }

    private static String header(Map<String, String> headers, String name) {
        if (headers == null) return null;
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (entry.getKey() != null && entry.getKey().equalsIgnoreCase(name)) return entry.getValue();
        }
        return null;
    }
}
