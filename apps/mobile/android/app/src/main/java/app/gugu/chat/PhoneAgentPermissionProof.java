package app.gugu.chat;

import android.Manifest;
import android.app.NotificationManager;
import android.content.ContentUris;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import androidx.core.content.ContextCompat;
import androidx.core.location.LocationManagerCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.LinkedHashSet;
import java.util.Set;

/** A bounded description of the actual OS grants used by a raw read, checked again before delivery. */
final class PhoneAgentPermissionProof {
    static JSONObject capture(Context context, String plugin, String method, JSONObject args) throws Exception {
        Set<String> permissions = new LinkedHashSet<>();
        JSONArray media = new JSONArray();
        if ("GuguPhoneData".equals(plugin)) {
            if (method.startsWith("sms")) permissions.add(Manifest.permission.READ_SMS);
            if (method.startsWith("media")) {
                String kind = args.optString("kind", "audio");
                permissions.add(mediaPermission(context, kind));
                if ("mediaRead".equals(method)) media.put(mediaRef(kind, args.getString("id"), args.optString("version", null)));
            }
        } else if (method.startsWith("calendar")) {
            permissions.add(Manifest.permission.READ_CALENDAR);
            if (!"calendarList".equals(method)) permissions.add(Manifest.permission.WRITE_CALENDAR);
        } else if ("contactsList".equals(method)) permissions.add(Manifest.permission.READ_CONTACTS);
        else if ("notificationsList".equals(method)) permissions.add("@notification_listener");
        else if ("dndSet".equals(method)) permissions.add("@dnd_access");
        else if ("locationCurrent".equals(method)) {
            permissions.add(has(context, Manifest.permission.ACCESS_FINE_LOCATION) ? Manifest.permission.ACCESS_FINE_LOCATION : Manifest.permission.ACCESS_COARSE_LOCATION);
            permissions.add("@location_enabled");
            if (GuguAgentPlugin.foregroundActivity() == null && Build.VERSION.SDK_INT >= 29) permissions.add(Manifest.permission.ACCESS_BACKGROUND_LOCATION);
        } else if (method.startsWith("health") && !"healthStatus".equals(method)) {
            permissions.add("@health_connect");
            if ("healthSleep".equals(method)) permissions.add(HealthTypes.PERMISSIONS.get("sleep"));
            else if ("healthHeartRate".equals(method)) permissions.add(HealthTypes.PERMISSIONS.get("heart_rate"));
            else if ("healthSamples".equals(method)) {
                String type = args.optString("type");
                if (!HealthTypes.isSampleType(type)) throw new PhoneNativeCall.Failure("invalid_args", "不认识的健康读数类别");
                permissions.add(HealthTypes.PERMISSIONS.get(type));
            } else {
                if ("healthExercise".equals(method)) permissions.add(HealthTypes.PERMISSIONS.get("exercise"));
                for (String type : new String[] {"steps", "distance", "active_calories", "heart_rate", "resting_heart_rate", "exercise"}) {
                    if ("healthExercise".equals(method) && "resting_heart_rate".equals(type)) continue;
                    String permission = HealthTypes.PERMISSIONS.get(type);
                    if (has(context, permission)) permissions.add(permission);
                }
            }
            if (GuguAgentPlugin.foregroundActivity() == null && Build.VERSION.SDK_INT >= 35) permissions.add(HealthTypes.BACKGROUND);
        }
        return new JSONObject().put("permissions", new JSONArray(permissions)).put("mediaRefs", media);
    }

    static void addReturnedMedia(JSONObject proof, String plugin, String method, JSONObject args, JSONObject data) throws Exception {
        if (!"GuguPhoneData".equals(plugin) || !method.startsWith("media")) return;
        JSONArray refs = new JSONArray();
        String kind = args.optString("kind", "audio");
        if ("mediaList".equals(method)) {
            JSONArray items = data.getJSONArray("items");
            for (int index = 0; index < items.length(); index++) {
                JSONObject item = items.getJSONObject(index);
                refs.put(mediaRef(kind, item.getString("id"), item.optString("version", null)));
            }
        } else {
            JSONObject chunk = data.getJSONObject("phone_file_chunk");
            refs.put(mediaRef(kind, args.getString("id"), chunk.optString("version", null)));
        }
        proof.put("mediaRefs", refs);
    }

    static void check(Context context, JSONObject proof) throws Exception {
        JSONArray permissions = proof.optJSONArray("permissions");
        if (permissions == null || permissions.length() > 32) throw new PhoneNativeCall.Failure("invalid_args", "手机权限凭据无效");
        for (int index = 0; index < permissions.length(); index++) checkPermission(context, permissions.getString(index));
        JSONArray refs = proof.optJSONArray("mediaRefs");
        if (refs == null || refs.length() > 100) throw new PhoneNativeCall.Failure("invalid_args", "手机媒体授权凭据无效");
        for (int index = 0; index < refs.length(); index++) checkMedia(context, refs.getJSONObject(index));
    }

