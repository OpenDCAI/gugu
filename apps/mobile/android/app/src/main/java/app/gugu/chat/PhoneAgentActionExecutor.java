package app.gugu.chat;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import org.json.JSONObject;
import java.util.concurrent.CompletableFuture;

/**
 * Headless transport for the same native methods used by the Capacitor phone catalog.
 * Schema, date projection and health aggregation stay in the shared TypeScript catalog.
 * Permission requests and system settings are deliberately absent from this allowlist.
 */
final class PhoneAgentActionExecutor {
    private final GuguPhoneActionsPlugin actions;
    private final GuguPhoneDataPlugin data;

    PhoneAgentActionExecutor(Context supplied) {
        Context context = supplied.getApplicationContext();
        actions = new GuguPhoneActionsPlugin() {
            @Override public Context getContext() { return context; }
            @Override public AppCompatActivity getActivity() { return GuguAgentPlugin.foregroundActivity(); }
            @Override public PermissionState getPermissionState(String alias) {
                String[] permissions;
                switch (alias) {
                    // The host separately checks WRITE for mutations; a read does not require it.
                    case "calendar": permissions = new String[] { Manifest.permission.READ_CALENDAR }; break;
                    case "contacts": permissions = new String[] { Manifest.permission.READ_CONTACTS }; break;
                    case "location": permissions = new String[] { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }; break;
                    case "coarseLocation": permissions = new String[] { Manifest.permission.ACCESS_COARSE_LOCATION }; break;
                    default: return PermissionState.DENIED;
                }
                for (String permission : permissions) if (ContextCompat.checkSelfPermission(context, permission) != PackageManager.PERMISSION_GRANTED) return PermissionState.DENIED;
                return PermissionState.GRANTED;
            }
        };
        data = new GuguPhoneDataPlugin() { @Override public Context getContext() { return context; } };
    }

    static String group(String plugin, String method, JSONObject args) {
        if ("GuguPhoneActions".equals(plugin)) {
            switch (method) {
                case "calendarList": case "calendarCreate": case "calendarUpdate": case "calendarDelete": return "calendar";
                case "contactsList": return "contacts";
                case "locationCurrent": return "location";
                case "notificationsList": case "dndSet": return "notifications";
                case "alarmSet": case "timerStart": return "alarm";
                case "healthStatus": case "healthDaily": case "healthSleep": case "healthExercise": case "healthSamples": case "healthHeartRate": return "health";
                default: throw new PhoneNativeCall.Failure("unknown_action", "手机宿主没有开放这个原生动作");
            }
        }
        if ("GuguPhoneData".equals(plugin)) {
            switch (method) {
                case "status": return null;
                case "smsList": case "smsGet": return "sms";
                case "mediaList": case "mediaRead": return "audio".equals(args.optString("kind", "audio")) ? "recordings" : "photos";
                default: throw new PhoneNativeCall.Failure("unknown_action", "手机宿主没有开放这个数据动作");
            }
        }
        throw new PhoneNativeCall.Failure("unknown_action", "手机宿主没有开放这个原生插件");
    }

    static String action(String plugin, String method, JSONObject args) {
        if ("GuguPhoneActions".equals(plugin)) {
            switch (method) {
                case "calendarList": return "calendar.events.list";
                case "calendarCreate": return "calendar.events.create";
                case "calendarUpdate": return "calendar.events.update";
                case "calendarDelete": return "calendar.events.delete";
                case "contactsList": return "contacts.list";
                case "locationCurrent": return "location.current";
                case "notificationsList": return "notifications.list";
                case "dndSet": return "dnd.set";
                case "alarmSet": return "alarm.set";
                case "timerStart": return "timer.start";
                default: return null; // Health aggregation makes several authorized raw calls.
            }
        }
        if ("GuguPhoneData".equals(plugin)) {
            if ("smsList".equals(method)) return "sms.list";
            if ("smsGet".equals(method)) return "sms.get";
            if ("mediaList".equals(method)) return "audio".equals(args.optString("kind", "audio")) ? "recordings.list" : "photos.list";
            if ("mediaRead".equals(method)) return "audio".equals(args.optString("kind", "audio")) ? "recordings.read" : "photos.read";
        }
        return null;
    }

    static boolean requiresApproval(String plugin, String method) {
        return "GuguPhoneActions".equals(plugin) && ("calendarCreate".equals(method) || "calendarUpdate".equals(method)
            || "calendarDelete".equals(method) || "locationCurrent".equals(method) || "dndSet".equals(method));
    }

    CompletableFuture<JSObject> execute(String plugin, String method, JSONObject args) {
        PhoneNativeCall call;
        try {
            group(plugin, method, args);
            call = new PhoneNativeCall(plugin, method, new JSObject(args.toString()));
            if ("GuguPhoneActions".equals(plugin)) {
                actions.load(); // Refresh the real foreground state, never simulate a resumed Activity.
                switch (method) {
                    case "calendarList": actions.calendarList(call); break;
                    case "calendarCreate": actions.calendarCreate(call); break;
                    case "calendarUpdate": actions.calendarUpdate(call); break;
                    case "calendarDelete": actions.calendarDelete(call); break;
                    case "contactsList": actions.contactsList(call); break;
                    case "locationCurrent": actions.locationCurrent(call); break;
                    case "notificationsList": actions.notificationsList(call); break;
                    case "dndSet": actions.dndSet(call); break;
                    case "alarmSet": actions.alarmSet(call); break;
                    case "timerStart": actions.timerStart(call); break;
                    case "healthStatus": actions.healthStatus(call); break;
                    case "healthDaily": actions.healthDaily(call); break;
                    case "healthSleep": actions.healthSleep(call); break;
                    case "healthExercise": actions.healthExercise(call); break;
                    case "healthSamples": actions.healthSamples(call); break;
                    case "healthHeartRate": actions.healthHeartRate(call); break;
                    default: call.reject("未登记的手机原生动作", "unknown_action");
                }
            } else {
                switch (method) {
                    case "status": data.status(call); break;
                    case "smsList": data.smsList(call); break;
                    case "smsGet": data.smsGet(call); break;
                    case "mediaList": data.mediaList(call); break;
                    case "mediaRead": data.mediaRead(call); break;
                    default: call.reject("未登记的手机数据动作", "unknown_action");
                }
            }
            return call.result;
        } catch (Exception error) {
            CompletableFuture<JSObject> failed = new CompletableFuture<>(); failed.completeExceptionally(error); return failed;
        }
    }

    void close() { actions.closeReadExecutor(); data.closeReadExecutor(); }
}
