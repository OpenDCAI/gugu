package app.gugu.chat;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import android.util.Base64;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;
import static org.junit.Assert.*;

/** Uses the real Android keystore and native auth envelope, without network or account creation. */
@RunWith(AndroidJUnit4.class)
public class PhoneHostConfigRecoveryTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder(
        InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir());
    private Context context;
    private String owner;
    private String install;

    @Before public void prepare() throws Exception {
        owner = UUID.randomUUID().toString();
        install = UUID.randomUUID().toString();
        File noBackup = temporary.newFolder("no-backup");
        File files = temporary.newFolder("files");
        String prefix = "host-recovery-test-" + owner + "-";
        context = new ContextWrapper(InstrumentationRegistry.getInstrumentation().getTargetContext()) {
            @Override public File getNoBackupFilesDir() { return noBackup; }
            @Override public File getFilesDir() { return files; }
            @Override public SharedPreferences getSharedPreferences(String name, int mode) {
                return super.getSharedPreferences(prefix + name, mode);
            }
        };
    }

    @After public void cleanAuth() {
        context.getSharedPreferences("gugu-auth-storage", Context.MODE_PRIVATE).edit().clear().commit();
    }

    private File credentials() { return new File(context.getNoBackupFilesDir(), "phone-agent-host/" + owner + "/config.enc"); }
    private File snapshot() { return new File(context.getFilesDir(), "phone-agent/" + owner + "/host-state.json"); }
    private static void write(File file, byte[] bytes) throws IOException {
        if (!file.getParentFile().isDirectory()) assertTrue(file.getParentFile().mkdirs());
        Files.write(file.toPath(), bytes);
    }
    private JSObject config(String session, int revision, long expiresAt) throws Exception {
        String claims = new JSONObject().put("session_id", session).put("revision", revision).toString();
        String token = "header." + Base64.encodeToString(claims.getBytes(StandardCharsets.UTF_8), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING) + ".signature";
        return new JSObject().put("ownerId", owner).put("installId", install).put("deviceId", "phone-" + install + "-" + owner)
            .put("supabaseUrl", "https://test.example.invalid").put("supabaseAnonKey", "test-public-anon")
            .put("accessToken", token).put("refreshToken", "test-refresh-" + revision).put("expiresAt", expiresAt);
    }
    private void commitSession(JSObject config, String savedOwner) throws Exception {
        JSONObject session = new JSONObject().put("user", new JSONObject().put("id", savedOwner))
            .put("access_token", config.getString("accessToken")).put("refresh_token", config.getString("refreshToken"));
        assertTrue(context.getSharedPreferences("gugu-auth-storage", Context.MODE_PRIVATE).edit().putString("sb-main",
            new JSONObject().put("state", "SESSION").put("raw", session.toString()).toString()).commit());
    }
    private void assertUnreadable() throws Exception {
        try { GuguAgentHostStore.read(context, owner); fail("Nonempty corrupt credentials were accepted"); }
        catch (SecurityException error) {
            assertEquals("手机宿主凭据文件损坏，请在「这台手机」中重新启动手机 Agent", error.getMessage());
        }
    }

    @Test public void emptyCredentialsUseTheExistingFirstConfiguration() throws Exception {
        JSObject input = config(UUID.randomUUID().toString(), 1, 100);
        commitSession(input, owner);
        write(credentials(), new byte[0]);
        assertNull(GuguAgentHostStore.read(context, owner));
        GuguAgentHostStore.configure(context, input);
        assertEquals(input.getString("refreshToken"), GuguAgentHostStore.read(context, owner).getString("refreshToken"));
        byte[] saved = Files.readAllBytes(credentials().toPath());
        GuguAgentHostStore.read(context, owner);
        assertArrayEquals(saved, Files.readAllBytes(credentials().toPath()));
        assertArrayEquals(new String[] { "config.enc" }, credentials().getParentFile().list());
    }

    @Test public void emptyCredentialsCannotReviveRetiredOrOtherOwnerSessions() throws Exception {
        JSObject input = config(UUID.randomUUID().toString(), 1, 100);
        write(credentials(), new byte[0]);
        context.getSharedPreferences("gugu-auth-storage", Context.MODE_PRIVATE).edit()
            .putString("sb-main", "{\"state\":\"RETIRED_EMPTY\"}").commit();
        try { GuguAgentHostStore.configure(context, input); fail("Retired session was restored"); }
        catch (SecurityException expected) { }
        commitSession(input, UUID.randomUUID().toString());
        try { GuguAgentHostStore.configure(context, input); fail("Another owner's session was restored"); }
        catch (SecurityException expected) { }
        assertEquals(0, credentials().length());
    }

    @Test public void nonemptyTruncatedEnvelopesStayIntactAndHaveAnActionableError() throws Exception {
        for (int length : new int[] { 1, 12, 13, 28, 29 }) {
            byte[] bad = new byte[length];
            bad[0] = length == 29 ? (byte) 11 : (byte) 12;
            write(credentials(), bad);
            assertUnreadable();
            assertArrayEquals(bad, Files.readAllBytes(credentials().toPath()));
        }
    }

    @Test public void failedGcmAuthenticationDoesNotOverwriteTheOriginal() throws Exception {
        JSObject input = config(UUID.randomUUID().toString(), 1, 100);
        commitSession(input, owner);
        GuguAgentHostStore.configure(context, input);
        byte[] bad = Files.readAllBytes(credentials().toPath());
        bad[bad.length - 1] ^= 1;
        write(credentials(), bad);
        assertUnreadable();
        try { GuguAgentHostStore.configure(context, input); fail("Corrupt credentials were silently replaced"); }
        catch (SecurityException expected) { }
        assertArrayEquals(bad, Files.readAllBytes(credentials().toPath()));
    }

    @Test public void fileIoFailureIsNotTreatedAsMissingCredentials() throws Exception {
        assertTrue(credentials().mkdirs());
        try { GuguAgentHostStore.read(context, owner); fail("A directory was treated as an empty file"); }
        catch (IOException expected) { }
        assertTrue(credentials().isDirectory());
    }

    @Test public void validConfigurationKeepsTheNewerNativeSession() throws Exception {
        String session = UUID.randomUUID().toString();
        JSObject latest = config(session, 2, 200);
        commitSession(latest, owner);
        GuguAgentHostStore.configure(context, latest);
        GuguAgentHostStore.configure(context, config(session, 1, 100));
        JSObject saved = GuguAgentHostStore.read(context, owner);
        assertEquals(latest.getString("accessToken"), saved.getString("accessToken"));
        assertEquals(latest.getString("refreshToken"), saved.getString("refreshToken"));
        assertEquals(200, saved.optLong("expiresAt"));
    }

    @Test public void invalidSnapshotIsNeverReturnedAsAnEmptySessionListOrDeletedByClear() throws Exception {
        write(snapshot(), new byte[0]);
        try { GuguAgentHostService.readState(context, owner); fail("Unknown sessions were returned as an empty list"); }
        catch (IllegalStateException error) {
            assertEquals("手机宿主状态文件损坏，请在「这台手机」中重新启动手机 Agent", error.getMessage());
        }
        GuguAgentHostService.stopOwner(context, owner, true);
        assertTrue(snapshot().exists());
        assertEquals(0, snapshot().length());
        try { GuguAgentHostService.readState(context, owner); fail("Clear hid the invalid snapshot"); }
        catch (IllegalStateException expected) { }
    }
}
