package app.gugu.chat;

import android.net.Uri;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.RenderProcessGoneDetail;
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
 * 2026-09-30). Navigating the frame itself is not a CSP matter, so it is refused
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

    private final Bridge bridge;
    private final StartupSurface startup;

    public AppOriginsClient(Bridge bridge) {
        this(bridge, null);
    }

    AppOriginsClient(Bridge bridge, StartupSurface startup) {
        super(bridge);
        this.bridge = bridge;
        this.startup = startup;
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (startup != null && request.isForMainFrame()) startup.fail("main_document_failed");
        super.onReceivedError(view, request, error);
    }

    @Override
    public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
        if (startup != null && request.isForMainFrame()) startup.fail("main_document_http_failed");
        super.onReceivedHttpError(view, request, response);
    }

    @Override
    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        if (startup != null && startup.ownsStartup()) {
            startup.fail("startup_renderer_failed");
            if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
            view.destroy();
            return true;
        }
        return super.onRenderProcessGone(view, detail);
    }

    @Override
    public void onPageCommitVisible(WebView view, String url) {
        StartupTrace.mark("page_commit_visible");
        super.onPageCommitVisible(view, url);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        String host = url.getHost();
        if (!request.isForMainFrame() && isDocument(request)) {
            String referer = header(request.getRequestHeaders(), "Referer");
            // No Referer is null; one whose host cannot be read is "" (no App's, no gate's: left alone, as before).
            String refererHost = referer == null ? null : Uri.parse(referer).getHost();
            String from = referer == null ? null : refererHost == null ? "" : refererHost;
            if (!AppOrigins.frameMayGo(from, host)) {
                Log.w(TAG, "refused a frame leaving its origin: " + (from == null ? "(no referrer)" : from) + " -> " + url.getScheme() + "://" + host);
                return AppOrigins.empty(204, Collections.emptyMap());
            }
        }
        // A chat folder's HTML document and the files beside it (GuguPreviewOrigins): answered by the gugu page.
        String previewId = GuguPreviewOrigins.previewOf(host);
        if (previewId != null && "https".equals(url.getScheme())) return GuguPreviewOrigins.serve(bridge, previewId, request);
        String gateId = AppOrigins.gateOf(host);
        if (gateId != null && "https".equals(url.getScheme())) return AppOrigins.serveGate(view.getContext(), gateId, url.getPath(), pageOrigin());
        String appId = AppOrigins.appOf(host);
        if (appId != null && "https".equals(url.getScheme())) return AppOrigins.serve(view.getContext(), appId, url.getPath());
        return super.shouldInterceptRequest(view, request);
    }

    /** The gugu page's own origin (https://localhost, or the dev server's): the one page that frames a gate. */
    private String pageOrigin() {
        Uri app = Uri.parse(bridge.getAppUrl());
        return app.getScheme() + "://" + app.getEncodedAuthority();
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