    static void checkPermission(Context context, String permission) {
        switch (permission) {
            case "@notification_listener": if (!GuguNotificationListener.isEnabled(context)) throw new SecurityException("系统已撤销通知使用权"); return;
            case "@dnd_access": {
                NotificationManager manager = context.getSystemService(NotificationManager.class);
                if (manager == null || !manager.isNotificationPolicyAccessGranted()) throw new SecurityException("系统已撤销勿扰权限");
                return;
            }
            case "@location_enabled": {
                LocationManager manager = context.getSystemService(LocationManager.class);
                if (manager == null || !LocationManagerCompat.isLocationEnabled(manager)) throw new SecurityException("手机的定位总开关已关闭");
                return;
            }
            case "@health_connect": if (!GuguHealthConnect.supported(context)) throw new PhoneNativeCall.Failure("unavailable", "这台手机没有 Health Connect(要安卓 14 及以上)"); return;
            default:
                if (!allowed(permission)) throw new PhoneNativeCall.Failure("invalid_args", "未登记的手机权限类别");
                if (!has(context, permission)) throw new SecurityException("系统已撤销本次数据使用的读取权限: " + permission);
        }
    }

    private static boolean allowed(String permission) {
        return HealthTypes.PERMISSIONS.containsValue(permission) || HealthTypes.BACKGROUND.equals(permission)
            || Manifest.permission.READ_CALENDAR.equals(permission) || Manifest.permission.WRITE_CALENDAR.equals(permission)
            || Manifest.permission.READ_CONTACTS.equals(permission) || Manifest.permission.READ_SMS.equals(permission)
            || Manifest.permission.ACCESS_FINE_LOCATION.equals(permission) || Manifest.permission.ACCESS_COARSE_LOCATION.equals(permission)
            || Manifest.permission.ACCESS_BACKGROUND_LOCATION.equals(permission) || Manifest.permission.READ_EXTERNAL_STORAGE.equals(permission)
            || "android.permission.READ_MEDIA_AUDIO".equals(permission) || "android.permission.READ_MEDIA_IMAGES".equals(permission)
            || "android.permission.READ_MEDIA_VIDEO".equals(permission) || "android.permission.READ_MEDIA_VISUAL_USER_SELECTED".equals(permission);
    }
    private static boolean has(Context context, String permission) { return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED; }
    private static String mediaPermission(Context context, String kind) {
        if (!"audio".equals(kind) && !"image".equals(kind) && !"video".equals(kind)) throw new PhoneNativeCall.Failure("invalid_args", "媒体类别无效");
        if (Build.VERSION.SDK_INT < 33) return Manifest.permission.READ_EXTERNAL_STORAGE;
        String permission = "audio".equals(kind) ? "android.permission.READ_MEDIA_AUDIO" : "image".equals(kind) ? "android.permission.READ_MEDIA_IMAGES" : "android.permission.READ_MEDIA_VIDEO";
        return !"audio".equals(kind) && !has(context, permission) && Build.VERSION.SDK_INT >= 34 && has(context, "android.permission.READ_MEDIA_VISUAL_USER_SELECTED")
            ? "android.permission.READ_MEDIA_VISUAL_USER_SELECTED" : permission;
    }
    private static JSONObject mediaRef(String kind, String id, String version) throws Exception {
        JSONObject ref = new JSONObject().put("kind", kind).put("id", id);
        if (version != null) ref.put("version", version);
        return ref;
    }
    private static void checkMedia(Context context, JSONObject ref) throws Exception {
        String kind = ref.getString("kind"), id = ref.getString("id");
        if (id.length() > 16 || !id.matches("[1-9][0-9]*") || new java.math.BigInteger(id).compareTo(java.math.BigInteger.valueOf(9007199254740991L)) > 0)
            throw new PhoneNativeCall.Failure("invalid_args", "媒体编号必须是系统列表返回的数字");
        Uri collection;
        if ("audio".equals(kind)) collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        else if ("image".equals(kind)) collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
        else if ("video".equals(kind)) collection = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
        else throw new PhoneNativeCall.Failure("invalid_args", "媒体类别无效");
        Uri uri = ContentUris.withAppendedId(collection, Long.parseLong(id));
        try (Cursor cursor = context.getContentResolver().query(uri, new String[] {"_id", "_size", "date_modified"}, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) throw new SecurityException("文件已删除或不在当前相册授权范围");
            String version = cursor.getString(0) + ":" + cursor.getLong(1) + ":" + cursor.getLong(2);
            if (ref.has("version") && !version.equals(ref.getString("version"))) throw new PhoneNativeCall.Failure("revoked", "文件在读取或交付期间发生变化，请重新读取");
        }
    }
}
