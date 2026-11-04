package app.gugu.chat;

import android.app.UiModeManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;

/** A startup mirror of the Web preference, never a second theme authority. */
final class StartupTheme {
    private static final String STORE = "gugu-shell-startup";
    private StartupTheme() {}

    static boolean validPreference(String preference) {
        return "light".equals(preference) || "dark".equals(preference) || "system".equals(preference);
    }

    /** The system starting window already exists. Freeze its actual configuration, not an un-applied mirror. */
    static boolean launchDark(Context context) {
        return (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    static int color(boolean dark) {
        return dark ? Color.rgb(24, 24, 24) : Color.WHITE;
    }

    /** Called on the Capacitor plugin thread so durable storage never blocks a UI draw. */
    static boolean persist(Context context, String preference, String tone) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE);
            if (preference.equals(prefs.getString("preference", null)) && tone.equals(prefs.getString("tone", null))) return true;
            return prefs.edit().putString("preference", preference).putString("tone", tone).commit();
        } catch (RuntimeException failure) {
            return false;
        }
    }

    static void applyApplicationMode(Context context, String preference) {
        if (Build.VERSION.SDK_INT < 31) return;
        UiModeManager manager = context.getSystemService(UiModeManager.class);
        if (manager == null) return;
        // AUTO clears the package override on Android31+; it does not change the device mode.
        int mode = "dark".equals(preference) ? UiModeManager.MODE_NIGHT_YES
                : "light".equals(preference) ? UiModeManager.MODE_NIGHT_NO : UiModeManager.MODE_NIGHT_AUTO;
        try { manager.setApplicationNightMode(mode); }
        catch (RuntimeException failure) { StartupTrace.mark("startup_os_theme_mirror_failed"); }
    }
}
