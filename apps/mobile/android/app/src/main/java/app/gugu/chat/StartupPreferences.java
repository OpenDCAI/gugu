package app.gugu.chat;

import android.content.Context;
import android.content.SharedPreferences;

/** The policy is separate from both the theme mirror and authentication storage. */
final class StartupPreferences implements StartupPolicy.Store {
    private final SharedPreferences preferences;

    StartupPreferences(Context context) {
        preferences = context.getSharedPreferences("gugu-startup-policy", Context.MODE_PRIVATE);
    }

    @Override
    public String read() {
        return preferences.getString("mode", null);
    }

    /** Called on the plugin thread; the acknowledgement follows durable persistence. */
    @Override
    public boolean write(String mode) {
        return preferences.edit().putString("mode", mode).commit();
    }
}
