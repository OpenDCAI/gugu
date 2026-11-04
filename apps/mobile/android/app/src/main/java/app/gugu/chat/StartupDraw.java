package app.gugu.chat;

import android.os.Handler;
import android.os.Looper;
import android.view.ViewTreeObserver;
import android.webkit.WebView;

/** Drawable-state callbacks control handoff; optional timing logs do not. */
final class StartupDraw {
    private StartupDraw() {}

    static Runnable afterVisualFrame(WebView view, Runnable ready) {
        boolean[] cancelled = {false};
        Runnable[] cancelDraw = {() -> {}};
        view.postVisualStateCallback(0, new WebView.VisualStateCallback() {
            @Override
            public void onComplete(long requestId) {
                if (cancelled[0]) return;
                StartupTrace.mark("web_visual_ready");
                cancelDraw[0] = afterDraw(view, () -> {
                    if (cancelled[0]) return;
                    StartupTrace.mark("web_draw_after_visual_ready");
                    ready.run();
                });
            }
        });
        return () -> { cancelled[0] = true; cancelDraw[0].run(); };
    }

    static Runnable afterDraw(WebView view, Runnable ready) {
        Handler handler = new Handler(Looper.getMainLooper());
        ViewTreeObserver observer = view.getViewTreeObserver();
        boolean[] cancelled = {false};
        ViewTreeObserver.OnDrawListener listener = new ViewTreeObserver.OnDrawListener() {
            private boolean scheduled;

            @Override
            public void onDraw() {
                if (scheduled || cancelled[0]) return;
                scheduled = true;
                // A Handler still runs if the View detaches after drawing. Do not mutate this observer in onDraw.
                handler.post(() -> {
                    if (observer.isAlive()) observer.removeOnDrawListener(this);
                    if (!cancelled[0]) ready.run();
                });
            }
        };
        observer.addOnDrawListener(listener);
        view.invalidate();
        return () -> {
            cancelled[0] = true;
            if (observer.isAlive()) observer.removeOnDrawListener(listener);
        };
    }
}
