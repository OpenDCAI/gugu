package app.gugu.chat;

import android.content.ClipData;
import android.content.ComponentName;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Parcelable;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.MimeTypeMap;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * 与其他 App 互传(product spec)—— 这一层只做搬运,两个方向:
 *
 * 出:把页面给的文字与附件地址交给系统分享面板;或把一个附件交给「打开方式」(open);或把页面手里的字节
 *    「保存」到用户在系统存储界面里选的位置(save)。分享 / 打开的附件先下到
 *    cache/share-out/<一次一个目录>/,经 FileProvider 交出去 —— 微信收的是文件本身,不是链接。
 * 进:别的 App 的「分享」(SEND / SEND_MULTIPLE)与「用其他应用打开」(VIEW,微信对文件就是这一条)
 *    落到 MainActivity。对方给的 content:// 授权只在这次投递里有效,所以当场把字节拷进
 *    cache/share-in/<id>/,再以 `shareReceived` 交给页面;页面还没挂监听(冷启动、没登录)时事件留着等它。
 *
 * 发到哪条会话、发不发、发之前给谁看,全在页面(apps/desktop/src/mobile/share-intake/)。
 * 这里不认识会话,也 ❌ 自己发任何东西。
 */
@CapacitorPlugin(name = "GuguShare")
public class GuguSharePlugin extends Plugin {
    static final String EVENT_RECEIVED = "shareReceived";
    // res/xml/file_paths.xml 里 share_out 那一行把这个目录开放给接收方读,两处要一起改。
    private static final String OUT_DIR = "share-out";
    private static final String IN_DIR = "share-in";
    // 接收方未必当场读:微信要等用户选完好友才去取文件。留一天,下次分享时顺手清掉更早的。
    private static final long KEEP_MS = 24L * 60 * 60 * 1000;
    private static final Pattern SHARE_ID = Pattern.compile("^[0-9a-f-]{36}$");
    // 只防把整台手机的内存吃光(页面要把它读成 Blob):真正的附件上限由上传那一步照常判、照常报。
    private static final long MAX_INCOMING_BYTES = 100L * 1024 * 1024;

    private final ExecutorService io = Executors.newSingleThreadExecutor();

    /** 有意拒收(不是读坏了):code 给界面挑一句用户看得懂的话,message 只进日志。 */
    private static final class Rejected extends IOException {
        final String code;

