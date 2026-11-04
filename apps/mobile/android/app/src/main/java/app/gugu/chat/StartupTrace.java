package app.gugu.chat;

import android.os.SystemClock;
import android.util.Log;

/** Optional diagnostics, never a readiness dependency. */
final class StartupTrace {
    private StartupTrace() {}
    static double now() { return SystemClock.elapsedRealtimeNanos() / 1_000_000.0; }
    static void mark(String stage) {
        if (BuildConfig.DEBUG) Log.d("GuguStartup", stage + " elapsedMs=" + now());
    }
}
