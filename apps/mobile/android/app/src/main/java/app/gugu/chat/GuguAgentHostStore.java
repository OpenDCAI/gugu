package app.gugu.chat;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import com.getcapacitor.JSObject;
import org.json.JSONObject;
import java.io.File;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Owner credentials never enter an Intent, public runtime state, logs, or Android backup. */
final class GuguAgentHostStore {
    private static final String KEY = "gugu-phone-agent-host-v1";

    static synchronized JSObject configure(Context context, JSObject incoming) throws Exception {
        String owner = GuguAgentHostPolicy.owner(incoming.optString("ownerId"));
        GuguAgentHostPolicy.device(owner, incoming.optString("installId"), incoming.optString("deviceId"));
        GuguAgentHostPolicy.endpoint(incoming.optString("supabaseUrl"));
        if (incoming.optString("accessToken").isEmpty() || incoming.optString("refreshToken").isEmpty() || incoming.optString("supabaseAnonKey").isEmpty())
            throw new IllegalArgumentException("缺少手机宿主登录凭据");
        JSObject config = new JSObject(incoming.toString());
        config.put("ownerId", owner);
        JSONObject committed;
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            String raw = context.getSharedPreferences("gugu-auth-storage", Context.MODE_PRIVATE).getString("sb-main", null);
            if (raw == null) throw new SecurityException("登录会话尚未保存，不能启用手机宿主");
            JSONObject envelope = new JSONObject(raw);
            if (!"SESSION".equals(envelope.optString("state"))) throw new SecurityException("账号已退出，旧宿主不能恢复登录");
            committed = new JSONObject(envelope.getString("raw"));
            if (committed.optJSONObject("user") == null || !owner.equals(committed.getJSONObject("user").optString("id"))) throw new SecurityException("手机宿主与当前登录账号不一致");
        }
        JSObject previous;
        try { previous = read(context, owner); }
        catch (CorruptConfiguration error) {
            // Reconfigure only with the already committed current login, never a stale WebView token.
            if (!config.optString("accessToken").equals(committed.optString("access_token")))
                throw new SecurityException("手机宿主设置已损坏，请重新登录后连接");
            previous = null;
        }
        boolean changedSession = previous != null && !sessionId(previous.optString("accessToken")).equals(sessionId(config.optString("accessToken")));
        if (changedSession && (!sessionId(config.optString("accessToken")).equals(sessionId(committed.optString("access_token")))
            || !config.optString("accessToken").equals(committed.optString("access_token"))))
            throw new SecurityException("新的登录会话尚未完成保存，不能替换手机宿主会话");
        // A late WebView settings update must not overwrite tokens already renewed by Node.
        if (previous != null && !changedSession && previous.optString("supabaseUrl").equals(config.optString("supabaseUrl"))
            && previous.optString("deviceId").equals(config.optString("deviceId")) && previous.optLong("expiresAt") > 0
            && previous.optLong("expiresAt") >= config.optLong("expiresAt")) {
            config.put("accessToken", previous.optString("accessToken"));
            config.put("refreshToken", previous.optString("refreshToken"));
            config.put("expiresAt", previous.optLong("expiresAt"));
            if (previous.has("authSession")) config.put("authSession", previous.getJSONObject("authSession"));
        }
        save(context, owner, config);
        return config;
    }

    static synchronized JSObject read(Context context, String owner) throws Exception {
        File target = file(context, owner);
        if (!target.exists()) return null;
        try {
        byte[] bytes = Files.readAllBytes(target.toPath());
        if (bytes.length < 30) throw new CorruptConfiguration();
        ByteBuffer body = ByteBuffer.wrap(bytes);
        int length = body.get() & 0xff;
        if (length != 12 || body.remaining() < length + 16) throw new CorruptConfiguration();
        byte[] iv = new byte[length]; body.get(iv);
        byte[] encrypted = new byte[body.remaining()]; body.get(encrypted);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
        cipher.updateAAD(GuguAgentHostPolicy.owner(owner).getBytes(StandardCharsets.UTF_8));
        return new JSObject(new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8));
        } catch (java.security.GeneralSecurityException | org.json.JSONException error) {
            throw new CorruptConfiguration();
        }
    }
    private static final class CorruptConfiguration extends SecurityException {
        CorruptConfiguration() { super("手机宿主设置已损坏，请重新连接"); }
    }

    static synchronized JSObject updateSession(Context context, String owner, JSONObject session) throws Exception {
        JSObject config = read(context, owner);
        if (config == null) throw new IllegalStateException("手机宿主已停止");
        JSONObject user = session.optJSONObject("user");
        if (user == null || !owner.equals(user.optString("id"))) throw new SecurityException("登录会话不属于当前账号");
        if (session.optString("access_token").isEmpty() || session.optString("refresh_token").isEmpty()) throw new SecurityException("登录会话缺少凭据");
        synchronized (GuguAuthStoragePlugin.STORAGE_LOCK) {
            var storage = context.getSharedPreferences("gugu-auth-storage", Context.MODE_PRIVATE);
            String current = storage.getString("sb-main", null);
            if (current != null) {
                JSONObject existing = new JSONObject(current);
                if (!"SESSION".equals(existing.optString("state"))) throw new SecurityException("账号已退出，旧宿主不能恢复登录");
                JSONObject stored = new JSONObject(existing.getString("raw"));
                if (stored.optJSONObject("user") == null || !owner.equals(stored.getJSONObject("user").optString("id"))) throw new SecurityException("账号已切换，旧宿主不能覆盖新登录会话");
            }
            config.put("accessToken", session.getString("access_token"));
            config.put("refreshToken", session.getString("refresh_token"));
            config.put("expiresAt", session.optLong("expires_at"));
            config.put("authSession", session);
            save(context, owner, config);
            // This is the existing native Supabase storage contract, not a public host-state event.
            JSONObject envelope = new JSONObject().put("state", "SESSION").put("raw", session.toString());
            if (!storage.edit().putString("sb-main", envelope.toString()).commit()) throw new IllegalStateException("无法保存续期后的登录会话");
        }
        return config;
    }

    static synchronized void clear(Context context, String owner) throws Exception {
        File target = file(context, owner);
        Files.deleteIfExists(target.toPath());
        Files.deleteIfExists(new File(target.getPath() + ".tmp").toPath());
    }

    private static void save(Context context, String owner, JSONObject config) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(owner.getBytes(StandardCharsets.UTF_8));
        byte[] encrypted = cipher.doFinal(config.toString().getBytes(StandardCharsets.UTF_8));
        byte[] iv = cipher.getIV();
        ByteBuffer body = ByteBuffer.allocate(1 + iv.length + encrypted.length).put((byte) iv.length).put(iv).put(encrypted);
        File target = file(context, owner);
        if (!target.getParentFile().isDirectory() && !target.getParentFile().mkdirs()) throw new IllegalStateException("无法创建手机宿主凭据目录");
        DurablePhoneHostFile.write(target, body.array());
    }

    private static File file(Context context, String owner) { return new File(context.getNoBackupFilesDir(), "phone-agent-host/" + GuguAgentHostPolicy.owner(owner) + "/config.enc"); }
    private static String sessionId(String token) throws Exception {
        String[] parts = token.split("\\.");
        if (parts.length != 3) throw new SecurityException("登录凭据格式无效");
        JSONObject claims = new JSONObject(new String(android.util.Base64.decode(parts[1], android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP), StandardCharsets.UTF_8));
        String id = claims.optString("session_id");
        if (id.isEmpty()) throw new SecurityException("登录凭据缺少会话标识");
        return id;
    }
    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(KEY)) return (SecretKey) store.getKey(KEY, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
}