        Rejected(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    @Override
    public void load() {
        io.execute(() -> {
            prune(new File(getContext().getCacheDir(), OUT_DIR));
            prune(new File(getContext().getCacheDir(), IN_DIR));
        });
        // 冷启动:分享就是把咕咕拉起来的那个 Intent。读完换成 MAIN,免得同一个 Activity 再被读一次。
        Intent launch = getActivity().getIntent();
        if (isIncoming(launch)) {
            receive(launch);
            getActivity().setIntent(new Intent(Intent.ACTION_MAIN));
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (isIncoming(intent)) receive(intent);
    }

    // ─── 出 ─────────────────────────────────────────────────────────────────────

    /**
     * { text?, title?, files?: [{ url, name, mimeType? }] } → 系统分享面板。
     * 面板弹出即 resolve:用户在面板里选了谁、发没发,系统不告诉发起方。
     */
    @PluginMethod
    public void share(PluginCall call) {
        String text = call.getString("text");
        String title = call.getString("title");
        JSArray files = call.getArray("files", new JSArray());
        if ((text == null || text.isEmpty()) && files.length() == 0) {
            call.reject("Nothing to share");
            return;
        }
        io.execute(() -> {
            File batch = new File(new File(getContext().getCacheDir(), OUT_DIR), UUID.randomUUID().toString());
            try {
                ArrayList<Uri> uris = new ArrayList<>();
                List<String> types = new ArrayList<>();
                for (int i = 0; i < files.length(); i++) {
                    JSONObject file = files.getJSONObject(i);
                    String url = file.optString("url", "");
                    String name = safeName(file.optString("name", ""), "file-" + (i + 1));
                    String type = file.optString("mimeType", "");
                    if (type.isEmpty()) type = guessType(name);
                    File target = uniqueFile(batch, name);
                    download(url, target);
                    uris.add(FileProvider.getUriForFile(getContext(), authority(), target));
                    types.add(type);
                }

                Intent send;
                if (uris.isEmpty()) {
                    send = new Intent(Intent.ACTION_SEND);
                    send.setType("text/plain");
                } else if (uris.size() == 1) {
                    send = new Intent(Intent.ACTION_SEND);
                    send.setType(types.get(0));
                    send.putExtra(Intent.EXTRA_STREAM, uris.get(0));
                } else {
                    send = new Intent(Intent.ACTION_SEND_MULTIPLE);
                    send.setType(commonType(types));
                    send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
                }
                if (text != null && !text.isEmpty()) send.putExtra(Intent.EXTRA_TEXT, text);
                if (!uris.isEmpty()) {
                    // 读授权随 ClipData 走:SEND_MULTIPLE 与经过选择器转交时,只挂 EXTRA_STREAM 不够。
                    ClipData clip = ClipData.newRawUri(null, uris.get(0));
                    for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
                    send.setClipData(clip);
                    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                }
                // 面板里不列咕咕自己:在咕咕里发给别的会话是「转发」,绕一圈系统分享只会多一步。
                startChooser(call, send, title);
            } catch (Exception error) {
                deleteTree(batch);
                call.reject(describe(error), error);
            }
        });
    }

    /**
     * { url, name } → 系统的「打开方式」(ACTION_VIEW)。应用内不预览的附件(压缩包、音频……)走这里,
     * 与「出」同一个目录、同一个 FileProvider。没有能打开的应用时由选择器当面说。
     */
    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url", "");
        String name = safeName(call.getString("name"), "file");
        io.execute(() -> {
            File batch = new File(new File(getContext().getCacheDir(), OUT_DIR), UUID.randomUUID().toString());
            try {
                File target = uniqueFile(batch, name);
                download(url, target);
                Intent view = new Intent(Intent.ACTION_VIEW);
                view.setDataAndType(FileProvider.getUriForFile(getContext(), authority(), target), guessType(name));
                view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                // 同样不列咕咕自己:咕咕认 VIEW content://,列出来就成了把文件「发送到咕咕」。
                startChooser(call, view, null);
            } catch (Exception error) {
                deleteTree(batch);
                call.reject(describe(error), error);
            }
        });
    }

    /**
     * { name, mimeType?, data(base64) } → 系统的「保存到…」(ACTION_CREATE_DOCUMENT),写进用户选的位置。
     * WebView 不认 `<a download>`(壳没有、也接不住 blob: 的 DownloadListener),页面的「保存」走这里。
     * 不要任何存储权限;resolve { saved }:用户在系统界面里取消 = false。
     *
     * 字节先落到 share-out 里一个文件,call 里只留它的路径再去开系统界面:Capacitor 为了活过进程被杀,会把
     * 开着系统界面的那个 call 的参数写进 Activity 的保存状态 —— 带着字节就是一个几十 MB 的 Bundle,
     * Activity 一停下就 TransactionTooLargeException 崩掉(20 MiB 实测)。
     */
    @PluginMethod
    public void save(PluginCall call) {
        String data = call.getString("data");
        if (data == null) {
            call.reject("Nothing to save");
            return;
        }
        String name = safeName(call.getString("name"), "file");
        String type = call.getString("mimeType", "");
        io.execute(() -> {
            File batch = new File(new File(getContext().getCacheDir(), OUT_DIR), UUID.randomUUID().toString());
            try {
                if (!batch.mkdirs()) throw new IOException("Could not create " + batch);
                File staged = new File(batch, name);
                try (OutputStream out = new FileOutputStream(staged)) {
                    out.write(Base64.decode(data, Base64.DEFAULT));
                }
                call.getData().remove("data");
                call.getData().put("staged", staged.getAbsolutePath());
                Intent create = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                create.addCategory(Intent.CATEGORY_OPENABLE);
                create.setType(type == null || type.isEmpty() ? guessType(name) : type);
                create.putExtra(Intent.EXTRA_TITLE, name);
                getActivity().runOnUiThread(() -> {
                    try {
                        startActivityForResult(call, create, "saveTargetPicked");
                    } catch (RuntimeException error) {
                        // 没有能接 CREATE_DOCUMENT 的组件(ActivityNotFoundException)等:如实报回页面,❌ 崩在主线程。
                        deleteTree(batch);
                        call.reject("Could not open the save dialog: " + error, error);
                    }
                });
            } catch (Exception error) {
                deleteTree(batch);
                call.reject(describe(error), error);
            }
        });
    }

    @ActivityCallback
    private void saveTargetPicked(PluginCall call, ActivityResult result) {
        File staged = new File(call.getString("staged", ""));
        Uri target = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != android.app.Activity.RESULT_OK || target == null) {
            deleteTree(staged.getParentFile());
            JSObject cancelled = new JSObject();
            cancelled.put("saved", false);
            call.resolve(cancelled);
            return;
        }
        io.execute(() -> {
            try (InputStream in = new java.io.FileInputStream(staged);
                 OutputStream out = getContext().getContentResolver().openOutputStream(target, "w")) {
                if (out == null) throw new IOException("No output stream for " + target);
                byte[] buffer = new byte[64 * 1024];
                for (int n; (n = in.read(buffer)) > 0; ) out.write(buffer, 0, n);
                JSObject saved = new JSObject();
                saved.put("saved", true);
                call.resolve(saved);
            } catch (Exception error) {
                call.reject(describe(error), error);
            } finally {
                deleteTree(staged.getParentFile());
            }
        });
    }

