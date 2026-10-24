package app.gugu.chat;

import android.Manifest;
import android.content.ContentUris;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.TimeZone;

/** Shared by the Capacitor action and the native Agent service. */
final class PhoneCalendarReader {
    static JSObject read(Context context, long start, long end, int limit) {
        requirePermission(context);
        if (end <= start || limit < 1 || limit > 500) throw new IllegalArgumentException("日历的时间范围或条数无效");
        Uri.Builder uri = CalendarContract.Instances.CONTENT_URI.buildUpon();
        ContentUris.appendId(uri, start);
        ContentUris.appendId(uri, end);
        String[] columns = {
            CalendarContract.Instances.EVENT_ID, CalendarContract.Instances.TITLE, CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END, CalendarContract.Instances.ALL_DAY, CalendarContract.Instances.EVENT_LOCATION,
            CalendarContract.Instances.DESCRIPTION, CalendarContract.Instances.CALENDAR_DISPLAY_NAME, CalendarContract.Instances.CALENDAR_ID,
        };
        JSArray events = new JSArray();
        try (Cursor cursor = context.getContentResolver().query(uri.build(), columns, CalendarContract.Instances.VISIBLE + "=1", null, CalendarContract.Instances.BEGIN + " ASC")) {
            if (cursor == null) throw new IllegalStateException("日历服务未返回查询结果");
            while (cursor.moveToNext() && events.length() < limit) {
                if (cursor.getInt(4) == 1 && !CalendarReadRange.overlapsAllDay(cursor.getLong(2), cursor.getLong(3), start, end, java.time.ZoneId.systemDefault())) continue;
                JSObject event = new JSObject();
                event.put("event_id", String.valueOf(cursor.getLong(0)));
                event.put("title", text(cursor.getString(1)));
                event.put("start_ms", cursor.getLong(2));
                event.put("end_ms", cursor.getLong(3));
                event.put("all_day", cursor.getInt(4) == 1);
                event.put("location", text(cursor.getString(5)));
                event.put("description", text(cursor.getString(6)));
                event.put("calendar", text(cursor.getString(7)));
                event.put("calendar_id", String.valueOf(cursor.getLong(8)));
                events.put(event);
            }
        }
        requirePermission(context);
        return new JSObject().put("events", events).put("timezone", TimeZone.getDefault().getID());
    }
    private static void requirePermission(Context context) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) != PackageManager.PERMISSION_GRANTED)
            throw new SecurityException("系统没有授予日历读取权限");
    }
    private static String text(String value) { return value == null ? "" : value; }
}
