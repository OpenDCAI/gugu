package app.gugu.chat;

import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * @@@phone-app-store (L9) — Where the phone keeps the Apps installed from a chat: files, nothing else. Every decision —
 * which package may be installed, what the person is asked, what its files may be, which runtime tag its pages carry —
 * is made in the gugu page (phoneApps.ts, with the desktop's shared rules); this only writes, renames and removes files
 * under filesDir/gugu-apps/, and keeps the index AppOrigins serves from.
 *
 * A version is staged under .staging/<stage>/ and lands as <id>@<version>/ by one rename, so a crash mid-install never
 * leaves a half-written App where the index points.
 *
 * The App market's files are read here too (`marketRead`): the page cannot read the download site (it sends no CORS headers),
 * so the shell's one reader of it (DownloadSite, the update manifest's too) hands their bytes to the page, which judges them.
 */
@CapacitorPlugin(name = "GuguAppStore")
public class GuguAppStorePlugin extends Plugin {
    private static final Pattern STAGE = Pattern.compile("^stage-[0-9a-f]{8,32}$");
    private static final Pattern VERSION_DIR = Pattern.compile("^[a-z0-9][a-z0-9-]{1,63}@[0-9A-Za-z.+-]{1,64}$");
    /** A file of the market: a relative path under its root, as the market's index writes them (market.ts `marketPath`). */
    private static final Pattern MARKET_PATH = Pattern.compile("^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._/-]*$");
    /** Over the largest package the market takes (25 MiB): anything bigger is refused while it comes. */
    private static final int MARKET_MAX_BYTES = 32 * 1024 * 1024;
    // The plugin's calls share one thread: a download on it would hold every other call behind it.
    private final ExecutorService io = Executors.newCachedThreadPool();

    private File root() {
        return AppOrigins.root(getContext());
    }

    /** A path inside `base`, or null when it would leave it (the page decides the names; this only refuses escapes). */
    private static File inside(File base, String relative) throws IOException {
        if (relative == null || relative.isEmpty() || relative.startsWith("/") || relative.contains("\\")) return null;
        File file = new File(base, relative).getCanonicalFile();
        String prefix = base.getCanonicalPath() + File.separator;
        return file.getPath().startsWith(prefix) ? file : null;
    }

    private File stageDir(PluginCall call) {
        String stage = call.getString("stage", "");
        return STAGE.matcher(stage).matches() ? new File(new File(root(), ".staging"), stage) : null;
    }

    private File versionDir(PluginCall call) {
        String dir = call.getString("dir", "");
        return VERSION_DIR.matcher(dir).matches() ? new File(root(), dir) : null;
    }

    /**
     * A file of the App market, as base64: { path, maxBytes? }, relative to the market's root this build was made with
     * (build.gradle, updateFeeds.json `market`) — and read from under it only: a redirect that lands elsewhere is refused.
     * `maxBytes`: what the page knows the file is (a package's row in the index), so a bigger one stops while it comes;
     * never over MARKET_MAX_BYTES. What the bytes are — the index, a package to check against its sha256 — is the page's to judge.
     */
    @PluginMethod
    public void marketRead(PluginCall call) {
        String path = call.getString("path", "");
        if (!MARKET_PATH.matcher(path).matches()) { call.reject("Invalid market path: " + path); return; }
        Integer asked = call.getInt("maxBytes");
        int maxBytes = asked != null && asked > 0 ? Math.min(asked, MARKET_MAX_BYTES) : MARKET_MAX_BYTES;
        io.execute(() -> {
            try {
                byte[] bytes = DownloadSite.read(BuildConfig.GUGU_MARKET_ROOT + path, maxBytes,
                        path + " is larger than " + maxBytes + " bytes", BuildConfig.GUGU_MARKET_ROOT);
                JSObject result = new JSObject();
                result.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                call.resolve(result);
            } catch (Throwable error) {
                // The package and its base64 are in memory at once: running out of it (OutOfMemoryError, not an Exception)
                // is answered as a failure, never a crash of the whole app.
                call.reject(DownloadSite.describe(error));
            }
        });
    }

