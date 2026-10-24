package app.gugu.chat;

import android.content.Intent;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.ref.WeakReference;
import java.util.UUID;

@CapacitorPlugin(name = "GuguAgent")
public class GuguAgentPlugin extends Plugin {
    private static WeakReference<GuguAgentPlugin> active = new WeakReference<>(null);
    private volatile boolean foreground;
    @Override public void load() { active = new WeakReference<>(this); foreground = getActivity() != null && getActivity().hasWindowFocus(); }
    @Override protected void handleOnResume() { foreground = true; }
    @Override protected void handleOnPause() { foreground = false; }
    @Override protected void handleOnDestroy() { foreground = false; if (active.get() == this) active.clear(); }
    static androidx.appcompat.app.AppCompatActivity foregroundActivity() {
        GuguAgentPlugin plugin = active.get();
        if (plugin == null || !plugin.foreground) return null;
        var activity = plugin.getActivity();
        return activity == null || activity.isFinishing() || activity.isDestroyed() ? null : activity;
    }
    static boolean publishWebAction(JSObject request) {
        GuguAgentPlugin plugin = active.get();
        if (plugin == null || !plugin.hasListeners("webAction")) return false;
        plugin.notifyListeners("webAction", request);
        return true;
    }
    private String owner(PluginCall call) { return UUID.fromString(call.getString("ownerId", "")).toString(); }
    @PluginMethod public void configure(PluginCall call) {
        try {
            if (android.os.Build.VERSION.SDK_INT < 26) throw new IllegalStateException("手机 Agent 宿主需要 Android 8 或更新版本");
            JSObject config = GuguAgentHostStore.configure(getContext(), call.getData());
            String owner = config.getString("ownerId");
            var settings = GuguAgentService.permissions(getContext());
            String previousOwner = settings.getString("owner", "");
            if (!previousOwner.isEmpty() && !previousOwner.equals(owner)) GuguAgentHostService.stopOwner(getContext(), previousOwner, true);
            var grants = config.optJSONObject("grants");
            if (!owner.equals(settings.getString("owner", "")) || !settings.getBoolean("fullGrantsMirror", false)) {
                var editor = settings.edit().clear().putString("owner", owner);
                if (grants != null) for (String key : new String[] {"calendar", "contacts", "location", "notifications", "alarm", "health", "sms", "recordings", "photos"}) editor.putBoolean(key, grants.optBoolean(key, false));
                if (!editor.commit()) throw new IllegalStateException("无法保存手机能力授权");
            }
            GuguNotificationListener.setCollecting(settings.getBoolean("notifications", false));
            GuguAgentHostService.reserveOwner(owner);
            try { ContextCompat.startForegroundService(getContext(), new Intent(getContext(), GuguAgentHostService.class).putExtra("ownerId", owner)); }
            catch (Exception error) { GuguAgentHostService.releaseReservation(owner); throw error; }
            call.resolve(GuguAgentHostService.readState(getContext(), owner));
        } catch (Exception error) { call.reject(GuguAgentHostPolicy.publicMessage(error.getMessage(), call.getString("accessToken"), call.getString("refreshToken"), call.getString("supabaseAnonKey")), "failed"); }
    }
    @PluginMethod public void hostState(PluginCall call) {
        try { call.resolve(GuguAgentHostService.readState(getContext(), owner(call))); }
        catch (Exception error) { call.reject(error.getMessage(), "failed"); }
    }
    @PluginMethod public void stopHost(PluginCall call) {
        try {
            GuguAgentHostService.stopOwnerAndWait(getContext(), owner(call), !Boolean.FALSE.equals(call.getBoolean("clearCredentials", true))).whenComplete((ignored, error) -> {
                if (error == null) call.resolve();
                else call.reject("手机运行时尚未完全退出", "failed");
            });
        } catch (Exception error) { call.reject("无法停止手机宿主", "failed"); }
    }
    @PluginMethod public void authSession(PluginCall call) {
        try {
            String suppliedOwner = call.getString("ownerId");
            String owner = suppliedOwner == null ? null : GuguAgentHostPolicy.owner(suppliedOwner);
            String action = call.getString("action", "get");
            if (!"get".equals(action) && !"refresh".equals(action) && !"sign_out".equals(action)) throw new IllegalArgumentException("不支持的登录会话操作");
            GuguAgentHostService.requestAuth(owner, call.getString("refreshToken"), action).whenComplete((result, error) -> {
                if (error == null) call.resolve(result);
                else {
                    Throwable cause = error;
                    while ((cause instanceof java.util.concurrent.CompletionException || cause instanceof java.util.concurrent.ExecutionException) && cause.getCause() != null) cause = cause.getCause();
                    call.reject("手机宿主登录会话操作失败: " + cause.getMessage(), cause instanceof GuguAgentHostAuthException ? ((GuguAgentHostAuthException) cause).code : "failed");
                }
            });
        } catch (Exception error) { call.reject(error.getMessage(), "failed"); }
    }
    @PluginMethod public void webActionResult(PluginCall call) {
        try {
            var result = call.getData().optJSONObject("result");
            if (result == null) throw new IllegalArgumentException("缺少手机动作结果");
            GuguAgentHostService.webActionResult(owner(call), call.getString("id", ""), result);
            call.resolve();
        } catch (Exception error) { call.reject(error.getMessage(), "failed"); }
    }
    @PluginMethod public void cancelSession(PluginCall call) {
        try {
            String sessionId = GuguAgentHostPolicy.owner(call.getString("sessionId", ""));
            GuguAgentHostService.cancelSession(owner(call), sessionId);
            call.resolve(new JSObject().put("accepted", true));
        } catch (Exception error) { call.reject(error.getMessage(), "failed"); }
    }
    @PluginMethod public void hostCall(PluginCall call) {
        try {
            String id = GuguAgentHostPolicy.owner(call.getString("id", ""));
            String channel = call.getString("channel", "");
            if (!channel.matches("[A-Za-z][A-Za-z0-9_.]{0,119}")) throw new IllegalArgumentException("手机宿主操作名称无效");
            var args = call.getData().optJSONArray("args");
            if (args == null) throw new IllegalArgumentException("手机宿主操作缺少参数");
            GuguAgentHostService.hostCall(owner(call), id, channel, args).whenComplete((result, error) -> {
                if (error == null) call.resolve(result);
                else call.reject(error.getMessage(), "failed");
            });
        } catch (Exception error) { call.reject(error.getMessage(), "failed"); }
    }
    @PluginMethod public void run(PluginCall call) {
        try {
            if (android.os.Build.VERSION.SDK_INT < 26) throw new IllegalStateException("手机 Agent 需要 Android 8 或更新版本");
            owner(call);
            UUID.fromString(call.getString("sessionId", ""));
            if (call.getString("prompt", "").trim().isEmpty()) throw new IllegalArgumentException("请先输入任务");
            if (!call.getString("baseUrl", "").startsWith("https://")) throw new IllegalArgumentException("模型连接必须使用 HTTPS");
            if (call.getString("apiKey", "").isEmpty() || call.getString("model", "").isEmpty()) throw new IllegalArgumentException("缺少模型凭据");
            if (!GuguAgentService.claim()) throw new IllegalStateException("手机上还有一条正在运行的任务");
            try {
                ContextCompat.startForegroundService(getContext(), new Intent(getContext(), GuguAgentService.class).putExtra("command", call.getData().toString()));
            } catch (Exception error) { GuguAgentService.release(); throw error; }
            call.resolve(new JSObject().put("accepted", true));
        } catch (Exception error) { call.reject(error.getMessage(), "failed"); }
    }
    @PluginMethod public void state(PluginCall call) {
        try { call.resolve(GuguAgentService.readState(getContext(), owner(call))); }
        catch (Exception error) { call.reject(error.getMessage(), "failed"); }
    }
    @PluginMethod public void grants(PluginCall call) {
        try {
            String owner = owner(call);
            var grants = GuguAgentService.permissions(getContext());
            var editor = grants.edit();
            if (!owner.equals(grants.getString("owner", ""))) editor.clear();
            editor.putString("owner", owner);
            var groups = call.getData().optJSONObject("groups");
            if (groups != null) {
                for (String key : new String[] {"calendar", "contacts", "location", "notifications", "alarm", "health", "sms", "recordings", "photos"}) editor.putBoolean(key, groups.optBoolean(key, false));
                editor.putBoolean("fullGrantsMirror", true);
            } else editor.putBoolean("calendar", Boolean.TRUE.equals(call.getBoolean("calendar", false)));
            if (!editor.commit()) throw new IllegalStateException("无法保存手机能力授权");
            if (groups != null) GuguNotificationListener.setCollecting(groups.optBoolean("notifications", false));
            call.resolve();
        } catch (Exception error) { call.reject(error.getMessage(), "failed"); }
    }
    @PluginMethod public void cancel(PluginCall call) {
        try {
            if (!GuguAgentService.isRunning()) { call.resolve(); return; }
            if (!owner(call).equals(GuguAgentService.permissions(getContext()).getString("owner", ""))) throw new SecurityException("会话不属于当前账号");
            getContext().startService(new Intent(getContext(), GuguAgentService.class).setAction("cancel"));
            call.resolve();
        } catch (Exception error) { call.reject(error.getMessage(), "failed"); }
    }
    @PluginMethod public void clear(PluginCall call) {
        try { GuguAgentService.clearState(getContext(), owner(call)); call.resolve(); }
        catch (Exception error) { call.reject(error.getMessage(), "failed"); }
    }
}
