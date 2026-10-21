package app.gugu.chat;

import android.graphics.drawable.ColorDrawable;
import android.view.Window;

import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * @@@mobile-shell-chrome - The system bars (status, navigation) are the shell's; they follow the tone the page is in.
 * Edge-to-edge leaves them transparent over the window's background, so the tone is that background plus the icons'
 * light/dark. The page's theme is the one truth (`<html data-theme>`, host-theme.ts) and the shell cannot ask it: the
 * page tells it on every change (`syncTone`), as it tells the desktop's main process its window tone (@@@window-tone).
 * Until it does — the launch — the shell is the product's default, light. The colors are tokens.css `--bg`.
 */
@CapacitorPlugin(name = "GuguShellChrome")
public class MobileShellChrome extends Plugin {
    static void applyTo(Window window, boolean dark) {
        window.setBackgroundDrawable(new ColorDrawable(ContextCompat.getColor(window.getContext(),
                dark ? R.color.gugu_mobile_shell_bar_dark : R.color.gugu_mobile_shell_bar_light)));
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(!dark);
        controller.setAppearanceLightNavigationBars(!dark);
    }

    @PluginMethod
    public void syncTone(PluginCall call) {
        String tone = call.getString("tone");
        if (!"light".equals(tone) && !"dark".equals(tone)) { call.reject("tone must be light or dark"); return; }
        getActivity().runOnUiThread(() -> {
            applyTo(getActivity().getWindow(), "dark".equals(tone));
            call.resolve();
        });
    }
}
