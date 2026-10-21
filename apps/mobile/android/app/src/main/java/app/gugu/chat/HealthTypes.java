package app.gugu.chat;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * #7199 健康:咕咕读 Health Connect 的哪几类、各要哪一条系统权限,以及「这台手机给了哪几类」的判断。
 * 纯 Java(不碰安卓类,权限名写字面量 —— 与 android.health.connect.HealthPermissions 的常量同值),单测在 src/test。
 * 读的那几类:步数、距离、活动消耗、心率、静息心率、心率变异性、睡眠、锻炼、血氧、呼吸频率、体重、体脂;只读,❌ 写
 * (爬楼层数、基础代谢,咕咕的页面与助理都用不上,不读)。
 */
public final class HealthTypes {
    private HealthTypes() {}

    /** 类名(网页那一侧与给助理的结果里都用它)→ 系统权限。顺序 = 设置页「缺哪几类」的顺序。 */
    public static final Map<String, String> PERMISSIONS;

    /** 后台读:咕咕不在前台时(助理多半在这时调)要这一条,安卓 15 起才有。没给也照样登记,读的时候系统拒了如实说。 */
    public static final String BACKGROUND = "android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND";

    static {
        Map<String, String> map = new LinkedHashMap<>();
        map.put("steps", "android.permission.health.READ_STEPS");
        map.put("distance", "android.permission.health.READ_DISTANCE");
        map.put("active_calories", "android.permission.health.READ_ACTIVE_CALORIES_BURNED");
        map.put("heart_rate", "android.permission.health.READ_HEART_RATE");
        map.put("resting_heart_rate", "android.permission.health.READ_RESTING_HEART_RATE");
        map.put("hrv", "android.permission.health.READ_HEART_RATE_VARIABILITY");
        map.put("sleep", "android.permission.health.READ_SLEEP");
        map.put("exercise", "android.permission.health.READ_EXERCISE");
        map.put("oxygen_saturation", "android.permission.health.READ_OXYGEN_SATURATION");
        map.put("respiratory_rate", "android.permission.health.READ_RESPIRATORY_RATE");
        map.put("weight", "android.permission.health.READ_WEIGHT");
        map.put("body_fat", "android.permission.health.READ_BODY_FAT");
        PERMISSIONS = Collections.unmodifiableMap(map);
    }

    /** 这一次要向系统申请的全部权限(各类 + 后台读;后台读只在系统认得它时带上)。 */
    public static String[] requestList(boolean backgroundSupported) {
        List<String> out = new ArrayList<>(PERMISSIONS.values());
        if (backgroundSupported) out.add(BACKGROUND);
        return out.toArray(new String[0]);
    }

    /** 系统给了的权限 → 给了的类(按 PERMISSIONS 的顺序)。 */
    public static List<String> grantedTypes(Set<String> grantedPermissions) {
        List<String> out = new ArrayList<>();
        for (Map.Entry<String, String> entry : PERMISSIONS.entrySet()) {
            if (grantedPermissions.contains(entry.getValue())) out.add(entry.getKey());
        }
        return out;
    }

    /** 这几类里还没给的(读之前先挑出来:一个请求里带了没给的类,系统会把整个请求拒掉)。 */
    public static List<String> missingTypes(List<String> wanted, Set<String> grantedPermissions) {
        List<String> out = new ArrayList<>();
        for (String type : wanted) {
            String permission = PERMISSIONS.get(type);
            if (permission == null || !grantedPermissions.contains(permission)) out.add(type);
        }
        return out;
    }

    /**
     * 睡眠分期(SleepSessionRecord.StageType 的整数)→ 名字。网页那一侧按名字合计;认不出的归 unknown。
     * 值见 android.health.connect.datatypes.SleepSessionRecord.StageType(API 34)。
     */
    public static String sleepStage(int type) {
        switch (type) {
            case 1: return "awake";
            case 2: return "sleeping";
            case 3: return "out_of_bed";
            case 4: return "light";
            case 5: return "deep";
            case 6: return "rem";
            case 7: return "awake_in_bed";
            default: return "unknown";
        }
    }

    /** 按时间点记的那几类(一次一个读数):心率变异性、血氧、呼吸频率、体重、体脂。 */
    public static boolean isSampleType(String type) {
        return "hrv".equals(type) || "oxygen_saturation".equals(type) || "respiratory_rate".equals(type) || "weight".equals(type) || "body_fat".equals(type);
    }

    /** 时间窗与条数的上限:一次最多读 31 天、一类最多 2000 条,❌ 一口气把整个历史交出去。 */
    public static final int MAX_DAYS = 31;
    public static final int MAX_RECORDS = 2000;

    /** start / end(毫秒)是否是一段能读的时间窗。 */
    public static boolean validWindow(Long startMs, Long endMs) {
        if (startMs == null || endMs == null) return false;
        if (endMs <= startMs) return false;
        return endMs - startMs <= MAX_DAYS * 24L * 3600_000L;
    }
}
