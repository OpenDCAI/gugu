package app.gugu.chat;

import android.content.Context;
import android.os.Build;
import java.io.File;
import java.io.IOException;
import org.json.JSONObject;

/** Native host configuration is authoritative when adopting a pre-origin-independent registration. */
final class GuguPhoneRegistration {
    static String resolve(Context context, PhoneInstallationIdentity.Identity installation, String suppliedOwner, String cachedId, String cachedBinding) throws Exception {
        String owner = GuguAgentHostPolicy.owner(suppliedOwner);
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            String raw = context.getSharedPreferences("gugu-auth-storage", Context.MODE_PRIVATE).getString("sb-main", null);
            if (raw == null) throw new IOException("手机登录尚未保存，无法迁移设备登记");
            JSONObject envelope = new JSONObject(raw);
            if (!"SESSION".equals(envelope.optString("state")) || !owner.equals(new JSONObject(envelope.getString("raw")).getJSONObject("user").optString("id")))
                throw new IOException("设备登记与当前登录账号不一致");
        }
        // Host configure holds its own lock before taking STORAGE_LOCK; never invert that order here.
        return PhoneRegistrationIdentity.open(context.getNoBackupFilesDir(), installation.key, () -> {
            JSONObject config = Build.VERSION.SDK_INT >= 26 ? GuguAgentHostStore.read(context, owner) : null;
            if (config != null) {
                JSONObject info = config.getJSONObject("deviceInfo");
                return PhoneRegistrationIdentity.adoptHost(owner, context.getPackageName(), installation.key, installation.previousKey,
                    new PhoneRegistrationIdentity.LegacyHost(config.optString("ownerId"), info.optString("package"), info.optString("install_key"), config.getString("installId"), config.getString("deviceId")));
            }
            if (cachedId != null && (installation.key.equals(cachedBinding)
                || (installation.previousKey != null && installation.previousKey.equals(cachedBinding)))) return cachedId;
            // An existing encrypted host must not be ignored merely because another account is now signed in.
            File hosts = new File(context.getNoBackupFilesDir(), "phone-agent-host");
            if (hosts.exists()) {
                File[] owners = hosts.listFiles();
                if (owners == null) throw new IOException("无法读取原有手机登记");
                for (File other : owners) if (new File(other, "config.enc").exists()) throw new IOException("请先在原有手机账号下完成设备登记迁移");
            }
            return null;
        }, (temporary, target) -> {
            try { android.system.Os.rename(temporary.getPath(), target.getPath()); }
            catch (android.system.ErrnoException error) { throw new IOException("Cannot commit registration identity", error); }
        });
    }
}
