package app.gugu.chat;

import android.app.Notification;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import java.util.ArrayDeque;
import java.util.Iterator;

/**
 * #7199 手机当设备 ——「读通知」(notifications.list)。用户在系统「通知使用权」里给了咕咕之后,系统把每条新通知交给这里。
 * 只在被调用时把手里的交出去:当前还挂着的(系统现给)+ 服务连着期间收到的最近 200 条(只在内存里,❌ 落盘、❌ 上传)。
 * 只在用户在咕咕里连着「通知与勿扰」时才记(setCollecting):系统的「通知使用权」开着、咕咕里断开了 ⇒ 不记,断开当场清空。
 * 咕咕自己的通知不算(「后台守着」那条常驻通知、agent 的提醒),那是咕咕自己说的话,不是用户手机上发生的事。
 */
public class GuguNotificationListener extends NotificationListenerService {
    static final int RECENT_LIMIT = 200;

    private static volatile GuguNotificationListener connected;
    private static final ArrayDeque<JSObject> recent = new ArrayDeque<>();
    /** 进程刚起来(系统重新绑定这个服务、网页还没起)时默认不记,等网页说连着再记。 */
    private static volatile boolean collecting = false;

    static void setCollecting(boolean on) {
        collecting = on;
        if (!on) {
            synchronized (recent) {
                recent.clear();
            }
        }
    }

    /** 用户在系统设置里给没给「通知使用权」。 */
    static boolean isEnabled(Context context) {
        String flat = Settings.Secure.getString(context.getContentResolver(), "enabled_notification_listeners");
        if (flat == null || flat.isEmpty()) return false;
        String mine = new ComponentName(context, GuguNotificationListener.class).flattenToString();
        for (String entry : flat.split(":")) {
            if (mine.equals(entry)) return true;
        }
        return false;
    }

    /** 当前挂着的 + 最近收到的,新的在前,去掉同一条(key 相同)。服务没连上 = null(调用方说「通知使用权没给 / 服务还没起来」)。 */
    static JSArray snapshot(Context context, int limit) {
        GuguNotificationListener service = connected;
        if (service == null) return null;
        JSArray out = new JSArray();
        java.util.HashSet<String> seen = new java.util.HashSet<>();
        StatusBarNotification[] active;
        try {
            active = service.getActiveNotifications();
        } catch (RuntimeException error) {
            active = new StatusBarNotification[0];
        }
        java.util.List<JSObject> rows = new java.util.ArrayList<>();
        if (active != null) {
            for (StatusBarNotification sbn : active) {
                JSObject row = describe(context, sbn, true);
                if (row != null) rows.add(row);
            }
        }
        synchronized (recent) {
            Iterator<JSObject> it = recent.descendingIterator();
            while (it.hasNext()) rows.add(it.next());
        }
        rows.sort((a, b) -> Long.compare(b.optLong("posted_at"), a.optLong("posted_at")));
        for (JSObject row : rows) {
            String key = row.optString("key");
            if (!seen.add(key)) continue;
            out.put(row);
            if (out.length() >= limit) break;
        }
        return out;
    }

    private static JSObject describe(Context context, StatusBarNotification sbn, boolean active) {
        // 别的 App 的 extras 里可能带咕咕解不开的自定义 Parcelable(安卓 12 及以下读字段会抛 BadParcelableException):
        // 跳过那一条,❌ 让服务回调 / 插件方法崩掉整个 App。
        try {
            return describeUnsafe(context, sbn, active);
        } catch (RuntimeException error) {
            return null;
        }
    }

    private static JSObject describeUnsafe(Context context, StatusBarNotification sbn, boolean active) {
        if (sbn == null || context.getPackageName().equals(sbn.getPackageName())) return null;
        Notification n = sbn.getNotification();
        if (n == null) return null;
        Bundle extras = n.extras;
        CharSequence title = extras == null ? null : extras.getCharSequence(Notification.EXTRA_TITLE);
        CharSequence text = extras == null ? null : extras.getCharSequence(Notification.EXTRA_TEXT);
        CharSequence big = extras == null ? null : extras.getCharSequence(Notification.EXTRA_BIG_TEXT);
        if (title == null && text == null && big == null) return null;
        JSObject row = new JSObject();
        row.put("key", sbn.getKey());
        row.put("app", appLabel(context, sbn.getPackageName()));
        row.put("package", sbn.getPackageName());
        row.put("title", title == null ? "" : title.toString());
        row.put("text", big != null ? big.toString() : text == null ? "" : text.toString());
        row.put("posted_at", sbn.getPostTime());
        row.put("ongoing", sbn.isOngoing());
        row.put("active", active);
        return row;
    }

    private static String appLabel(Context context, String pkg) {
        try {
            PackageManager pm = context.getPackageManager();
            ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
            return pm.getApplicationLabel(info).toString();
        } catch (PackageManager.NameNotFoundException | RuntimeException error) {
            return pkg;
        }
    }

    @Override
    public void onListenerConnected() {
        connected = this;
    }

    @Override
    public void onListenerDisconnected() {
        if (connected == this) connected = null;
    }

    @Override
    public void onDestroy() {
        if (connected == this) connected = null;
        super.onDestroy();
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (!collecting) return;
        JSObject row = describe(this, sbn, false);
        if (row == null) return;
        synchronized (recent) {
            recent.addLast(row);
            while (recent.size() > RECENT_LIMIT) recent.removeFirst();
        }
    }
}
