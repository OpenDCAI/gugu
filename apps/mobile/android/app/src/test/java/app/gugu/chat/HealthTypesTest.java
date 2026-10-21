package app.gugu.chat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.junit.Test;

/** #7199 健康:咕咕读哪几类、系统给了哪几类、睡眠分期与时间窗的判断(HealthTypes,纯 Java)。 */
public class HealthTypesTest {
    private static Set<String> granted(String... permissions) {
        return new HashSet<>(Arrays.asList(permissions));
    }

    @Test
    public void readsTheTodayTypesOnly() {
        assertEquals(Arrays.asList("steps", "distance", "active_calories", "heart_rate", "resting_heart_rate", "hrv", "sleep", "exercise",
                "oxygen_saturation", "respiratory_rate", "weight", "body_fat"),
            new java.util.ArrayList<>(HealthTypes.PERMISSIONS.keySet()));
        for (String permission : HealthTypes.PERMISSIONS.values()) {
            assertTrue(permission.startsWith("android.permission.health.READ_"));
        }
    }

    @Test
    public void backgroundPermissionOnlyWhenTheSystemKnowsIt() {
        assertEquals(12, HealthTypes.requestList(false).length);
        List<String> withBackground = Arrays.asList(HealthTypes.requestList(true));
        assertEquals(13, withBackground.size());
        assertTrue(withBackground.contains("android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND"));
    }

    @Test
    public void grantedTypesFollowWhatTheSystemGave() {
        assertEquals(Collections.emptyList(), HealthTypes.grantedTypes(granted()));
        assertEquals(Arrays.asList("steps", "sleep"), HealthTypes.grantedTypes(granted(
            "android.permission.health.READ_SLEEP",
            "android.permission.health.READ_STEPS",
            "android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND",
            "android.permission.READ_CALENDAR")));
    }

    @Test
    public void missingTypesArePickedBeforeReading() {
        Set<String> some = granted("android.permission.health.READ_STEPS");
        assertEquals(Collections.emptyList(), HealthTypes.missingTypes(Collections.singletonList("steps"), some));
        assertEquals(Arrays.asList("sleep", "nonsense"), HealthTypes.missingTypes(Arrays.asList("steps", "sleep", "nonsense"), some));
    }

    @Test
    public void sampleTypesAreThePointInTimeOnes() {
        for (String type : Arrays.asList("hrv", "oxygen_saturation", "respiratory_rate", "weight", "body_fat")) assertTrue(type, HealthTypes.isSampleType(type));
        for (String type : Arrays.asList("steps", "sleep", "exercise", "heart_rate", "resting_heart_rate", "x")) assertFalse(type, HealthTypes.isSampleType(type));
    }

    @Test
    public void sleepStagesByName() {
        assertEquals("awake", HealthTypes.sleepStage(1));
        assertEquals("sleeping", HealthTypes.sleepStage(2));
        assertEquals("out_of_bed", HealthTypes.sleepStage(3));
        assertEquals("light", HealthTypes.sleepStage(4));
        assertEquals("deep", HealthTypes.sleepStage(5));
        assertEquals("rem", HealthTypes.sleepStage(6));
        assertEquals("awake_in_bed", HealthTypes.sleepStage(7));
        assertEquals("unknown", HealthTypes.sleepStage(0));
        assertEquals("unknown", HealthTypes.sleepStage(42));
    }

    @Test
    public void windowsAreBoundedToAMonth() {
        long day = 24L * 3600_000L;
        assertTrue(HealthTypes.validWindow(0L, day));
        assertTrue(HealthTypes.validWindow(0L, 31 * day));
        assertFalse(HealthTypes.validWindow(0L, 31 * day + 1));
        assertFalse(HealthTypes.validWindow(day, day));
        assertFalse(HealthTypes.validWindow(day, 0L));
        assertFalse(HealthTypes.validWindow(null, day));
    }
}
