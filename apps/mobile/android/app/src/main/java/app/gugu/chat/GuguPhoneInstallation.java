package app.gugu.chat;

import android.content.Context;
import android.provider.Settings;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;

/** Android adapter for the production installation gate used by deviceInfo and native grant reads. */
final class GuguPhoneInstallation {
    private GuguPhoneInstallation() {}

    static PhoneInstallationIdentity.Identity identity(Context context) {
        try {
            return PhoneInstallationIdentity.open(context.getNoBackupFilesDir(), () -> legacyKey(context), () -> {
                GuguNotificationListener.setCollecting(false);
                if (!context.getSharedPreferences("phone-agent-grants", Context.MODE_PRIVATE).edit().clear().commit())
                    throw new IOException("Cannot revoke restored phone grants");
            }, (temporary, target) -> {
                // android.system.Os is available on API 21+, including action-only Android 7 Apps.
                try { android.system.Os.rename(temporary.getPath(), target.getPath()); }
                catch (android.system.ErrnoException error) { throw new IOException("Cannot commit installation identity", error); }
            });
        } catch (IOException | RuntimeException error) {
            GuguNotificationListener.setCollecting(false);
            throw new IllegalStateException("无法验证这次手机安装，请重试", error);
        }
    }

    private static String legacyKey(Context context) throws IOException {
        String id = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ANDROID_ID);
        if (id == null || id.isEmpty()) return null;
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(id.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (int index = 0; index < 8; index++) hex.append(String.format(Locale.ROOT, "%02x", digest[index]));
            return hex.toString();
        } catch (NoSuchAlgorithmException error) { throw new IOException("Cannot identify previous installation", error); }
    }
}
