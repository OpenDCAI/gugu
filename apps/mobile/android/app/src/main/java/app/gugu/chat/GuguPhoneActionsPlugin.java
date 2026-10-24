package app.gugu.chat;

import android.Manifest;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.ContentProviderOperation;
import android.content.ContentProviderResult;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.location.Address;
import android.location.Geocoder;
import android.location.Location;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.provider.AlarmClock;
import android.provider.CalendarContract;
import android.provider.Settings;

import androidx.core.content.ContextCompat;
import androidx.core.location.LocationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.time.Instant;
import java.time.LocalDate;

/**
 * #7199 手机当设备:云电脑上的助理调这台手机上的「单个动作」—— 查 / 建 / 改 / 删日程、读通讯录、取定位、读通知、开关勿扰、设闹钟与倒计时。
 * 这里只管**真去做**这一件事和它要的系统权限;收发规矩(设备 RPC、收到 / 进度 / 结果)、咕咕里按组的授权、最近调用都在网页那一侧
 * (apps/desktop/src/mobile/phone-device)。每个方法失败时 reject 带一个码,网页那侧照协议翻成结果码:
 *   os_permission   系统权限没给(或系统设置里没打开:通知使用权、勿扰权限、定位总开关)
 *   invalid_args    参数不对
 *   needs_foreground 要咕咕在前台才做得了(设闹钟 / 倒计时:安卓不许后台的 App 拉起闹钟)
 *   unavailable     这台手机上做不了(没有能写的日历账户、没有闹钟 App……)
 *   failed          执行失败(原因在 message 里)
 * 定位用系统的 LocationManager,❌ 谷歌的 Fused Location:国内手机大多没有谷歌服务。
 * 健康读 Health Connect(安卓 14 起系统自带,见 GuguHealthConnect);更早的安卓 reject unavailable。
 */
@CapacitorPlugin(
    name = "GuguPhoneActions",
    permissions = {
        @Permission(alias = "calendar", strings = { Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR }),
        @Permission(alias = "contacts", strings = { Manifest.permission.READ_CONTACTS }),
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }),
        // 安卓 12 起系统框里能只给「大致位置」:那时上面的别名不算 granted(要两样都给),但「我在哪」用大致位置就够,单独认一下。
        @Permission(alias = "coarseLocation", strings = { Manifest.permission.ACCESS_COARSE_LOCATION }),
        // 健康:Health Connect 的读权限(安卓 14 起是系统运行时权限,系统弹的是 Health Connect 自己那一页,用户可以只给其中几类)。
        // 字面量与 HealthTypes.PERMISSIONS 同值:注解里只能写常量。
        @Permission(alias = "health", strings = {
            "android.permission.health.READ_STEPS",
            "android.permission.health.READ_DISTANCE",
            "android.permission.health.READ_ACTIVE_CALORIES_BURNED",
            "android.permission.health.READ_HEART_RATE",
            "android.permission.health.READ_RESTING_HEART_RATE",
            "android.permission.health.READ_HEART_RATE_VARIABILITY",
            "android.permission.health.READ_SLEEP",
            "android.permission.health.READ_EXERCISE",
            "android.permission.health.READ_OXYGEN_SATURATION",
            "android.permission.health.READ_RESPIRATORY_RATE",
            "android.permission.health.READ_WEIGHT",
            "android.permission.health.READ_BODY_FAT",
        }),
        @Permission(alias = "healthBackground", strings = { HealthTypes.BACKGROUND }),
    }
)
public class GuguPhoneActionsPlugin extends Plugin {
    private static final long RECENT_FIX_MS = 2 * 60_000L;
    private static final long GEOCODE_TIMEOUT_MS = 3_000L;
    private volatile boolean foreground = false;

    @Override
    public void load() {
        foreground = getActivity() != null && getActivity().hasWindowFocus();
    }

    @Override
    protected void handleOnResume() {
        foreground = true;
    }

    @Override
    protected void handleOnPause() {
        foreground = false;
    }

    // ── 这台手机是什么 ─────────────────────────────────────────────────────────