    private void startChooser(PluginCall call, Intent target, String title) {
        Intent chooser = Intent.createChooser(target, title);
        chooser.putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, new ComponentName[] { new ComponentName(getContext(), MainActivity.class) });
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startActivity(chooser);
                call.resolve();
            } catch (RuntimeException error) {
                call.reject("Could not open the chooser: " + error, error);
            }
        });
    }

    // ─── 进 ─────────────────────────────────────────────────────────────────────

    /** 页面发完或放弃之后调:删掉这次拷进来的临时文件。 */
    @PluginMethod
    public void release(PluginCall call) {
        String id = call.getString("id");
        if (id == null || !SHARE_ID.matcher(id).matches()) {
            call.reject("Invalid share id: " + id);
            return;
        }
        io.execute(() -> {
            deleteTree(new File(new File(getContext().getCacheDir(), IN_DIR), id));
            call.resolve();
        });
    }

    static boolean isIncoming(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) return true;
        // VIEW 只认 content://:别的 scheme(将来的深链)不是分享。
        return Intent.ACTION_VIEW.equals(action)
                && intent.getData() != null
                && ContentResolver.SCHEME_CONTENT.equals(intent.getData().getScheme());
    }

    private void receive(Intent intent) {
        CharSequence rawText = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String text = rawText == null ? null : rawText.toString();
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        String declaredType = intent.getType();
        List<Uri> uris = incomingUris(intent);
        String id = UUID.randomUUID().toString();
        io.execute(() -> {
            File dir = new File(new File(getContext().getCacheDir(), IN_DIR), id);
            JSArray files = new JSArray();
            JSArray failures = new JSArray();
            int index = 0;
            for (Uri uri : uris) {
                index++;
                try {
                    files.put(copyIn(uri, dir, declaredType, index));
                } catch (Exception error) {
                    // fail loud:读不到的逐个报给页面,由页面当面说「有几个没能读取」,❌ 悄悄少一个。
                    JSObject failure = new JSObject();
                    failure.put("name", displayName(uri));
                    failure.put("code", error instanceof Rejected ? ((Rejected) error).code : "unreadable");
                    failure.put("detail", describe(error));
                    failures.put(failure);
                }
            }
            JSObject share = new JSObject();
            share.put("id", id);
            share.put("text", text == null ? JSObject.NULL : text);
            share.put("subject", subject == null ? JSObject.NULL : subject);
            share.put("files", files);
            share.put("failures", failures);
            notifyListeners(EVENT_RECEIVED, share, true);
        });
    }

    private static List<Uri> incomingUris(Intent intent) {
        List<Uri> uris = new ArrayList<>();
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) {
            uris.add(intent.getData());
            return uris;
        }
        if (Intent.ACTION_SEND.equals(action)) {
            Uri one = streamExtra(intent);
            if (one != null) uris.add(one);
        } else {
            ArrayList<Uri> many = streamListExtra(intent);
            if (many != null) for (Uri uri : many) if (uri != null) uris.add(uri);
        }
        // 有的 App 只把地址放在 ClipData 里。
        if (uris.isEmpty() && intent.getClipData() != null) {
            ClipData clip = intent.getClipData();
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null) uris.add(uri);
            }
        }
        return uris;
    }

    @SuppressWarnings("deprecation")
    private static Uri streamExtra(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        Parcelable value = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        return value instanceof Uri ? (Uri) value : null;
    }

    @SuppressWarnings("deprecation")
    private static ArrayList<Uri> streamListExtra(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class);
        return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
    }

    private JSObject copyIn(Uri uri, File dir, String declaredType, int index) throws IOException {
        // 只收 content://。file:// 与指向咕咕自己 FileProvider 的地址一律拒:别的 App 可以借「分享给咕咕」
        // 让咕咕读出它自己的私有文件(登录态、缓存),再被用户顺手发进聊天。
        if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            throw new Rejected("refused", "unsupported address " + uri.getScheme() + "://");
        }
        if (isOwnProvider(uri)) {
            throw new Rejected("refused", "refusing an address inside 咕咕 itself");
        }
        ContentResolver resolver = getContext().getContentResolver();
        long declaredSize = declaredSize(uri);
        if (declaredSize > MAX_INCOMING_BYTES) throw new Rejected("tooLarge", "larger than 100 MB");
        String type = resolver.getType(uri);
        String name = safeName(displayName(uri), "shared-" + index);
        if (type == null || type.isEmpty()) {
            type = declaredType != null && !declaredType.contains("*") ? declaredType : guessType(name);
        }
        if (!name.contains(".")) {
            String extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(type);
            if (extension != null) name = name + "." + extension;
        }
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("could not create " + dir);
        File target = uniqueFile(dir, name);
        long size = 0;
        try (InputStream in = resolver.openInputStream(uri); OutputStream out = new FileOutputStream(target)) {
            if (in == null) throw new IOException("the other app returned no data");
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) != -1) {
                out.write(buffer, 0, n);
                size += n;
                // 有的提供方不报大小:拷的过程中照样截住。
                if (size > MAX_INCOMING_BYTES) throw new Rejected("tooLarge", "larger than 100 MB");
            }
        } catch (IOException | RuntimeException error) {
            target.delete();
            throw error;
        }
        JSObject file = new JSObject();
        file.put("path", Uri.fromFile(target).toString());
        file.put("name", target.getName());
        file.put("mimeType", type);
        file.put("size", size);
        return file;
    }

    /**
     * 这个地址是不是咕咕自己的提供方。❌ 只比字符串:`content://0@<authority>/…` 带用户号前缀,字符串不等,
     * ContentResolver 却照样路由到同一个提供方。去掉用户号,再问系统这个提供方属于哪个包。
     */
    private boolean isOwnProvider(Uri uri) {
        String authority = uri.getAuthority();
        if (authority == null) return false;
        String bare = authority.substring(authority.lastIndexOf('@') + 1);
        ProviderInfo provider = getContext().getPackageManager().resolveContentProvider(bare, 0);
        if (provider != null) return getContext().getPackageName().equals(provider.packageName);
        return bare.equals(authority());
    }

    private long declaredSize(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.SIZE }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getLong(0);
        } catch (RuntimeException ignored) {
            // 不答大小的提供方:拷的时候再截。
        }
        return -1;
    }

    private String displayName(Uri uri) {
        if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) return uri.getLastPathSegment();
        try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0);
        } catch (RuntimeException ignored) {
            // 有的提供方不答 OpenableColumns;名字退回地址最后一段,内容照拷。
        }
        return uri.getLastPathSegment();
    }

    // ─── 共用 ───────────────────────────────────────────────────────────────────

    private String authority() {
        return getContext().getPackageName() + ".fileprovider";
    }

    private static void download(String url, File target) throws IOException {
        boolean allowed = url.startsWith("https://") || (BuildConfig.GUGU_ALLOW_LOCAL_HTTP && url.startsWith("http://"));
        if (!allowed) throw new IOException("unsupported attachment address: " + url);
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("could not create " + parent);
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        try {
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) throw new IOException("HTTP " + status + " downloading " + target.getName());
            try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(target)) {
                byte[] buffer = new byte[64 * 1024];
                int n;
                while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
            }
        } catch (IOException | RuntimeException error) {
            target.delete();
            throw error;
        } finally {
            connection.disconnect();
        }
    }

    /** 名字只留最后一段、去掉控制字符;空了用 fallback。❌ 让来路拼出目录外的路径。 */
    private static String safeName(String raw, String fallback) {
        String name = raw == null ? "" : raw;
        int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (slash >= 0) name = name.substring(slash + 1);
        name = name.replaceAll("[\\p{Cntrl}]", "").trim();
        if (name.isEmpty() || name.equals(".") || name.equals("..")) return fallback;
        return name.length() > 120 ? name.substring(name.length() - 120) : name;
    }

    private static File uniqueFile(File dir, String name) {
        File candidate = new File(dir, name);
        if (!candidate.exists()) return candidate;
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String extension = dot > 0 ? name.substring(dot) : "";
        for (int i = 2; ; i++) {
            candidate = new File(dir, stem + " (" + i + ")" + extension);
            if (!candidate.exists()) return candidate;
        }
    }

    private static String guessType(String name) {
        int dot = name.lastIndexOf('.');
        String extension = dot >= 0 ? name.substring(dot + 1).toLowerCase() : "";
        String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        return type != null ? type : "application/octet-stream";
    }

    /** 多个附件的总类型:全同取原值,同一大类取 image/* 这样,混着取 *\/*。 */
    private static String commonType(List<String> types) {
        Set<String> distinct = new HashSet<>(types);
        if (distinct.size() == 1) return types.get(0);
        Set<String> families = new HashSet<>();
        for (String type : types) families.add(type.contains("/") ? type.substring(0, type.indexOf('/')) : type);
        return families.size() == 1 ? families.iterator().next() + "/*" : "*/*";
    }

    private static void prune(File root) {
        File[] batches = root.listFiles();
        if (batches == null) return;
        long cutoff = System.currentTimeMillis() - KEEP_MS;
        for (File batch : batches) if (batch.lastModified() < cutoff) deleteTree(batch);
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }

    private static String describe(Exception error) {
        String message = error.getMessage();
        return message != null ? message : error.toString();
    }
}
