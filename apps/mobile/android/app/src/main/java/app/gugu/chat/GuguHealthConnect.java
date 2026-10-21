package app.gugu.chat;

import android.content.Context;
import android.content.pm.PackageManager;
import android.health.connect.AggregateRecordsGroupedByDurationResponse;
import android.health.connect.AggregateRecordsGroupedByPeriodResponse;
import android.health.connect.AggregateRecordsRequest;
import android.health.connect.AggregateRecordsResponse;
import android.health.connect.HealthConnectException;
import android.health.connect.HealthConnectManager;
import android.health.connect.LocalTimeRangeFilter;
import android.health.connect.ReadRecordsRequestUsingFilters;
import android.health.connect.ReadRecordsResponse;
import android.health.connect.TimeInstantRangeFilter;
import android.health.connect.datatypes.ActiveCaloriesBurnedRecord;
import android.health.connect.datatypes.AggregationType;
import android.health.connect.datatypes.BodyFatRecord;
import android.health.connect.datatypes.DistanceRecord;
import android.health.connect.datatypes.ExerciseSessionRecord;
import android.health.connect.datatypes.HeartRateRecord;
import android.health.connect.datatypes.HeartRateVariabilityRmssdRecord;
import android.health.connect.datatypes.InstantRecord;
import android.health.connect.datatypes.OxygenSaturationRecord;
import android.health.connect.datatypes.RespiratoryRateRecord;
import android.health.connect.datatypes.WeightRecord;
import android.health.connect.datatypes.Record;
import android.health.connect.datatypes.RestingHeartRateRecord;
import android.health.connect.datatypes.SleepSessionRecord;
import android.health.connect.datatypes.StepsRecord;
import android.health.connect.datatypes.units.Energy;
import android.health.connect.datatypes.units.Length;
import android.os.Build;
import android.os.OutcomeReceiver;

import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.Period;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * #7199 健康:读这台手机 Health Connect 里的数据(只读)。用安卓 14 起系统自带的 android.health.connect(Java 接口),
 * ❌ Jetpack 的 connect-client:那套是 Kotlin 协程接口,还要再拉一串依赖;安卓 13 及以下要另装 Health Connect App,
 * 国内手机多半装不上 —— 那些手机如实说「这台手机不支持」。
 * 这里只把系统给的记录原样(毫秒、整数)交出去;按天合计、昨晚睡了多久、基线比较都在网页那一侧(phoneHealth.ts,有单测)。
 * 每个方法都在调用方的后台线程上同步等系统回话(最多 READ_TIMEOUT_S 秒)。
 */
