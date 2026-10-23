package app.gugu.chat;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

/** Shared packaged runtime setup for the trial runner and the persistent phone host. */
final class GuguAgentRuntime {
    static synchronized Process start(Context context, String owner) throws Exception {
        return start(context, owner, false);
    }
    static synchronized Process start(Context context, String owner, boolean persistentHost) throws Exception {
        File runtime = new File(context.getFilesDir(), "embedded-node/" + BuildConfig.VERSION_NAME);
        if (!new File(runtime, "complete").exists()) {
            copyAssets(context, "agent-runtime", runtime);
            JSONArray aliases = new JSONArray(new String(Files.readAllBytes(new File(runtime, "library-aliases.json").toPath()), StandardCharsets.UTF_8));
            for (int index = 0; index < aliases.length(); index++) {
                JSONObject alias = aliases.getJSONObject(index);
                File link = new File(runtime, "lib/" + alias.getString("name"));
                Files.deleteIfExists(link.toPath());
                Files.createSymbolicLink(link.toPath(), java.nio.file.Paths.get(alias.getString("target")));
            }
            new File(runtime, "complete").createNewFile();
        }
        File home = persistentHost
            ? new File(context.getNoBackupFilesDir(), "phone-agent-runtime/" + GuguAgentHostPolicy.owner(owner))
            : new File(context.getFilesDir(), "phone-agent/" + GuguAgentHostPolicy.owner(owner));
        if (!home.isDirectory() && !home.mkdirs()) throw new IllegalStateException("无法创建手机 Agent 会话目录");
        ProcessBuilder builder = new ProcessBuilder(new File(context.getApplicationInfo().nativeLibraryDir, "libgugu_node.so").getPath(), new File(runtime, "agent.mjs").getPath());
        builder.directory(home);
        builder.environment().put("HOME", home.getPath());
        builder.environment().put("TMPDIR", context.getCacheDir().getPath());
        builder.environment().put("LD_LIBRARY_PATH", new File(runtime, "lib").getPath());
        builder.environment().put("NODE_EXTRA_CA_CERTS", new File(runtime, "ca.pem").getPath());
        builder.environment().put("PI_PACKAGE_DIR", runtime.getPath());
        builder.environment().put("GUGU_AGENT_HOME", home.getPath());
        builder.environment().put("TZ", java.util.TimeZone.getDefault().getID());
        return builder.start();
    }

    private static void copyAssets(Context context, String source, File destination) throws Exception {
        String[] entries = context.getAssets().list(source);
        if (entries != null && entries.length > 0) {
            if (!destination.isDirectory() && !destination.mkdirs()) throw new IllegalStateException("无法准备手机运行时");
            for (String entry : entries) copyAssets(context, source + "/" + entry, new File(destination, entry));
        } else {
            destination.getParentFile().mkdirs();
            try (java.io.InputStream input = context.getAssets().open(source)) { Files.copy(input, destination.toPath(), StandardCopyOption.REPLACE_EXISTING); }
        }
    }
}
