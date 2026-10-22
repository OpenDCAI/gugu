package app.gugu.chat;

import android.Manifest;
import android.content.ContentResolver;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.ContactsContract;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.text.Collator;

/** Shared read-only contacts query; permission is checked again before returning any rows. */
final class PhoneContactsReader {
    static JSObject read(Context context, String query, int limit) {
        permission(context);
        if (limit < 1 || limit > 500) throw new IllegalArgumentException("通讯录条数要在 1–500");
        ContentResolver resolver = context.getContentResolver();
        Uri uri = query != null && !query.trim().isEmpty()
            ? Uri.withAppendedPath(ContactsContract.Contacts.CONTENT_FILTER_URI, Uri.encode(query.trim()))
            : ContactsContract.Contacts.CONTENT_URI;
        Map<Long, String> matches = new LinkedHashMap<>();
        try (Cursor cursor = resolver.query(uri, new String[] { ContactsContract.Contacts._ID, ContactsContract.Contacts.DISPLAY_NAME_PRIMARY },
            null, null, ContactsContract.Contacts.DISPLAY_NAME_PRIMARY + " ASC")) {
            if (cursor == null) throw new IllegalStateException("通讯录服务未返回查询结果");
            int count = 0;
            while (cursor.moveToNext() && count++ < limit) matches.put(cursor.getLong(0), cursor.getString(1) == null ? "" : cursor.getString(1));
        }
        if (query != null && !query.trim().isEmpty()) {
            // Contacts' filter matches names/phone numbers, but does not reliably index email
            // addresses. Use the provider's email filter too, without scanning the address book.
            Uri email = Uri.withAppendedPath(ContactsContract.CommonDataKinds.Email.CONTENT_FILTER_URI, Uri.encode(query.trim()));
            try (Cursor cursor = resolver.query(email, new String[] { ContactsContract.CommonDataKinds.Email.CONTACT_ID, ContactsContract.CommonDataKinds.Email.DISPLAY_NAME_PRIMARY },
                null, null, ContactsContract.CommonDataKinds.Email.DISPLAY_NAME_PRIMARY + " ASC")) {
                if (cursor == null) throw new IllegalStateException("通讯录邮箱查询未返回结果");
                int count = 0;
                while (cursor.moveToNext() && count++ < limit) matches.putIfAbsent(cursor.getLong(0), cursor.getString(1) == null ? "" : cursor.getString(1));
            }
        }
        ArrayList<Map.Entry<Long, String>> ordered = new ArrayList<>(matches.entrySet());
        Collator collator = Collator.getInstance();
        ordered.sort((a, b) -> { int byName = collator.compare(a.getValue(), b.getValue()); return byName != 0 ? byName : Long.compare(a.getKey(), b.getKey()); });
        JSArray contacts = new JSArray();
        for (Map.Entry<Long, String> match : ordered) {
            if (contacts.length() >= limit) break;
            long id = match.getKey();
            contacts.put(new JSObject().put("contact_id", String.valueOf(id)).put("name", match.getValue())
                .put("phones", data(resolver, id, ContactsContract.CommonDataKinds.Phone.CONTENT_URI, ContactsContract.CommonDataKinds.Phone.CONTACT_ID, ContactsContract.CommonDataKinds.Phone.NUMBER))
                .put("emails", data(resolver, id, ContactsContract.CommonDataKinds.Email.CONTENT_URI, ContactsContract.CommonDataKinds.Email.CONTACT_ID, ContactsContract.CommonDataKinds.Email.ADDRESS)));
        }
        permission(context);
        return new JSObject().put("contacts", contacts);
    }
    private static JSArray data(ContentResolver resolver, long contactId, Uri uri, String idColumn, String valueColumn) {
        JSArray out = new JSArray();
        try (Cursor cursor = resolver.query(uri, new String[] { valueColumn }, idColumn + "=?", new String[] { String.valueOf(contactId) }, null)) {
            if (cursor == null) throw new IllegalStateException("通讯录详情未返回查询结果");
            java.util.HashSet<String> seen = new java.util.HashSet<>();
            while (cursor.moveToNext()) {
                String value = cursor.getString(0);
                if (value != null && seen.add(value.replace(" ", ""))) out.put(value);
            }
        }
        return out;
    }
    private static void permission(Context context) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED)
            throw new SecurityException("系统没有授予通讯录读取权限");
    }
}
