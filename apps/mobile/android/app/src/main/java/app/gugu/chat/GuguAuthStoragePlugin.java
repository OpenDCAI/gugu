package app.gugu.chat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "GuguAuthStorage")
public class GuguAuthStoragePlugin extends Plugin {
    static final Object STORAGE_LOCK = new Object();
    @PluginMethod
    public void get(PluginCall call) {
        try {
            String key = call.getString("key");
            if (!AuthStorageKeys.isAllowed(key)) { call.reject("Unsupported storage key"); return; }
            var storage = getContext().getSharedPreferences("gugu-auth-storage", android.content.Context.MODE_PRIVATE);
            JSObject result = new JSObject();
            synchronized (STORAGE_LOCK) { result.put("value", storage.contains(key) ? storage.getString(key, null) : JSObject.NULL); }
            call.resolve(result);
        } catch (RuntimeException error) { call.reject("Auth storage read failed", error); }
    }

    @PluginMethod
    public void write(PluginCall call) {
        try {
            String key = call.getString("key");
            if (!AuthStorageKeys.isAllowed(key)) { call.reject("Unsupported storage key"); return; }
            String value = call.getString("value");
            if (value == null) { call.reject("Missing storage value"); return; }
            var storage = getContext().getSharedPreferences("gugu-auth-storage", android.content.Context.MODE_PRIVATE);
            synchronized (STORAGE_LOCK) { if (!storage.edit().putString(key, value).commit()) { call.reject("Auth storage commit failed"); return; } }
            call.resolve();
        } catch (RuntimeException error) { call.reject("Auth storage write failed", error); }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            String key = call.getString("key");
            // Session retirement remains an explicit envelope write owned by the coordinator.
            if (!AuthStorageKeys.isTemporary(key)) { call.reject("Unsupported temporary storage key"); return; }
            var storage = getContext().getSharedPreferences("gugu-auth-storage", android.content.Context.MODE_PRIVATE);
            synchronized (STORAGE_LOCK) { if (!storage.edit().remove(key).commit()) { call.reject("Auth storage removal failed"); return; } }
            call.resolve();
        } catch (RuntimeException error) { call.reject("Auth storage removal failed", error); }
    }
}
