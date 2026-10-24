package app.gugu.chat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.concurrent.CompletableFuture;

/** Adapts the existing native method contract to a future, without a WebView or Bridge. */
final class PhoneNativeCall extends PluginCall {
    final CompletableFuture<JSObject> result = new CompletableFuture<>();

    PhoneNativeCall(String plugin, String method, JSObject args) {
        super(null, plugin, "phone-host", method, args);
    }
    @Override public void resolve(JSObject value) { result.complete(value); }
    @Override public void resolve() { result.complete(new JSObject()); }
    @Override public void reject(String message, String code) { result.completeExceptionally(new Failure(code, message)); }
    @Override public void reject(String message) { reject(message, "failed"); }
    @Override public void reject(String message, String code, Exception error, JSObject data) { reject(message, code); }

    static final class Failure extends RuntimeException {
        final String code;
        Failure(String code, String message) { super(message); this.code = code == null ? "failed" : code; }
    }
}
