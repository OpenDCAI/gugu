package app.gugu.chat;

import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.Window;

import androidx.core.content.ContextCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * @@@mobile-shell-chrome - The system bars (status, navigation) are the shell's; they follow the tone the page is in.
 * Edge-to-edge leaves them transparent over the window's background, so the tone is that background plus the icons'
 * light/dark. The page's theme is the one truth (`<html data-theme>`, host-theme.ts) and the shell cannot ask it: the
 * page tells it on every change (`syncTone`), as it tells the desktop's main process its window tone (@@@window-tone).
 * The native startup mirror remembers the last preference until the page tells it again.
 * With no OS mirror (first install/upgrade), the launch freezes the actual system tone until real content.
 */
@CapacitorPlugin(name = "GuguShellChrome")
public class MobileShellChrome extends Plugin {
    @PluginMethod
    public void startupClock(PluginCall call) {
        call.resolve(new JSObject().put("elapsedMs", StartupTrace.now()));
    }

    @PluginMethod
    public void startupContext(PluginCall call) {
        getActivity().runOnUiThread(() -> call.resolve(((MainActivity) getActivity()).startup().context()));
    }

    @PluginMethod
    public void startupFrame(PluginCall call) {
        String kind = call.getString("kind");
        if (!"motion".equals(kind) && !"content".equals(kind)) { call.reject("invalid startup frame kind"); return; }
        getActivity().runOnUiThread(() -> {
            StartupSurface startup = ((MainActivity) getActivity()).startup();
            if ("content".equals(kind)) startup.contentReady(call.getString("attemptId"), getBridge().getWebView(), call);
            else startup.frame(call.getString("attemptId"), getBridge().getWebView(), call);
        });
    }

    @PluginMethod
    public void startupReactCommit(PluginCall call) {
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).startup()
                .reactCommit(call.getString("attemptId"), call));
    }

    @PluginMethod
    public void startupContentReady(PluginCall call) {
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).startup()
                .contentReady(call.getString("attemptId"), getBridge().getWebView(), call));
    }

    @PluginMethod
    public void startupTiming(PluginCall call) {
        if (BuildConfig.DEBUG) android.util.Log.d("GuguStartup", "web_timing elapsedMs=" + StartupTrace.now()
                + " web=" + call.getObject("timing", new JSObject()));
        call.resolve();
    }

    @PluginMethod
    public void startupFailed(PluginCall call) {
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).startup()
                .fail(call.getString("attemptId"), "web_module_or_brand_failed", call));
    }

    private View keyboardRoot;
    private ViewTreeObserver keyboardObserver;
    private Boolean keyboardVisible;
    private boolean destroyed;
    private final ViewTreeObserver.OnGlobalLayoutListener keyboardLayout = () -> publishKeyboard(false);
    // A floating IME can change visibility without resizing the layout.
    private final ViewTreeObserver.OnPreDrawListener keyboardDraw = () -> { publishKeyboard(false); return true; };

    @Override
    public void load() {
        getActivity().runOnUiThread(this::observeKeyboard);
    }

    @Override
    protected void handleOnResume() {
        getActivity().runOnUiThread(this::observeKeyboard);
    }

    private void observeKeyboard() {
        if (destroyed) return;
        keyboardRoot = getActivity().getWindow().getDecorView();
        ViewTreeObserver observer = keyboardRoot.getViewTreeObserver();
        if (observer != keyboardObserver) {
            removeKeyboardObservers();
            keyboardObserver = observer;
            observer.addOnGlobalLayoutListener(keyboardLayout);
            observer.addOnPreDrawListener(keyboardDraw);
        }
        // Resume republishes even an unchanged value; the page discards signals while hidden.
        keyboardRoot.post(() -> publishKeyboard(true));
    }

    private void publishKeyboard(boolean force) {
        if (destroyed || keyboardRoot == null || getBridge() == null) return;
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(keyboardRoot);
        if (insets == null) return;
        boolean visible = insets.isVisible(WindowInsetsCompat.Type.ime());
        if (!force && keyboardVisible != null && keyboardVisible == visible) return;
        keyboardVisible = visible;
        getBridge().triggerWindowJSEvent("gugu:phone-keyboard", new JSObject().put("visible", visible).toString());
    }

    private void removeKeyboardObservers() {
        if (keyboardObserver != null && keyboardObserver.isAlive()) {
            keyboardObserver.removeOnGlobalLayoutListener(keyboardLayout);
            keyboardObserver.removeOnPreDrawListener(keyboardDraw);
        }
        keyboardObserver = null;
    }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        removeKeyboardObservers();
        keyboardRoot = null;
        keyboardVisible = null;
    }

    static void applyTo(Window window, boolean dark) {
        int color = ContextCompat.getColor(window.getContext(),
                dark ? R.color.gugu_mobile_shell_bar_dark : R.color.gugu_mobile_shell_bar_light);
        window.setBackgroundDrawable(new ColorDrawable(color));
        // Android 14 and earlier still draw opaque bars; their default scrim does not follow the page.
        if (Build.VERSION.SDK_INT < 35) {
            window.setStatusBarColor(color);
            window.setNavigationBarColor(color);
        }
        if (Build.VERSION.SDK_INT >= 29) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(!dark);
        controller.setAppearanceLightNavigationBars(!dark);
    }

    @PluginMethod
    public void syncTone(PluginCall call) {
        String tone = call.getString("tone");
        if (!"light".equals(tone) && !"dark".equals(tone)) { call.reject("tone must be light or dark"); return; }
        String preference = call.getString("preference");
        // Old Web bundles sent tone only. Keep the entry compatible without inventing a preference.
        if (preference != null && !StartupTheme.validPreference(preference)) { call.reject("preference must be light, dark or system"); return; }
        boolean saved = preference == null || StartupTheme.persist(getContext(), preference, tone);
        getActivity().runOnUiThread(() -> {
            if (destroyed) { call.reject("startup activity was destroyed"); return; }
            ((MainActivity) getActivity()).startup().syncTone(preference, tone);
            if (saved) call.resolve();
            else call.reject("startup theme could not be saved");
        });
    }
}
