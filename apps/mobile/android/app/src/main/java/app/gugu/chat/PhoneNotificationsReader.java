package app.gugu.chat;

import android.content.Context;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

/** Uses the existing in-memory listener; never creates a second notification collection. */
final class PhoneNotificationsReader {
    static JSObject read(Context context, int limit) {
        permission(context);
        if (limit < 1 || limit > GuguNotificationListener.RECENT_LIMIT) throw new IllegalArgumentException("通知条数要在 1–200");
        JSArray rows = GuguNotificationListener.snapshot(context, limit);
        if (rows == null) throw new IllegalStateException("读通知的服务还没连上:到系统「通知使用权」里把咕咕关掉再打开一次");
        permission(context);
        return new JSObject().put("notifications", rows);
    }
    private static void permission(Context context) {
        if (!GuguNotificationListener.isEnabled(context)) throw new SecurityException("没给咕咕「通知使用权」");
    }
}