    @PluginMethod
    public void deviceInfo(PluginCall call) {
        PhoneInstallationIdentity.Identity installation;
        try { installation = GuguPhoneInstallation.identity(getContext()); }
        catch (RuntimeException error) { call.reject("无法验证这次手机安装，请重试", "failed"); return; }
        JSObject out = new JSObject();
        out.put("manufacturer", Build.MANUFACTURER);
        out.put("brand", Build.BRAND);
        out.put("model", Build.MODEL);
        out.put("android", Build.VERSION.RELEASE);
        out.put("sdk", Build.VERSION.SDK_INT);
        out.put("rom", romName());
        // 用户在系统「关于手机」里看到 / 改过的名字(如「Redmi K70」);Build.MODEL 常是 23127PN0CC 这类型号代码。
        String deviceName = Build.VERSION.SDK_INT >= Build.VERSION_CODES.N_MR1
            ? Settings.Global.getString(getContext().getContentResolver(), Settings.Global.DEVICE_NAME)
            : null;
        out.put("device_name", deviceName == null || deviceName.trim().isEmpty() ? JSObject.NULL : deviceName.trim());
        try {
            out.put("app_version", getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName);
        } catch (PackageManager.NameNotFoundException error) {
            out.put("app_version", JSObject.NULL);
        }
        out.put("package", getContext().getPackageName());
        out.put("install_key", installation.key);
        if (installation.previousKey != null) out.put("previous_install_key", installation.previousKey);
        call.resolve(out);
    }

    /** 厂商系统名与版本(权限引导、后台常驻的说法各家不同);读不到 = null。 */
    private static String romName() {
        String[][] keys = {
            { "ro.mi.os.version.name", "HyperOS" },
            { "ro.miui.ui.version.name", "MIUI" },
            { "hw_sc.build.platform.version", "HarmonyOS" },
            { "ro.build.version.emui", "EMUI" },
            { "ro.build.version.magic", "MagicOS" },
            { "ro.build.version.opporom", "ColorOS" },
            { "ro.vivo.os.version", "OriginOS" },
        };
        for (String[] key : keys) {
            String value = systemProperty(key[0]);
            if (value != null && !value.isEmpty()) return key[1] + " " + value;
        }
        return null;
    }

    private static String systemProperty(String key) {
        try {
            Class<?> props = Class.forName("android.os.SystemProperties");
            return (String) props.getMethod("get", String.class).invoke(null, key);
        } catch (Exception error) {
            return null;
        }
    }

    // ── 权限:运行时权限走 Capacitor 自带的 checkPermissions / requestPermissions(上面三个别名);
    //    下面是那几样要去系统设置里开的 ──────────────────────────────────────────────

    @PluginMethod
    public void specialStatus(PluginCall call) {
        Context context = getContext();
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        LocationManager lm = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        JSObject out = new JSObject();
        out.put("notification_listener", GuguNotificationListener.isEnabled(context));
        out.put("dnd_access", nm != null && nm.isNotificationPolicyAccessGranted());
        out.put("location_enabled", lm != null && LocationManagerCompat.isLocationEnabled(lm));
        out.put("background_location", Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED);
        out.put("alarm_app", resolves(new Intent(AlarmClock.ACTION_SET_ALARM)));
        out.put("foreground", foreground);
        call.resolve(out);
    }

