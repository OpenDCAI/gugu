package app.gugu.chat;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.os.Build;
import java.util.Collections;

/** The local recovery entry is registered before the Web bridge. No server flag or auth storage. */
final class StartupShortcuts {
    private StartupShortcuts() {}

    static Boolean mode(Context context, Intent intent) {
        if (!StartupPolicy.supportsPlatform(Build.VERSION.SDK_INT) || intent == null) return null;
        if ((context.getPackageName() + ".STARTUP_COMPAT").equals(intent.getAction())) return false;
        if ((context.getPackageName() + ".STARTUP_RESTORE").equals(intent.getAction())) return true;
        return null;
    }

    static boolean requestedMode(MainActivity activity, boolean stored) {
        Boolean requested = mode(activity, activity.getIntent());
        if (requested == null) return stored;
        // This launch can escape a bad surface immediately; durable persistence is confirmed below.
        activity.setIntent(new Intent(Intent.ACTION_MAIN));
        java.util.concurrent.CompletableFuture.runAsync(() -> {
            if (!StartupPolicy.setEnabled(new StartupPreferences(activity), requested)) {
                StartupTrace.mark("startup_policy_save_failed");
                activity.runOnUiThread(() -> {
                    if (!activity.isDestroyed() && !activity.isFinishing())
                        android.widget.Toast.makeText(activity, R.string.startup_policy_failed,
                                android.widget.Toast.LENGTH_LONG).show();
                });
            }
        });
        return requested;
    }

    static void publish(MainActivity activity, boolean enabled) {
        if (Build.VERSION.SDK_INT < 25) return;
        try {
            ShortcutManager manager = activity.getSystemService(ShortcutManager.class);
            if (manager == null) return;
            if (!StartupPolicy.supportsPlatform(Build.VERSION.SDK_INT)) {
                manager.removeDynamicShortcuts(Collections.singletonList("startup-mode"));
                return;
            }
            Intent intent = new Intent(activity, MainActivity.class)
                    .setAction(activity.getPackageName() + (enabled ? ".STARTUP_COMPAT" : ".STARTUP_RESTORE"));
            ShortcutInfo entry = new ShortcutInfo.Builder(activity, "startup-mode")
                    .setShortLabel(activity.getString(enabled ? R.string.startup_compat : R.string.startup_restore))
                    .setIntent(intent).build();
            // Do not replace unrelated application shortcuts.
            manager.addDynamicShortcuts(Collections.singletonList(entry));
        } catch (RuntimeException failure) {
            StartupTrace.mark("startup_shortcut_unavailable");
        }
    }
}
