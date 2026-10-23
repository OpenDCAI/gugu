package app.gugu.chat;

import android.Manifest;
import android.content.ContentUris;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.provider.Telephony;
import android.net.Uri;
import android.util.Base64;
import android.util.Size;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** #7504 Read-only system data. IDs are collection-local numbers, never caller-supplied paths/URIs.
 * Media bytes travel in bounded RPC chunks; the calling host assembles them into a file, outside model context. */
@CapacitorPlugin(name = "GuguPhoneData", permissions = {
    @Permission(alias = "sms", strings = { Manifest.permission.READ_SMS }),
    @Permission(alias = "audio", strings = { "android.permission.READ_MEDIA_AUDIO" }),
    @Permission(alias = "images", strings = { "android.permission.READ_MEDIA_IMAGES" }),
    @Permission(alias = "videos", strings = { "android.permission.READ_MEDIA_VIDEO" }),
    @Permission(alias = "selected", strings = { "android.permission.READ_MEDIA_VISUAL_USER_SELECTED" }),
    @Permission(alias = "legacy", strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
})
public class GuguPhoneDataPlugin extends Plugin {
    private static final int CHUNK_BYTES = 96 * 1024;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    void closeReadExecutor() { io.shutdownNow(); }
    @Override protected void handleOnDestroy() { closeReadExecutor(); }

    private boolean has(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    private JSObject state() {
        JSObject out = new JSObject();
        out.put("supported", true);
        out.put("sms", has(Manifest.permission.READ_SMS));
        boolean legacy = Build.VERSION.SDK_INT < 33 && has(Manifest.permission.READ_EXTERNAL_STORAGE);
        out.put("audio", legacy || (Build.VERSION.SDK_INT >= 33 && has("android.permission.READ_MEDIA_AUDIO")));
        out.put("images", legacy || (Build.VERSION.SDK_INT >= 33 && has("android.permission.READ_MEDIA_IMAGES")));
        out.put("videos", legacy || (Build.VERSION.SDK_INT >= 33 && has("android.permission.READ_MEDIA_VIDEO")));
        out.put("selected", Build.VERSION.SDK_INT >= 34 && has("android.permission.READ_MEDIA_VISUAL_USER_SELECTED"));
        return out;
    }

    @PluginMethod public void status(PluginCall call) { call.resolve(state()); }

    @PluginMethod public void request(PluginCall call) {
        String group = call.getString("group", "");
        String[] aliases;
        switch (group) {
            case "sms": aliases = new String[] { "sms" }; break;
            case "recordings": aliases = new String[] { Build.VERSION.SDK_INT >= 33 ? "audio" : "legacy" }; break;
            case "photos": aliases = Build.VERSION.SDK_INT >= 34 ? new String[] { "images", "videos", "selected" }
                : Build.VERSION.SDK_INT >= 33 ? new String[] { "images", "videos" } : new String[] { "legacy" }; break;
            default: call.reject("未知的数据类别", "invalid_args"); return;
        }
        requestPermissionForAliases(aliases, call, "permissionsDone");
    }

    @PermissionCallback private void permissionsDone(PluginCall call) { call.resolve(state()); }

    private interface Read { JSObject run() throws Exception; }
    private void read(PluginCall call, String group, Read work) {
        io.execute(() -> {
            try {
                JSObject permissions = state();
                boolean allowed = group.equals("sms") ? permissions.getBoolean("sms", false)
                    : group.equals("audio") ? permissions.getBoolean("audio", false)
                    : permissions.getBoolean(group.equals("image") ? "images" : "videos", false) || permissions.getBoolean("selected", false);
                if (!allowed) { call.reject(group.equals("sms") ? "系统尚未授予短信读取权限,也可能是安装来源不允许授予" : group.equals("audio") ? "系统尚未授予音频读取权限" : "系统尚未授予这类照片或视频的读取权限", "os_permission"); return; }
                call.resolve(work.run());
            } catch (SecurityException e) {
                call.reject("系统拒绝读取(权限已撤销或当前文件不在授权范围)", "os_permission");
            } catch (IllegalArgumentException e) {
                call.reject(e.getMessage(), "invalid_args");
            } catch (Exception e) {
                call.reject("读取失败:" + e.getMessage(), "failed");
            }
        });
    }

    private static long id(PluginCall call) {
        String value = call.getString("id", "");
        if (!value.matches("[1-9][0-9]*")) throw new IllegalArgumentException("id 要是列表返回的数字编号");
        return Long.parseLong(value);
    }

    private static int limit(PluginCall call) {
        int value = call.getInt("limit", 30);
        if (value < 1 || value > 100) throw new IllegalArgumentException("limit 要在 1–100");
        return value;
    }

    private static void filter(PluginCall call, List<String> where, List<String> args, String dateColumn) {
        for (String key : new String[] { "after_ms", "before_ms" }) {
            Long value = PhoneReadNumbers.optional(call.getData().opt(key), key);
            if (value != null) {
                if (value < 0) throw new IllegalArgumentException(key + " 不能小于 0");
                where.add(dateColumn + (key.equals("after_ms") ? " >= ?" : " < ?"));
                args.add(Long.toString(value));
            }
        }
        String before = call.getString("before_id");
        if (before != null) {
            if (!before.matches("[1-9][0-9]*")) throw new IllegalArgumentException("before_id 要是上一页返回的编号");
            where.add("_id < ?"); args.add(before);
        }
    }

    private static String selection(List<String> where) { return where.isEmpty() ? null : android.text.TextUtils.join(" AND ", where); }
    private static String text(Cursor c, String column) { int i = c.getColumnIndexOrThrow(column); return c.isNull(i) ? "" : c.getString(i); }
    private static long number(Cursor c, String column) { int i = c.getColumnIndexOrThrow(column); return c.isNull(i) ? 0 : c.getLong(i); }
    private static String like(String value) { return "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"; }

    private static JSObject sms(Cursor c) {
        JSObject row = new JSObject();
        row.put("id", text(c, "_id")); row.put("address", text(c, "address")); row.put("body", text(c, "body"));
        row.put("date_ms", number(c, "date")); row.put("type", number(c, "type")); row.put("read", number(c, "read") == 1);
        row.put("thread_id", text(c, "thread_id"));
        return row;
    }
    private static final String[] SMS_COLUMNS = { "_id", "address", "body", "date", "type", "read", "thread_id" };

    @PluginMethod public void smsList(PluginCall call) {
        read(call, "sms", () -> {
            List<String> where = new ArrayList<>(), args = new ArrayList<>();
            filter(call, where, args, "date");
            for (String key : new String[] { "query", "address" }) {
                String value = call.getString(key);
                if (value != null && !value.isEmpty()) { where.add((key.equals("query") ? "body" : "address") + " LIKE ? ESCAPE '\\'"); args.add(like(value)); }
            }
            JSArray rows = new JSArray(); boolean more = false; String last = null;
            try (Cursor c = getContext().getContentResolver().query(Telephony.Sms.CONTENT_URI, SMS_COLUMNS, selection(where), args.toArray(new String[0]), "_id DESC")) {
                if (c == null) throw new IllegalStateException("短信服务未返回查询结果");
                int max = limit(call);
                while (c.moveToNext()) {
                    if (rows.length() == max) { more = true; break; }
                    JSObject row = sms(c); rows.put(row); last = row.getString("id");
                }
            }
            JSObject out = new JSObject(); out.put("messages", rows); out.put("next_before_id", more ? last : JSObject.NULL); return out;
        });
    }

    @PluginMethod public void smsGet(PluginCall call) {
        read(call, "sms", () -> {
            try (Cursor c = getContext().getContentResolver().query(ContentUris.withAppendedId(Telephony.Sms.CONTENT_URI, id(call)), SMS_COLUMNS, null, null, null)) {
                if (c == null || !c.moveToFirst()) throw new IllegalArgumentException("短信不存在或当前不可读");
                return sms(c);
            }
        });
    }

    private static String kind(PluginCall call) {
        String value = call.getString("kind", "audio");
        if (!value.equals("audio") && !value.equals("image") && !value.equals("video")) throw new IllegalArgumentException("kind 要是 audio / image / video");
        return value;
    }
    private static Uri collection(String kind) {
        return kind.equals("audio") ? MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
            : kind.equals("image") ? MediaStore.Images.Media.EXTERNAL_CONTENT_URI : MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
    }
    private static String[] mediaColumns(String kind) {
        List<String> cols = new ArrayList<>(java.util.Arrays.asList("_id", "_display_name", "mime_type", "_size", "date_added", "date_modified"));
        if (Build.VERSION.SDK_INT >= 29) cols.add("relative_path");
        if (!kind.equals("image")) cols.add("duration");
        if (!kind.equals("audio")) { cols.add("width"); cols.add("height"); }
        return cols.toArray(new String[0]);
    }
    private static JSObject media(Cursor c, String kind) {
        JSObject out = new JSObject();
        out.put("id", text(c, "_id")); out.put("kind", kind); out.put("name", text(c, "_display_name"));
        out.put("mime_type", text(c, "mime_type")); out.put("size", number(c, "_size"));
        out.put("added_at_ms", number(c, "date_added") * 1000); out.put("modified_at_ms", number(c, "date_modified") * 1000);
        if (Build.VERSION.SDK_INT >= 29) out.put("folder", text(c, "relative_path"));
        if (!kind.equals("image")) out.put("duration_ms", number(c, "duration"));
        if (!kind.equals("audio")) { out.put("width", number(c, "width")); out.put("height", number(c, "height")); }
        out.put("version", text(c, "_id") + ":" + number(c, "_size") + ":" + number(c, "date_modified"));
        return out;
    }

    @PluginMethod public void mediaList(PluginCall call) {
        String kind;
        try { kind = kind(call); } catch (Exception e) { call.reject(e.getMessage(), "invalid_args"); return; }
        read(call, kind, () -> {
            List<String> where = new ArrayList<>(), args = new ArrayList<>();
            // MediaStore dates use seconds; convert caller's millisecond filters explicitly.
            for (String key : new String[] { "after_ms", "before_ms" }) {
                Long ms = PhoneReadNumbers.optional(call.getData().opt(key), key);
                if (ms != null) { where.add("date_added" + (key.equals("after_ms") ? " >= ?" : " < ?")); args.add(Long.toString(PhoneReadNumbers.mediaSeconds(ms))); }
            }
            String before = call.getString("before_id");
            if (before != null) { if (!before.matches("[1-9][0-9]*")) throw new IllegalArgumentException("before_id 无效"); where.add("_id < ?"); args.add(before); }
            String query = call.getString("query");
            if (query != null && !query.isEmpty()) { where.add("_display_name LIKE ? ESCAPE '\\'"); args.add(like(query)); }
            JSArray rows = new JSArray(); String last = null; boolean more = false;
            try (Cursor c = getContext().getContentResolver().query(collection(kind), mediaColumns(kind), selection(where), args.toArray(new String[0]), "_id DESC")) {
                if (c == null) throw new IllegalStateException("媒体服务未返回查询结果");
                int max = limit(call);
                while (c.moveToNext()) {
                    if (rows.length() == max) { more = true; break; }
                    JSObject row = media(c, kind); rows.put(row); last = row.getString("id");
                }
            }
            JSObject out = new JSObject(); out.put("items", rows); out.put("next_before_id", more ? last : JSObject.NULL); out.put("access", state()); return out;
        });
    }

    @PluginMethod public void mediaRead(PluginCall call) {
        String kind;
        try { kind = kind(call); } catch (Exception e) { call.reject(e.getMessage(), "invalid_args"); return; }
        read(call, kind, () -> {
            Uri uri = ContentUris.withAppendedId(collection(kind), id(call));
            JSObject info;
            try (Cursor c = getContext().getContentResolver().query(uri, mediaColumns(kind), null, null, null)) {
                if (c == null || !c.moveToFirst()) throw new IllegalArgumentException("文件不存在或不在授权范围");
                info = media(c, kind);
            }
            String expected = call.getString("version");
            if (expected != null && !expected.equals(info.getString("version"))) throw new IllegalArgumentException("文件在读取期间发生变化,请重新查询并读取");
            Long requestedOffset = PhoneReadNumbers.optional(call.getData().opt("offset"), "offset");
            long offset = requestedOffset == null ? 0 : requestedOffset, total = info.getLong("size");
            if (offset < 0 || offset > total) throw new IllegalArgumentException("读取偏移超出文件范围");
            byte[] buffer = new byte[(int) Math.min(CHUNK_BYTES, total - offset)]; int got = 0;
            ParcelFileDescriptor fd = getContext().getContentResolver().openFileDescriptor(uri, "r");
            if (fd == null) throw new IllegalStateException("无法打开文件");
            try (ParcelFileDescriptor.AutoCloseInputStream in = new ParcelFileDescriptor.AutoCloseInputStream(fd)) {
                in.getChannel().position(offset);
                while (got < buffer.length) { int n = in.read(buffer, got, buffer.length - got); if (n < 0) throw new IllegalStateException("文件提前结束"); got += n; }
            }
            JSObject chunk = new JSObject(); chunk.put("offset", offset); chunk.put("total_size", total); chunk.put("version", info.getString("version"));
            chunk.put("name", info.getString("name")); chunk.put("mime_type", info.getString("mime_type"));
            chunk.put("data_base64", Base64.encodeToString(buffer, Base64.NO_WRAP)); chunk.put("eof", offset + got == total);
            JSObject out = new JSObject(); out.put("phone_file_chunk", chunk);
            if (offset == 0 && !kind.equals("audio")) {
              try {
                Bitmap preview = null;
                if (Build.VERSION.SDK_INT >= 29) preview = getContext().getContentResolver().loadThumbnail(uri, new Size(384, 384), null);
                else if (kind.equals("image")) {
                    BitmapFactory.Options opts = new BitmapFactory.Options(); opts.inJustDecodeBounds = true;
                    try (java.io.InputStream in = getContext().getContentResolver().openInputStream(uri)) { BitmapFactory.decodeStream(in, null, opts); }
                    opts.inSampleSize = Math.max(1, (Math.max(opts.outWidth, opts.outHeight) + 383) / 384); opts.inJustDecodeBounds = false;
                    try (java.io.InputStream in = getContext().getContentResolver().openInputStream(uri)) { preview = BitmapFactory.decodeStream(in, null, opts); }
                }
                if (preview != null) {
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream(); preview.compress(Bitmap.CompressFormat.JPEG, 65, bytes); preview.recycle();
                    JSObject picture = new JSObject(); picture.put("label", info.getString("name")); picture.put("mimeType", "image/jpeg"); picture.put("data", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
                    out.put("pictures", new JSArray().put(picture));
                }
              } catch (Exception error) { out.put("preview_error", "原文件可读,缩略图不可用:" + error.getMessage()); }
            }
            return out;
        });
    }
}