    /** 网页侧「通知与勿扰」这一组连上 / 断开时调:只在连着时记下新通知,断开当场清空(GuguNotificationListener.setCollecting)。 */
    @PluginMethod
    public void setNotificationCollecting(PluginCall call) {
        GuguNotificationListener.setCollecting(Boolean.TRUE.equals(call.getBoolean("on", false)));
        call.resolve();
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        String target = call.getString("target", "app");
        Context context = getContext();
        Intent intent;
        switch (target) {
            case "notification_listener":
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS);
                    intent.putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
                        new ComponentName(context, GuguNotificationListener.class).flattenToString());
                    if (!resolves(intent)) intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
                } else {
                    intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
                }
                break;
            case "dnd":
                intent = new Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS);
                break;
            case "location":
                intent = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
                break;
            case "health":
                // Health Connect 里咕咕那一页(拒过两次系统就不再弹框,只能去这里开)。
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    intent = new Intent(android.health.connect.HealthConnectManager.ACTION_MANAGE_HEALTH_PERMISSIONS);
                    intent.putExtra(Intent.EXTRA_PACKAGE_NAME, context.getPackageName());
                    if (!resolves(intent)) intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.getPackageName()));
                } else {
                    intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.getPackageName()));
                }
                break;
            case "app":
            default:
                intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.getPackageName()));
                break;
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("没能打开系统设置:" + error.getMessage(), "failed");
        }
    }

    private boolean resolves(Intent intent) {
        return intent.resolveActivity(getContext().getPackageManager()) != null;
    }

    private boolean granted(String alias) {
        return getPermissionState(alias) == PermissionState.GRANTED;
    }

    // ── 日历 ─────────────────────────────────────────────────────────────────

    @PluginMethod
    public void calendarList(PluginCall call) {
        if (!granted("calendar")) { call.reject("没有日历权限", "os_permission"); return; }
        Long start = call.getLong("start_ms");
        Long end = call.getLong("end_ms");
        if (start == null || end == null || end <= start) { call.reject("start_ms / end_ms 不对", "invalid_args"); return; }
        int limit = clamp(call.getInt("limit", 100), 1, 500);
        try {
            call.resolve(PhoneCalendarReader.read(getContext(), start, end, limit));
        } catch (SecurityException error) {
            call.reject("没有日历权限", "os_permission");
        } catch (RuntimeException error) {
            call.reject("读日历失败:" + error.getMessage(), "failed");
        }
    }

    @PluginMethod
    public void calendarCreate(PluginCall call) {
        if (!granted("calendar")) { call.reject("没有日历权限", "os_permission"); return; }
        String title = call.getString("title");
        Long start = call.getLong("start_ms");
        Long end = call.getLong("end_ms");
        boolean allDay = Boolean.TRUE.equals(call.getBoolean("all_day", false));
        if (title == null || title.trim().isEmpty() || start == null) { call.reject("要有 title 和 start_ms", "invalid_args"); return; }
        if (end == null) end = start + (allDay ? 24L * 3600_000L : 3600_000L);
        if (end <= start) { call.reject("end_ms 要晚于 start_ms", "invalid_args"); return; }
        ContentResolver cr = getContext().getContentResolver();
        try {
            Long calendarId = writableCalendar(cr, call.getString("calendar_id"));
            if (calendarId == null) { call.reject("这台手机上没有能写的日历账户", "unavailable"); return; }
            ContentValues v = new ContentValues();
            v.put(CalendarContract.Events.CALENDAR_ID, calendarId);
            v.put(CalendarContract.Events.TITLE, title.trim());
            v.put(CalendarContract.Events.DTSTART, start);
            v.put(CalendarContract.Events.DTEND, end);
            v.put(CalendarContract.Events.ALL_DAY, allDay ? 1 : 0);
            v.put(CalendarContract.Events.EVENT_TIMEZONE, allDay ? "UTC" : TimeZone.getDefault().getID());
            String location = call.getString("location");
            if (location != null) v.put(CalendarContract.Events.EVENT_LOCATION, location);
            String description = call.getString("description");
            if (description != null) v.put(CalendarContract.Events.DESCRIPTION, description);
            ArrayList<ContentProviderOperation> operations = new ArrayList<>();
            Integer reminder = call.getInt("reminder_minutes");
            if (reminder != null && reminder >= 0) {
                v.put(CalendarContract.Events.HAS_ALARM, 1);
            }
            operations.add(ContentProviderOperation.newInsert(CalendarContract.Events.CONTENT_URI).withValues(v).build());
            if (reminder != null && reminder >= 0) operations.add(ContentProviderOperation.newInsert(CalendarContract.Reminders.CONTENT_URI)
                .withValueBackReference(CalendarContract.Reminders.EVENT_ID, 0).withValue(CalendarContract.Reminders.MINUTES, reminder)
                .withValue(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT).build());
            ContentProviderResult[] inserted = cr.applyBatch(CalendarContract.AUTHORITY, operations);
            if (inserted.length == 0 || inserted[0].uri == null) { call.reject("日历没接受这条日程", "failed"); return; }
            long eventId = ContentUris.parseId(inserted[0].uri);
            JSObject out = new JSObject();
            out.put("event_id", String.valueOf(eventId));
            out.put("calendar_id", String.valueOf(calendarId));
            call.resolve(out);
        } catch (SecurityException error) {
            call.reject("没有日历权限", "os_permission");
        } catch (Exception error) {
            call.reject("建日程失败:" + error.getMessage(), "failed");
        }
    }

    @PluginMethod
    public void calendarUpdate(PluginCall call) {
        if (!granted("calendar")) { call.reject("没有日历权限", "os_permission"); return; }
        Long eventId = parseId(call.getString("event_id"));
        if (eventId == null) { call.reject("要有 event_id", "invalid_args"); return; }
        ContentValues v = new ContentValues();
        String title = call.getString("title");
        if (title != null) v.put(CalendarContract.Events.TITLE, title);
        Long start = call.getLong("start_ms");
        if (start != null) v.put(CalendarContract.Events.DTSTART, start);
        Long end = call.getLong("end_ms");
        if (end != null) v.put(CalendarContract.Events.DTEND, end);
        String location = call.getString("location");
        if (location != null) v.put(CalendarContract.Events.EVENT_LOCATION, location);
        String description = call.getString("description");
        if (description != null) v.put(CalendarContract.Events.DESCRIPTION, description);
        if (v.size() == 0) { call.reject("没有要改的字段", "invalid_args"); return; }
        try {
            try (Cursor existing = getContext().getContentResolver().query(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId),
                new String[] {CalendarContract.Events.DTSTART, CalendarContract.Events.DTEND}, null, null, null)) {
                if (existing == null) throw new IllegalStateException("日历服务未返回这条日程");
                if (!existing.moveToFirst()) { call.reject("没找到这条日程", "invalid_args"); return; }
                long effectiveStart = start == null ? existing.getLong(0) : start;
                Long effectiveEnd = end == null ? (existing.isNull(1) ? null : existing.getLong(1)) : end;
                if (effectiveEnd != null && effectiveEnd <= effectiveStart) { call.reject("改后的结束时间要晚于开始时间", "invalid_args"); return; }
            }
            int n = getContext().getContentResolver().update(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId), v, null, null);
            if (n == 0) { call.reject("没找到这条日程", "invalid_args"); return; }
            JSObject out = new JSObject();
            out.put("event_id", String.valueOf(eventId));
            call.resolve(out);
        } catch (SecurityException error) {
            call.reject("没有日历权限", "os_permission");
        } catch (RuntimeException error) {
            call.reject("改日程失败:" + error.getMessage(), "failed");
        }
    }

    @PluginMethod
    public void calendarDelete(PluginCall call) {
        if (!granted("calendar")) { call.reject("没有日历权限", "os_permission"); return; }
        Long eventId = parseId(call.getString("event_id"));
        if (eventId == null) { call.reject("要有 event_id", "invalid_args"); return; }
        try {
            int n = getContext().getContentResolver().delete(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId), null, null);
            if (n == 0) { call.reject("没找到这条日程", "invalid_args"); return; }
            JSObject out = new JSObject();
            out.put("event_id", String.valueOf(eventId));
            call.resolve(out);
        } catch (SecurityException error) {
            call.reject("没有日历权限", "os_permission");
        } catch (RuntimeException error) {
            call.reject("删日程失败:" + error.getMessage(), "failed");
        }
    }

    /** 指定的那本(要能写),否则挑主日历,再否则第一本能写的;一本都没有 = null。 */
    private static Long writableCalendar(ContentResolver cr, String wanted) {
        String[] projection = { CalendarContract.Calendars._ID, CalendarContract.Calendars.IS_PRIMARY };
        String selection = CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL + ">=" + CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR
            + " AND " + CalendarContract.Calendars.VISIBLE + "=1";
        Long first = null;
        Long primary = null;
        try (Cursor c = cr.query(CalendarContract.Calendars.CONTENT_URI, projection, selection, null, null)) {
            if (c == null) throw new IllegalStateException("日历服务未返回账户列表");
            while (c.moveToNext()) {
                long id = c.getLong(0);
                if (wanted != null && wanted.equals(String.valueOf(id))) return id;
                if (first == null) first = id;
                if (primary == null && c.getInt(1) == 1) primary = id;
            }
        }
        if (wanted != null) return null;
        return primary != null ? primary : first;
    }

    // ── 通讯录 ───────────────────────────────────────────────────────────────

    @PluginMethod
    public void contactsList(PluginCall call) {
        if (!granted("contacts")) { call.reject("没有通讯录权限", "os_permission"); return; }
        try {
            call.resolve(PhoneContactsReader.read(getContext(), call.getString("query"), clamp(call.getInt("limit", 50), 1, 500)));
        } catch (SecurityException error) {
            call.reject("没有通讯录权限", "os_permission");
        } catch (RuntimeException error) {
            call.reject("读通讯录失败:" + error.getMessage(), "failed");
        }
    }

    // ── 定位 ─────────────────────────────────────────────────────────────────

    @PluginMethod
    public void locationCurrent(PluginCall call) {
        boolean precise = granted("location");
        if (!precise && !granted("coarseLocation")) { call.reject("没有定位权限", "os_permission"); return; }
        Context context = getContext();
        LocationManager lm = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        if (lm == null || !LocationManagerCompat.isLocationEnabled(lm)) { call.reject("手机的定位总开关没开", "os_permission"); return; }
        // 安卓 10 起:咕咕在后台(「后台守着」那条常驻通知的服务类型不是定位)时,只有「始终允许」才拿得到位置。
        if (!foreground && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            && ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            call.reject("咕咕在后台时取不到定位:要在系统设置里把咕咕的定位权限改成「始终允许」", "os_permission");
            return;
        }
        int timeoutMs = clamp(call.getInt("timeout_ms", 15000), 2000, 60000);
        List<String> providers = new ArrayList<>();
        for (String p : new String[] { "fused", LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER }) {
            // 只给了大致位置:GPS 要精确定位权限,调了会抛 SecurityException,❌ 因此整次判成「没有定位权限」。
            if (!precise && LocationManager.GPS_PROVIDER.equals(p)) continue;
            try {
                if (lm.isProviderEnabled(p)) providers.add(p);
            } catch (RuntimeException ignored) {
                // 这台手机没有这个来源
            }
        }
        if (providers.isEmpty()) { call.reject("手机上没有可用的定位来源", "unavailable"); return; }
        // 系统 2 分钟内刚定过位就直接用(「我在哪」不需要秒级新鲜),❌ 每次都现取:现取常要十几秒(GPS 冷启动、室内)。
        Location recent = lastKnown(lm, providers);
        if (recent != null && System.currentTimeMillis() - recent.getTime() < RECENT_FIX_MS) {
            resolveLocationAsync(call, recent, true);
            return;
        }
        AtomicBoolean done = new AtomicBoolean(false);
        List<CancellationSignal> signals = new ArrayList<>();
        Handler main = new Handler(Looper.getMainLooper());
        Runnable giveUp = () -> {
            if (!done.compareAndSet(false, true)) return;
            for (CancellationSignal s : signals) s.cancel();
            // 现取没取到:退到系统记着的最近一次(10 分钟内),并说清它多旧。
            Location last = lastKnown(lm, providers);
            if (last != null && System.currentTimeMillis() - last.getTime() < 10 * 60_000L) {
                resolveLocationAsync(call, last, true);
            } else {
                call.reject(timeoutMs / 1000 + " 秒内没取到位置(室内或信号差时常见)", "failed");
            }
        };
        main.postDelayed(giveUp, timeoutMs);
        for (String provider : providers) {
            CancellationSignal signal = new CancellationSignal();
            signals.add(signal);
            try {
                LocationManagerCompat.getCurrentLocation(lm, provider, signal, ContextCompat.getMainExecutor(context), location -> {
                    if (location == null || !done.compareAndSet(false, true)) return;
                    main.removeCallbacks(giveUp);
                    for (CancellationSignal s : signals) s.cancel();
                    resolveLocationAsync(call, location, false);
                });
            } catch (SecurityException error) {
                // 这个来源要的权限没给(例如只给了大致位置):跳过它,等别的来源。
                signals.remove(signal);
            } catch (RuntimeException ignored) {
                // 这个来源不给,等别的
            }
        }
        // 一个来源都没起来(都缺权限):当场说没权限,❌ 干等到超时。
        if (signals.isEmpty() && done.compareAndSet(false, true)) {
            main.removeCallbacks(giveUp);
            call.reject("没有定位权限", "os_permission");
        }
    }

    private static Location lastKnown(LocationManager lm, List<String> providers) {
        Location best = null;
        for (String p : providers) {
            try {
                Location l = lm.getLastKnownLocation(p);
                if (l != null && (best == null || l.getTime() > best.getTime())) best = l;
            } catch (SecurityException | IllegalArgumentException ignored) {
                // 拿不到就跳过
            }
        }
        return best;
    }

    /** 反查地址会走网络,❌ 放在主线程(会卡住整个界面)。 */
    private void resolveLocationAsync(PluginCall call, Location location, boolean cached) {
        new Thread(() -> resolveLocation(call, location, cached)).start();
    }

    private void resolveLocation(PluginCall call, Location location, boolean cached) {
        JSObject out = new JSObject();
        out.put("latitude", location.getLatitude());
        out.put("longitude", location.getLongitude());
        out.put("accuracy_m", location.hasAccuracy() ? Math.round(location.getAccuracy()) : JSObject.NULL);
        out.put("provider", location.getProvider());
        out.put("fixed_at_ms", location.getTime());
        out.put("cached", cached);
        out.put("coordinate_system", "WGS84");
        out.put("address", reverseGeocode(location));
        call.resolve(out);
    }

    /**
     * 系统自带的反查地址(国内手机常常没有这项服务);查不到 = null,助理拿经纬度自己说。
     * 最多等 3 秒:这项服务走网络,慢的时候能拖十几秒(模拟器实测),❌ 让「我在哪」跟着等。
     */
    @SuppressWarnings("deprecation")
    private Object reverseGeocode(Location location) {
        if (!Geocoder.isPresent()) return JSObject.NULL;
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            Future<String> lookup = executor.submit(() -> {
                List<Address> found = new Geocoder(getContext(), Locale.getDefault()).getFromLocation(location.getLatitude(), location.getLongitude(), 1);
                if (found == null || found.isEmpty()) return null;
                Address a = found.get(0);
                return a.getMaxAddressLineIndex() >= 0 ? a.getAddressLine(0) : null;
            });
            String line = lookup.get(GEOCODE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            return line == null ? JSObject.NULL : line;
        } catch (Exception error) {
            return JSObject.NULL;
        } finally {
            executor.shutdownNow();
        }
    }

    // ── 通知与勿扰 ───────────────────────────────────────────────────────────

    @PluginMethod
    public void notificationsList(PluginCall call) {
        try { call.resolve(PhoneNotificationsReader.read(getContext(), clamp(call.getInt("limit", 50), 1, GuguNotificationListener.RECENT_LIMIT))); }
        catch (SecurityException error) { call.reject(error.getMessage(), "os_permission"); }
        catch (RuntimeException error) { call.reject(error.getMessage(), "failed"); }
    }

    @PluginMethod
    public void dndSet(PluginCall call) {
        NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || !nm.isNotificationPolicyAccessGranted()) { call.reject("没给咕咕「勿扰权限」", "os_permission"); return; }
        String mode = call.getString("mode");
        int filter;
        if ("off".equals(mode)) filter = NotificationManager.INTERRUPTION_FILTER_ALL;
        else if ("priority".equals(mode)) filter = NotificationManager.INTERRUPTION_FILTER_PRIORITY;
        else if ("alarms".equals(mode)) filter = NotificationManager.INTERRUPTION_FILTER_ALARMS;
        else if ("silent".equals(mode)) filter = NotificationManager.INTERRUPTION_FILTER_NONE;
        else { call.reject("mode 只能是 off / priority / alarms / silent", "invalid_args"); return; }
        try {
            String before = dndModeName(nm.getCurrentInterruptionFilter());
            nm.setInterruptionFilter(filter);
            JSObject out = new JSObject();
            out.put("before", before);
            out.put("mode", dndModeName(nm.getCurrentInterruptionFilter()));
            call.resolve(out);
        } catch (SecurityException error) {
            call.reject("没给咕咕「勿扰权限」", "os_permission");
        } catch (RuntimeException error) {
            call.reject("改勿扰失败:" + error.getMessage(), "failed");
        }
    }

    private static String dndModeName(int filter) {
        switch (filter) {
            case NotificationManager.INTERRUPTION_FILTER_PRIORITY: return "priority";
            case NotificationManager.INTERRUPTION_FILTER_ALARMS: return "alarms";
            case NotificationManager.INTERRUPTION_FILTER_NONE: return "silent";
            default: return "off";
        }
    }

    // ── 闹钟与倒计时 ─────────────────────────────────────────────────────────

    @PluginMethod
    public void alarmSet(PluginCall call) {
        Integer hour = call.getInt("hour");
        Integer minute = call.getInt("minute");
        if (hour == null || minute == null || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
            call.reject("hour 要在 0–23、minute 要在 0–59", "invalid_args");
            return;
        }
        Intent intent = new Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, hour)
            .putExtra(AlarmClock.EXTRA_MINUTES, minute)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true);
        String label = call.getString("label");
        if (label != null) intent.putExtra(AlarmClock.EXTRA_MESSAGE, label);
        launchClock(call, intent, "闹钟");
    }

    @PluginMethod
    public void timerStart(PluginCall call) {
        Integer seconds = call.getInt("seconds");
        if (seconds == null || seconds < 1 || seconds > 86400) { call.reject("seconds 要在 1–86400", "invalid_args"); return; }
        Intent intent = new Intent(AlarmClock.ACTION_SET_TIMER)
            .putExtra(AlarmClock.EXTRA_LENGTH, seconds)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true);
        String label = call.getString("label");
        if (label != null) intent.putExtra(AlarmClock.EXTRA_MESSAGE, label);
        launchClock(call, intent, "倒计时");
    }

    private void launchClock(PluginCall call, Intent intent, String what) {
        if (!resolves(intent)) { call.reject("这台手机上没有能设" + what + "的时钟 App", "unavailable"); return; }
        if (!foreground || getActivity() == null) {
            call.reject("设" + what + "要咕咕在前台:安卓不许后台的 App 拉起时钟", "needs_foreground");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startActivity(intent);
                call.resolve(new JSObject());
            } catch (RuntimeException error) {
                call.reject("设" + what + "失败:" + error.getMessage(), "failed");
            }
        });
    }

    // ── 健康(Health Connect,只读)───────────────────────────────────────────

    private final ExecutorService healthExecutor = Executors.newSingleThreadExecutor();
    void closeReadExecutor() { healthExecutor.shutdownNow(); }
    @Override protected void handleOnDestroy() { closeReadExecutor(); }

    @PluginMethod
    public void healthStatus(PluginCall call) {
        if (!GuguHealthConnect.supported(getContext())) {
            JSObject out = new JSObject();
            out.put("supported", false);
            out.put("granted_types", new JSArray());
            out.put("background_supported", false);
            out.put("background_granted", false);
            call.resolve(out);
            return;
        }
        call.resolve(new GuguHealthConnect(getContext()).status());
    }

    /** 弹 Health Connect 的授权页(各类 + 安卓 15 起的「在后台读取」),回来后交这台手机此刻给了哪几类。 */
    @PluginMethod
    public void healthRequest(PluginCall call) {
        if (!GuguHealthConnect.supported(getContext())) { call.reject("这台手机没有 Health Connect(要安卓 14 及以上)", "unavailable"); return; }
        String[] aliases = GuguHealthConnect.backgroundSupported() ? new String[] { "health", "healthBackground" } : new String[] { "health" };
        requestPermissionForAliases(aliases, call, "healthPermissionsDone");
    }

    @PermissionCallback
    private void healthPermissionsDone(PluginCall call) {
        call.resolve(new GuguHealthConnect(getContext()).status());
    }

    private interface HealthRead {
        Object read(GuguHealthConnect health) throws GuguHealthConnect.Failure;
    }

    /** 读都放到自己那条线程上(要同步等系统回话,❌ 堵住插件线程上别的调用)。 */
    private void healthRun(PluginCall call, String key, HealthRead read) {
        if (!GuguHealthConnect.supported(getContext())) { call.reject("这台手机没有 Health Connect(要安卓 14 及以上)", "unavailable"); return; }
        healthExecutor.execute(() -> {
            try {
                Object value = read.read(new GuguHealthConnect(getContext()));
                if (value instanceof JSObject && key == null) { call.resolve((JSObject) value); return; }
                JSObject out = new JSObject();
                out.put(key, value);
                out.put("timezone", TimeZone.getDefault().getID());
                call.resolve(out);
            } catch (GuguHealthConnect.Failure failure) {
                call.reject(failure.getMessage(), failure.code);
            } catch (RuntimeException error) {
                GuguHealthConnect.Failure failure = GuguHealthConnect.translate(error);
                call.reject(failure.getMessage(), failure.code);
            }
        });
    }

    /** start_date(YYYY-MM-DD,手机本地)起 days 天,每天一格合计。 */
    @PluginMethod
    public void healthDaily(PluginCall call) {
        String startDate = call.getString("start_date");
        int days = clamp(call.getInt("days", 7), 1, HealthTypes.MAX_DAYS);
        LocalDate parsed;
        try {
            parsed = LocalDate.parse(startDate == null ? "" : startDate);
        } catch (RuntimeException error) {
            call.reject("start_date 要是 YYYY-MM-DD", "invalid_args");
            return;
        }
        final LocalDate start = parsed;
        healthRun(call, null, (health) -> health.daily(start.atStartOfDay(), days));
    }

    @PluginMethod
    public void healthSleep(PluginCall call) {
        Long start = call.getLong("start_ms");
        Long end = call.getLong("end_ms");
        if (!HealthTypes.validWindow(start, end)) { call.reject("start_ms / end_ms 不对(最多 31 天)", "invalid_args"); return; }
        healthRun(call, "sessions", (health) -> health.sleep(Instant.ofEpochMilli(start), Instant.ofEpochMilli(end)));
    }

    @PluginMethod
    public void healthExercise(PluginCall call) {
        Long start = call.getLong("start_ms");
        Long end = call.getLong("end_ms");
        if (!HealthTypes.validWindow(start, end)) { call.reject("start_ms / end_ms 不对(最多 31 天)", "invalid_args"); return; }
        int limit = clamp(call.getInt("limit", 50), 1, 100);
        healthRun(call, "sessions", (health) -> health.exercise(Instant.ofEpochMilli(start), Instant.ofEpochMilli(end), limit));
    }

    /** 按时间点记的那几类(type:hrv / oxygen_saturation / respiratory_rate / weight / body_fat)。 */
    @PluginMethod
    public void healthSamples(PluginCall call) {
        String type = call.getString("type", "");
        Long start = call.getLong("start_ms");
        Long end = call.getLong("end_ms");
        if (!HealthTypes.isSampleType(type)) { call.reject("type 不对", "invalid_args"); return; }
        if (!HealthTypes.validWindow(start, end)) { call.reject("start_ms / end_ms 不对(最多 31 天)", "invalid_args"); return; }
        healthRun(call, "samples", (health) -> health.samples(type, Instant.ofEpochMilli(start), Instant.ofEpochMilli(end)));
    }

    @PluginMethod
    public void healthHeartRate(PluginCall call) {
        Long start = call.getLong("start_ms");
        Long end = call.getLong("end_ms");
        if (!HealthTypes.validWindow(start, end)) { call.reject("start_ms / end_ms 不对(最多 31 天)", "invalid_args"); return; }
        int bucket = clamp(call.getInt("bucket_minutes", 60), 5, 1440);
        healthRun(call, "buckets", (health) -> health.heartRate(Instant.ofEpochMilli(start), Instant.ofEpochMilli(end), bucket));
    }

    // ── 小工具 ───────────────────────────────────────────────────────────────

    private static int clamp(Integer value, int min, int max) {
        int v = value == null ? min : value;
        return Math.max(min, Math.min(max, v));
    }

    private static String nz(String value) {
        return value == null ? "" : value;
    }

    private static Long parseId(String value) {
        if (value == null) return null;
        try {
            return Long.parseLong(value.trim());
        } catch (NumberFormatException error) {
            return null;
        }
    }
}