    /** One file of a version being staged: { stage, path, base64 }. */
    @PluginMethod
    public void stage(PluginCall call) {
        try {
            File stage = stageDir(call);
            String data = call.getString("base64");
            if (stage == null || data == null) { call.reject("Invalid stage request"); return; }
            if (!stage.isDirectory() && !stage.mkdirs()) { call.reject("Could not make the stage"); return; }
            File file = inside(stage, call.getString("path"));
            if (file == null) { call.reject("Path escapes the stage"); return; }
            File parent = file.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) { call.reject("Could not make a folder"); return; }
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(Base64.decode(data, Base64.DEFAULT));
            }
            call.resolve();
        } catch (IOException | RuntimeException error) { call.reject("Stage write failed", error); }
    }

    /** The staged version lands as <id>@<version>/: { stage, dir }. Never over an existing one. */
    @PluginMethod
    public void commit(PluginCall call) {
        File stage = stageDir(call);
        File target = versionDir(call);
        if (stage == null || target == null || !stage.isDirectory()) { call.reject("Invalid commit request"); return; }
        if (target.exists()) remove(target);
        if (!stage.renameTo(target)) { call.reject("Could not move the staged version into place"); return; }
        call.resolve();
    }

    /** A stage given up, or a version no longer installed: { stage } or { dir }. */
    @PluginMethod
    public void discard(PluginCall call) {
        File stage = call.getString("stage") != null ? stageDir(call) : versionDir(call);
        if (stage == null) { call.reject("Invalid discard request"); return; }
        remove(stage);
        call.resolve();
    }

    /** What is on disk: the version folders (the page sweeps the ones its index no longer names) and any stages. */
    @PluginMethod
    public void list(PluginCall call) {
        JSArray dirs = new JSArray();
        File[] entries = root().listFiles();
        if (entries != null) {
            for (File entry : entries) if (entry.isDirectory() && VERSION_DIR.matcher(entry.getName()).matches()) dirs.put(entry.getName());
        }
        File[] stages = new File(root(), ".staging").listFiles();
        JSObject result = new JSObject();
        result.put("dirs", dirs);
        result.put("stages", stages == null ? 0 : stages.length);
        call.resolve(result);
    }

    /** A text file of an installed version (to re-tag its pages when the runtime's tag changes): { dir, path }. */
    @PluginMethod
    public void readText(PluginCall call) {
        try {
            File dir = versionDir(call);
            File file = dir == null ? null : inside(dir, call.getString("path"));
            if (file == null || !file.isFile()) { call.reject("No such file"); return; }
            JSObject result = new JSObject();
            result.put("text", new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (IOException | RuntimeException error) { call.reject("Read failed", error); }
    }

    /** Replace a text file of an installed version, atomically: { dir, path, text }. */
    @PluginMethod
    public void writeText(PluginCall call) {
        try {
            File dir = versionDir(call);
            File file = dir == null ? null : inside(dir, call.getString("path"));
            String text = call.getString("text");
            if (file == null || text == null) { call.reject("Invalid write request"); return; }
            AppOrigins.writeAtomically(file, text.getBytes(StandardCharsets.UTF_8));
            call.resolve();
        } catch (IOException | RuntimeException error) { call.reject("Write failed", error); }
    }

    /** The index (installed Apps and what each origin serves), as the page wrote it: { json } or { json: null }. */
    @PluginMethod
    public void readIndex(PluginCall call) {
        JSObject result = new JSObject();
        String json = AppOrigins.readIndex(getContext());
        result.put("json", json == null ? JSObject.NULL : json);
        call.resolve(result);
    }

    /** The page's new index, written atomically; AppOrigins serves from it from the next request on: { json }. */
    @PluginMethod
    public void writeIndex(PluginCall call) {
        try {
            String json = call.getString("json");
            if (json == null) { call.reject("Missing index"); return; }
            AppOrigins.writeIndex(getContext(), json);
            call.resolve();
        } catch (IOException | RuntimeException error) { call.reject("Index write failed", error); }
    }

    // ─── an App's own data (gugu.readData / writeData / listData) ─────────────
    //
    // One folder per App, filesDir/gugu-app-data/<appId>/, uninstalled with it. The size limit is checked by the page
    // (app-data.ts, the desktop's); here only that a path stays inside.

    private static final Pattern APP_ID = Pattern.compile("^[a-z0-9][a-z0-9-]{1,63}$");

    private File dataRoot(PluginCall call) {
        String app = call.getString("app", "");
        if (!APP_ID.matcher(app).matches()) return null;
        File root = new File(new File(getContext().getFilesDir(), "gugu-app-data"), app);
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
        return root;
    }

    /** The desktop's answer for a path that leaves the folder (extension-data.ts), word for word. */
    private static File dataPath(File root, String relative) throws IOException {
        String cleaned = relative == null || relative.trim().isEmpty() ? "." : relative;
        File target = new File(root, cleaned).getCanonicalFile();
        File base = root.getCanonicalFile();
        if (!target.equals(base) && !target.getPath().startsWith(base.getPath() + File.separator)) {
            throw new IOException("path must stay inside the extension data folder: " + relative);
        }
        return target;
    }

    /** { app, path } → { text } or { text: null } for a file not there. */
    @PluginMethod
    public void dataRead(PluginCall call) {
        try {
            File root = dataRoot(call);
            if (root == null) { call.reject("Invalid data request"); return; }
            File file = dataPath(root, call.getString("path"));
            JSObject result = new JSObject();
            result.put("text", file.isFile() ? new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8) : JSObject.NULL);
            call.resolve(result);
        } catch (IOException | RuntimeException error) { call.reject(error.getMessage()); }
    }

    /** { app, path, text }: written whole, then renamed into place (a reader never sees half a file). */
    @PluginMethod
    public void dataWrite(PluginCall call) {
        try {
            File root = dataRoot(call);
            String text = call.getString("text");
            if (root == null || text == null) { call.reject("Invalid data request"); return; }
            File file = dataPath(root, call.getString("path"));
            if (file.equals(root.getCanonicalFile())) { call.reject("path must name a file"); return; }
            File parent = file.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) { call.reject("Could not make a folder"); return; }
            AppOrigins.writeAtomically(file, text.getBytes(StandardCharsets.UTF_8));
            call.resolve();
        } catch (IOException | RuntimeException error) { call.reject(error.getMessage()); }
    }

    /** { app, path } → { entries: [{ path, kind }] }: one folder's entries, paths relative to the data folder. */
    @PluginMethod
    public void dataList(PluginCall call) {
        try {
            File root = dataRoot(call);
            if (root == null) { call.reject("Invalid data request"); return; }
            File dir = dataPath(root, call.getString("path"));
            String base = root.getCanonicalPath();
            JSArray entries = new JSArray();
            File[] children = dir.isDirectory() ? dir.listFiles() : null;
            if (children != null) {
                for (File child : children) {
                    JSObject entry = new JSObject();
                    entry.put("path", child.getCanonicalPath().substring(base.length() + 1).replace(File.separatorChar, '/'));
                    entry.put("kind", child.isDirectory() ? "directory" : "file");
                    entries.put(entry);
                }
            }
            JSObject result = new JSObject();
            result.put("entries", entries);
            call.resolve(result);
        } catch (IOException | RuntimeException error) { call.reject(error.getMessage()); }
    }

    /**
     * { app }: an App's data, removed with the App. (Its origin's browser storage is forgotten by the page, in that
     * origin — forget-entry.ts: WebStorage.deleteOrigin leaves localStorage and CacheStorage.)
     */
    @PluginMethod
    public void dataRemove(PluginCall call) {
        String app = call.getString("app", "");
        if (!APP_ID.matcher(app).matches()) { call.reject("Invalid data request"); return; }
        remove(new File(new File(getContext().getFilesDir(), "gugu-app-data"), app));
        call.resolve();
    }

    private static void remove(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) remove(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