@RequiresApi(api = Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
final class GuguHealthConnect {
    private static final long READ_TIMEOUT_S = 20;
    private static final Executor DIRECT = Runnable::run;

    /** 读失败:code 与插件头注释里那几个码同义(os_permission / unavailable / failed)。 */
    static final class Failure extends Exception {
        final String code;

        Failure(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    private final Context context;
    private final HealthConnectManager manager;

    GuguHealthConnect(Context context) {
        this.context = context;
        this.manager = context.getSystemService(HealthConnectManager.class);
    }

    static boolean supported(Context context) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && context.getSystemService(HealthConnectManager.class) != null;
    }

    /** 后台读那条权限系统认不认(安卓 15 起)。 */
    static boolean backgroundSupported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM;
    }

    Set<String> grantedPermissions() {
        Set<String> out = new HashSet<>();
        for (String permission : HealthTypes.requestList(backgroundSupported())) {
            if (ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED) out.add(permission);
        }
        return out;
    }

    JSObject status() {
        Set<String> granted = grantedPermissions();
        JSObject out = new JSObject();
        out.put("supported", true);
        out.put("granted_types", JSArray.from(HealthTypes.grantedTypes(granted).toArray()));
        out.put("background_supported", backgroundSupported());
        out.put("background_granted", granted.contains(HealthTypes.BACKGROUND));
        return out;
    }

    // ── 按天合计 ──────────────────────────────────────────────────────────────

    /**
     * 从手机本地 startDate 零点起 days 天,每天一格:步数、距离、活动消耗、心率均值 / 最低 / 最高、静息心率、锻炼时长。
     * 没给权限的那几类不读(带上会让整个请求被拒),在 missing_types 里说;给了但那天没数据 = null。
     */
    JSObject daily(LocalDateTime startDay, int days) throws Failure {
        Set<String> granted = grantedPermissions();
        List<String> grantedTypes = HealthTypes.grantedTypes(granted);
        LocalTimeRangeFilter range = new LocalTimeRangeFilter.Builder().setStartTime(startDay).setEndTime(startDay.plusDays(days)).build();
        JSArray out = new JSArray();
        List<JSObject> rows = new ArrayList<>();
        for (int i = 0; i < days; i++) {
            JSObject row = new JSObject();
            row.put("date", startDay.plusDays(i).toLocalDate().toString());
            rows.add(row);
        }
        if (grantedTypes.contains("steps")) fillDaily(rows, range, StepsRecord.STEPS_COUNT_TOTAL, "steps", startDay, (v) -> v);
        if (grantedTypes.contains("distance")) fillDaily(rows, range, DistanceRecord.DISTANCE_TOTAL, "distance_m", startDay, (v) -> Math.round(((Length) v).getInMeters()));
        if (grantedTypes.contains("active_calories")) fillDaily(rows, range, ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL, "active_kcal", startDay, (v) -> Math.round(((Energy) v).getInCalories() / 1000.0));
        if (grantedTypes.contains("heart_rate")) {
            fillDaily(rows, range, HeartRateRecord.BPM_AVG, "hr_avg", startDay, (v) -> v);
            fillDaily(rows, range, HeartRateRecord.BPM_MIN, "hr_min", startDay, (v) -> v);
            fillDaily(rows, range, HeartRateRecord.BPM_MAX, "hr_max", startDay, (v) -> v);
        }
        if (grantedTypes.contains("resting_heart_rate")) fillDaily(rows, range, RestingHeartRateRecord.BPM_AVG, "resting_hr", startDay, (v) -> v);
        if (grantedTypes.contains("exercise")) fillDaily(rows, range, ExerciseSessionRecord.EXERCISE_DURATION_TOTAL, "exercise_ms", startDay, (v) -> v);
        for (JSObject row : rows) out.put(row);
        JSObject result = new JSObject();
        result.put("timezone", ZoneId.systemDefault().getId());
        result.put("days", out);
        result.put("granted_types", JSArray.from(grantedTypes.toArray()));
        return result;
    }

    private interface Convert {
        Object apply(Object value);
    }

    private <T> void fillDaily(List<JSObject> rows, LocalTimeRangeFilter range, AggregationType<T> type, String key, LocalDateTime startDay, Convert convert) throws Failure {
        AggregateRecordsRequest<T> request = new AggregateRecordsRequest.Builder<T>(range).addAggregationType(type).build();
        CompletableFuture<List<AggregateRecordsGroupedByPeriodResponse<T>>> future = new CompletableFuture<>();
        manager.aggregateGroupByPeriod(request, Period.ofDays(1), DIRECT, receiver(future));
        for (AggregateRecordsGroupedByPeriodResponse<T> bucket : await(future)) {
            int index = (int) java.time.temporal.ChronoUnit.DAYS.between(startDay.toLocalDate(), bucket.getStartTime().toLocalDate());
            if (index < 0 || index >= rows.size()) continue;
            T value = bucket.get(type);
            rows.get(index).put(key, value == null ? JSObject.NULL : convert.apply(value));
        }
        for (JSObject row : rows) if (!row.has(key)) row.put(key, JSObject.NULL);
    }

    // ── 原始记录 ──────────────────────────────────────────────────────────────

    JSArray sleep(Instant start, Instant end) throws Failure {
        requireType("sleep");
        JSArray out = new JSArray();
        for (SleepSessionRecord record : read(SleepSessionRecord.class, start, end)) {
            JSObject session = interval(record, record.getStartTime(), record.getEndTime());
            session.put("title", text(record.getTitle()));
            JSArray stages = new JSArray();
            for (SleepSessionRecord.Stage stage : record.getStages()) {
                JSObject s = new JSObject();
                s.put("start_ms", stage.getStartTime().toEpochMilli());
                s.put("end_ms", stage.getEndTime().toEpochMilli());
                s.put("stage", HealthTypes.sleepStage(stage.getType()));
                stages.put(s);
            }
            session.put("stages", stages);
            out.put(session);
        }
        return out;
    }

    /** 锻炼:每一次的类型、起止、标题;再按这一次的时间窗合计步数 / 距离 / 消耗 / 平均心率(给了哪类合计哪类)。 */
    JSArray exercise(Instant start, Instant end, int limit) throws Failure {
        requireType("exercise");
        List<String> grantedTypes = HealthTypes.grantedTypes(grantedPermissions());
        List<ExerciseSessionRecord> records = read(ExerciseSessionRecord.class, start, end);
        JSArray out = new JSArray();
        int from = Math.max(0, records.size() - limit);
        for (ExerciseSessionRecord record : records.subList(from, records.size())) {
            JSObject session = interval(record, record.getStartTime(), record.getEndTime());
            session.put("exercise_type", record.getExerciseType());
            session.put("title", text(record.getTitle()));
            TimeInstantRangeFilter window = new TimeInstantRangeFilter.Builder().setStartTime(record.getStartTime()).setEndTime(record.getEndTime()).build();
            if (grantedTypes.contains("steps")) session.put("steps", total(window, StepsRecord.STEPS_COUNT_TOTAL, (v) -> v));
            if (grantedTypes.contains("distance")) session.put("distance_m", total(window, DistanceRecord.DISTANCE_TOTAL, (v) -> Math.round(((Length) v).getInMeters())));
            if (grantedTypes.contains("active_calories")) session.put("active_kcal", total(window, ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL, (v) -> Math.round(((Energy) v).getInCalories() / 1000.0)));
            if (grantedTypes.contains("heart_rate")) {
                session.put("hr_avg", total(window, HeartRateRecord.BPM_AVG, (v) -> v));
                session.put("hr_max", total(window, HeartRateRecord.BPM_MAX, (v) -> v));
            }
            out.put(session);
        }
        return out;
    }

    /** 按时间点记的那几类(HealthTypes.isSampleType):每条一个读数 value(心率变异性毫秒、血氧 %、呼吸次/分、体重千克、体脂 %)。 */
    JSArray samples(String type, Instant start, Instant end) throws Failure {
        if (!HealthTypes.isSampleType(type)) throw new Failure("invalid_args", "不认识的类:" + type);
        requireType(type);
        JSArray out = new JSArray();
        List<? extends InstantRecord> records;
        switch (type) {
            case "hrv": records = read(HeartRateVariabilityRmssdRecord.class, start, end); break;
            case "oxygen_saturation": records = read(OxygenSaturationRecord.class, start, end); break;
            case "respiratory_rate": records = read(RespiratoryRateRecord.class, start, end); break;
            case "weight": records = read(WeightRecord.class, start, end); break;
            default: records = read(BodyFatRecord.class, start, end); break;
        }
        for (InstantRecord record : records) {
            JSObject sample = new JSObject();
            sample.put("time_ms", record.getTime().toEpochMilli());
            sample.put("value", sampleValue(record));
            sample.put("source", record.getMetadata().getDataOrigin().getPackageName());
            out.put(sample);
        }
        return out;
    }

    private static double sampleValue(InstantRecord record) {
        if (record instanceof HeartRateVariabilityRmssdRecord) return ((HeartRateVariabilityRmssdRecord) record).getHeartRateVariabilityMillis();
        if (record instanceof OxygenSaturationRecord) return ((OxygenSaturationRecord) record).getPercentage().getValue();
        if (record instanceof RespiratoryRateRecord) return ((RespiratoryRateRecord) record).getRate();
        if (record instanceof WeightRecord) return ((WeightRecord) record).getWeight().getInGrams() / 1000.0;
        return ((BodyFatRecord) record).getPercentage().getValue();
    }

    /** 心率按 bucketMinutes 分段:每段均值 / 最低 / 最高。 */
    JSArray heartRate(Instant start, Instant end, int bucketMinutes) throws Failure {
        requireType("heart_rate");
        TimeInstantRangeFilter range = new TimeInstantRangeFilter.Builder().setStartTime(start).setEndTime(end).build();
        AggregateRecordsRequest<Long> request = new AggregateRecordsRequest.Builder<Long>(range)
            .addAggregationType(HeartRateRecord.BPM_AVG)
            .addAggregationType(HeartRateRecord.BPM_MIN)
            .addAggregationType(HeartRateRecord.BPM_MAX)
            .build();
        CompletableFuture<List<AggregateRecordsGroupedByDurationResponse<Long>>> future = new CompletableFuture<>();
        manager.aggregateGroupByDuration(request, Duration.ofMinutes(bucketMinutes), DIRECT, receiver(future));
        JSArray out = new JSArray();
        for (AggregateRecordsGroupedByDurationResponse<Long> bucket : await(future)) {
            Long avg = bucket.get(HeartRateRecord.BPM_AVG);
            if (avg == null) continue;
            JSObject row = new JSObject();
            row.put("start_ms", bucket.getStartTime().toEpochMilli());
            row.put("end_ms", bucket.getEndTime().toEpochMilli());
            row.put("avg", avg);
            row.put("min", orNull(bucket.get(HeartRateRecord.BPM_MIN)));
            row.put("max", orNull(bucket.get(HeartRateRecord.BPM_MAX)));
            out.put(row);
        }
        return out;
    }

    // ── 底下的几样 ────────────────────────────────────────────────────────────

    private void requireType(String type) throws Failure {
        if (!HealthTypes.missingTypes(java.util.Collections.singletonList(type), grantedPermissions()).isEmpty()) {
            throw new Failure("os_permission", "Health Connect 里没给咕咕读「" + type + "」的权限");
        }
    }

    private <T extends Record> List<T> read(Class<T> type, Instant start, Instant end) throws Failure {
        TimeInstantRangeFilter range = new TimeInstantRangeFilter.Builder().setStartTime(start).setEndTime(end).build();
        List<T> out = new ArrayList<>();
        long pageToken = -1;
        do {
            ReadRecordsRequestUsingFilters.Builder<T> builder = new ReadRecordsRequestUsingFilters.Builder<>(type)
                .setTimeRangeFilter(range)
                .setAscending(true)
                .setPageSize(500);
            if (pageToken != -1) builder.setPageToken(pageToken);
            CompletableFuture<ReadRecordsResponse<T>> future = new CompletableFuture<>();
            manager.readRecords(builder.build(), DIRECT, receiver(future));
            ReadRecordsResponse<T> page = await(future);
            out.addAll(page.getRecords());
            pageToken = page.getNextPageToken();
        } while (pageToken != -1 && out.size() < HealthTypes.MAX_RECORDS);
        return out;
    }

    private <T> Object total(TimeInstantRangeFilter window, AggregationType<T> type, Convert convert) throws Failure {
        AggregateRecordsRequest<T> request = new AggregateRecordsRequest.Builder<T>(window).addAggregationType(type).build();
        CompletableFuture<AggregateRecordsResponse<T>> future = new CompletableFuture<>();
        manager.aggregate(request, DIRECT, receiver(future));
        T value = await(future).get(type);
        return value == null ? JSObject.NULL : convert.apply(value);
    }

    private static JSObject interval(Record record, Instant start, Instant end) {
        JSObject out = new JSObject();
        out.put("start_ms", start.toEpochMilli());
        out.put("end_ms", end.toEpochMilli());
        out.put("source", record.getMetadata().getDataOrigin().getPackageName());
        return out;
    }

    private static Object text(CharSequence value) {
        return value == null || value.length() == 0 ? JSObject.NULL : value.toString();
    }

    private static Object orNull(Object value) {
        return value == null ? JSObject.NULL : value;
    }

    private static <R> OutcomeReceiver<R, HealthConnectException> receiver(CompletableFuture<R> future) {
        return new OutcomeReceiver<R, HealthConnectException>() {
            @Override
            public void onResult(R result) {
                future.complete(result);
            }

            @Override
            public void onError(HealthConnectException error) {
                future.completeExceptionally(error);
            }
        };
    }

    private static <R> R await(CompletableFuture<R> future) throws Failure {
        try {
            return future.get(READ_TIMEOUT_S, TimeUnit.SECONDS);
        } catch (TimeoutException error) {
            throw new Failure("failed", "Health Connect " + READ_TIMEOUT_S + " 秒内没回话");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new Failure("failed", "读 Health Connect 时被打断");
        } catch (ExecutionException error) {
            throw translate(error.getCause());
        } catch (SecurityException error) {
            throw new Failure("os_permission", "Health Connect 拒绝了咕咕:" + error.getMessage());
        }
    }

    /** 系统的错 → 码。安全类的错多半是:权限被收回,或咕咕在后台而没给「后台读取」。 */
    static Failure translate(Throwable cause) {
        if (cause instanceof SecurityException) return new Failure("os_permission", "Health Connect 拒绝了咕咕:" + cause.getMessage());
        if (cause instanceof HealthConnectException) {
            int code = ((HealthConnectException) cause).getErrorCode();
            if (code == HealthConnectException.ERROR_SECURITY) {
                return new Failure("os_permission", "Health Connect 拒绝了咕咕(权限被收回,或咕咕在后台而没给「在后台读取」):" + cause.getMessage());
            }
            if (code == HealthConnectException.ERROR_RATE_LIMIT_EXCEEDED) return new Failure("failed", "读得太频繁,Health Connect 让稍后再试");
            if (code == HealthConnectException.ERROR_DATA_SYNC_IN_PROGRESS) return new Failure("failed", "Health Connect 正在同步数据,稍后再试");
            return new Failure("failed", "Health Connect 读失败(" + code + "):" + cause.getMessage());
        }
        return new Failure("failed", "Health Connect 读失败:" + (cause == null ? "未知" : cause.getMessage()));
    }
}
