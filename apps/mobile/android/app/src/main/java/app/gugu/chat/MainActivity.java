package app.gugu.chat;

import android.content.Intent;
import android.os.Bundle;
import android.os.Build;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.app.AlertDialog;
import java.util.concurrent.CompletableFuture;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String NATIVE_BACK_EVENT = "gugu:native-back";
    private StartupSurface startup;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        StartupTrace.mark("activity_create");
        startup = new StartupSurface(this, StartupShortcuts.requestedMode(this,
                StartupPolicy.enabled(new StartupPreferences(this), Build.VERSION.SDK_INT)));
        StartupShortcuts.publish(this, startup.enabled());
        // @@@share-with-apps 进程被杀后恢复、或从「最近任务」重开时,系统把当初拉起咕咕的那个分享 Intent
        // 原样再交一次 —— 那次分享早已处理过(或放弃了),再弹一次「发送到」就是重放(模拟器实测)。
        if ((savedInstanceState != null || (getIntent().getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0)
                && GuguSharePlugin.isIncoming(getIntent())) {
            setIntent(new Intent(Intent.ACTION_MAIN));
        }
        registerPlugin(GuguAuthStoragePlugin.class);
        registerPlugin(GuguPreviewOrigins.class);
        registerPlugin(GuguAppUpdatePlugin.class);
        registerPlugin(GuguSharePlugin.class);
        registerPlugin(GuguAppStorePlugin.class);
        registerPlugin(GuguPhoneActionsPlugin.class);
        registerPlugin(GuguAgentPlugin.class);
        registerPlugin(GuguPhoneDataPlugin.class);
        registerPlugin(GuguAudioPermissionsPlugin.class);
        registerPlugin(MobileShellChrome.class);
        super.onCreate(savedInstanceState);
        StartupTrace.mark("bridge_created");
        if (getBridge() == null || getBridge().getWebView() == null) {
            startup.fail("webview_unavailable");
            return;
        }
        if (startup.enabled()) {
            getBridge().getWebView().setBackgroundColor(StartupTheme.color(startup.launchDark()));
            StartupDraw.afterDraw(getBridge().getWebView(), () -> StartupTrace.mark("first_webview_draw"));
        }
        if (BuildConfig.GUGU_ALLOW_LOCAL_HTTP) {
            getBridge().getWebView().getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        // Each App runs in an origin of its own, served by this client, and cannot navigate its frame out of it (AppOriginsClient).
        getBridge().setWebViewClient(new AppOriginsClient(getBridge(), startup));
        // An App's frame is third-party to this page, so on the phone an App has no cookies (L9, 统筹 15:54): a cookie is
        // the one storage an App could scope to the domain every App origin shares (apps.gugu.invalid), where another App's
        // origin read it. An App keeps what it stores in localStorage / IndexedDB or gugu.writeData — its own origin's.
        // The desktop needs nothing here: each App is a partition of its own, cookies included.
        // Not the WebView's default being restated: Capacitor's cookie manager turns third-party cookies on in super.onCreate
        // above (CapacitorCordovaCookieManager), so this puts them back off, after it.
        CookieManager.getInstance().setAcceptThirdPartyCookies(getBridge().getWebView(), false);
        MobileShellChrome.applyTo(getWindow(), startup.enabled() && startup.launchDark());
        // @@@native-back-bridge - Android owns the hardware back button; the web shell answers
        // "handled" for every in-app navigation layer. Only an unhandled root-level back exits.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                dispatchBackToWeb();
            }
        });
    }

    StartupSurface startup() { return startup; }

    /** Shortcut retries are durable before recreation; no disk write blocks the UI draw. */
    void setStartupPolicy(boolean enabled) {
        if (!StartupPolicy.supportsPlatform(Build.VERSION.SDK_INT)) return;
        CompletableFuture.supplyAsync(() -> StartupPolicy.setEnabled(new StartupPreferences(this), enabled))
                .thenAccept(saved -> runOnUiThread(() -> {
                    if (isDestroyed() || isFinishing()) return;
                    if (saved) {
                        setIntent(new Intent(Intent.ACTION_MAIN));
                        recreate();
                    } else new AlertDialog.Builder(this).setTitle(R.string.startup_error_title)
                            .setMessage(R.string.startup_policy_failed).setPositiveButton(android.R.string.ok, null).show();
                }));
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Boolean mode = StartupShortcuts.mode(this, intent);
        if (mode != null) setStartupPolicy(mode);
    }

    @Override
    public void onResume() {
        super.onResume();
        if (startup != null) startup.resume();
    }

    @Override
    public void onPause() {
        if (startup != null) startup.pause();
        super.onPause();
    }

    @Override
    public void onDestroy() {
        if (startup != null) startup.destroy();
        super.onDestroy();
    }

    private void dispatchBackToWeb() {
        if (getBridge() == null) {
            finish();
            return;
        }

        getBridge().eval("window.__guguNativeBackHandled=false;window.dispatchEvent(new CustomEvent('" + NATIVE_BACK_EVENT + "'));window.__guguNativeBackHandled===true", handled -> {
            if ("true".equals(handled)) return;
            runOnUiThread(this::finish);
        });
    }
}
