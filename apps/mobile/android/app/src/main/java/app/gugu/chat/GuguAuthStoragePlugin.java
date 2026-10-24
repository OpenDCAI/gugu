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
            if (!"sb-main".equals(call.getString("key"))) { call.reject("Unsupported storage key"); return; }
            var storage = getContext().getSharedPreferences("gugu-auth-storage", android.content.Context.MODE_PRIVATE);
            JSObject result = new JSObject();
            synchronized (STORAGE_LOCK) { result.put("value", storage.contains("sb-main") ? storage.getString("sb-main", null) : JSObject.NULL); }
            call.resolve(result);
        } catch (RuntimeException error) { call.reject("Auth storage read failed", error); }
    }

    @PluginMethod
    public void write(PluginCall call) {
        try {
            if (!"sb-main".equals(call.getString("key"))) { call.reject("Unsupported storage key"); return; }
            String value = call.getString("value");
            if (value == null) { call.reject("Missing storage value"); return; }
            var storage = getContext().getSharedPreferences("gugu-auth-storage", android.content.Context.MODE_PRIVATE);
            synchronized (STORAGE_LOCK) { if (!storage.edit().putString("sb-main", value).commit()) { call.reject("Auth storage commit failed"); return; } }
            call.resolve();
        } catch (RuntimeException error) { call.reject("Auth storage write failed", error); }
    }
}
