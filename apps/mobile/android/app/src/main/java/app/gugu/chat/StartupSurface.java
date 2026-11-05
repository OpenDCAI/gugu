package app.gugu.chat;

import android.app.AlertDialog;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.ContextThemeWrapper;
import android.webkit.WebView;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.splashscreen.SplashScreenViewProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** The system surface is plain color; Web owns the single brand animation. UI-thread only. */
final class StartupSurface {
    private final MainActivity activity;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final StartupDeadline deadline = new StartupDeadline(20_000);
    private final StartupHandoffState state = new StartupHandoffState();
    private final Runnable timeout = this::checkDeadline;
    private final List<PluginCall> frames = new ArrayList<>();
    private final String attemptId = UUID.randomUUID().toString();
    private final boolean enabled;
    private final boolean launchDark;
    private SplashScreenViewProvider splash;
    private Runnable cancelDraw = () -> {};
    private AlertDialog error;
    private String queuedPreference;
    private String queuedTone;

    StartupSurface(MainActivity activity, boolean enabled) {
        this.activity = activity;
        this.enabled = enabled;
        launchDark = StartupTheme.launchDark(activity);
        if (enabled) SplashScreen.installSplashScreen(activity).setOnExitAnimationListener(provider -> {
            splash = provider;
            StartupTrace.mark("system_splash_exit_requested");
            if (!state.active()) removeSplash();
            else completeHandoff();
        });
    }

    boolean enabled() { return enabled; }
    boolean launchDark() { return launchDark; }

    JSObject context() {
        return new JSObject().put("enabled", enabled).put("attemptId", attemptId)
                .put("tone", launchDark ? "dark" : "light");
    }

    private boolean accepts(String id, PluginCall call) {
        if (!attemptId.equals(id) || !state.active()) {
            call.reject("startup attempt is no longer active");
            return false;
        }
        return true;
    }

    void resume() {
        if (!enabled || !state.needsDeadline()) return;
        StartupTrace.mark("startup_resumed");
        handler.removeCallbacks(timeout);
        handler.postDelayed(timeout, deadline.resume(SystemClock.uptimeMillis()));
    }

    void pause() {
        deadline.pause(SystemClock.uptimeMillis());
        handler.removeCallbacks(timeout);
    }

    private void checkDeadline() {
        if (!enabled || !state.needsDeadline() || !deadline.resumed()) return;
        long remaining = deadline.remaining(SystemClock.uptimeMillis());
        if (remaining > 0) handler.postDelayed(timeout, remaining);
        else fail("web_startup_timeout");
    }

    void frame(String id, WebView view, PluginCall call) {
        frame(id, view, call, false);
    }

    private void frame(String id, WebView view, PluginCall call, boolean content) {
        if (!accepts(id, call)) return;
        if (!enabled || state.hasRevealed()) { call.resolve(); return; }
        frames.add(call);
        if (!(content ? state.requestContentFrame() : state.requestFrame())) return;
        // Content can supersede a held-brand snapshot. An older visual callback only guarantees
        // the older DOM; it cannot acknowledge the subsequently committed content.
        cancelDraw.run();
        long generation = state.frameGeneration();
        cancelDraw = StartupDraw.afterVisualFrame(view, () -> {
            if (!state.frameDrawn(generation)) return;
            completeHandoff();
        });
    }

    /** Resolve only after BOTH a drawable Web frame and the real system provider's removal. */
    private void completeHandoff() {
        if (!state.hasDrawn() || splash == null || !state.reveal()) return;
        if (!state.freezesTone()) applyQueuedTone();
        removeSplash();
        if (!state.needsDeadline()) handler.removeCallbacks(timeout);
        for (PluginCall call : frames) call.resolve();
        frames.clear();
    }

    void reactCommit(String id, PluginCall call) {
        if (!accepts(id, call)) return;
        state.reactCommit();
        StartupTrace.mark("react_commit_received");
        if (!state.needsDeadline()) handler.removeCallbacks(timeout);
        call.resolve();
    }

    void contentReady(String id, WebView view, PluginCall call) {
        if (!accepts(id, call)) return;
        state.contentReady();
        StartupTrace.mark("content_commit_received");
        if (!enabled || state.hasRevealed()) applyQueuedTone();
        frame(id, view, call, true);
    }

    void syncTone(String preference, String tone) {
        queuedPreference = preference;
        queuedTone = tone;
        if (!enabled || !state.freezesTone()) applyQueuedTone();
    }

    private void applyQueuedTone() {
        if (queuedTone == null) return;
        if (!enabled) {
            MobileShellChrome.applyTo(activity.getWindow(), "dark".equals(queuedTone));
            return;
        }
        // The system starting window already exists. First install/upgrade can change once at
        // real content; recoloring the native surface and then the brand would add another flash.
        if (queuedPreference != null) StartupTheme.applyApplicationMode(activity, queuedPreference);
        MobileShellChrome.applyTo(activity.getWindow(), "dark".equals(queuedTone));
        if (activity.getBridge() != null && activity.getBridge().getWebView() != null)
            activity.getBridge().getWebView().setBackgroundColor(StartupTheme.color("dark".equals(queuedTone)));
    }

    boolean ownsStartup() { return enabled && state.isStarting(); }

    void fail(String id, String reason, PluginCall call) {
        if (!accepts(id, call)) return;
        fail(reason);
        call.resolve();
    }

    void fail(String reason) {
        if (!enabled || !state.fail() || activity.isFinishing() || activity.isDestroyed()) return;
        handler.removeCallbacks(timeout);
        cancelDraw.run();
        rejectFrames("startup failed");
        StartupTrace.mark(reason);
        int theme = launchDark ? android.R.style.Theme_Material_Dialog_Alert
                : android.R.style.Theme_Material_Light_Dialog_Alert;
        error = new AlertDialog.Builder(new ContextThemeWrapper(activity, theme))
                .setTitle(R.string.startup_error_title)
                .setMessage(R.string.startup_error_body)
                .setPositiveButton(R.string.startup_retry, (dialog, which) -> activity.recreate())
                .setNeutralButton(R.string.startup_compat, null)
                .setNegativeButton(R.string.startup_close, (dialog, which) -> activity.finish())
                .setCancelable(false).create();
        error.setOnShowListener(dialog -> error.getButton(AlertDialog.BUTTON_NEUTRAL)
                .setOnClickListener(button -> activity.setStartupPolicy(false)));
        error.show();
        removeSplash();
    }

    private void removeSplash() {
        if (splash == null) return;
        splash.remove();
        splash = null;
        StartupTrace.mark("system_splash_removed");
    }

    private void rejectFrames(String reason) {
        for (PluginCall call : frames) call.reject(reason);
        frames.clear();
    }

    void destroy() {
        state.destroy();
        handler.removeCallbacks(timeout);
        cancelDraw.run();
        rejectFrames("startup activity was destroyed");
        if (error != null) error.dismiss();
        removeSplash();
    }
}
