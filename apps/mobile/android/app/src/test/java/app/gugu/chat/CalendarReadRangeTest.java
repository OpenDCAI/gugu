package app.gugu.chat;

import org.junit.Test;
import static org.junit.Assert.*;
import java.time.Instant;
import java.time.ZoneId;

public class CalendarReadRangeTest {
    private final ZoneId zone = ZoneId.of("Asia/Shanghai");
    private final Instant now = Instant.parse("2026-10-20T08:00:00Z");
    @Test public void chineseCalendarDateUsesPhoneTimezone() {
        long[] range = CalendarReadRange.resolve("2026-10-20", null, null, zone, now);
        assertEquals(Instant.parse("2026-10-19T16:00:00Z").toEpochMilli(), range[0]);
        assertEquals(Instant.parse("2026-10-20T16:00:00Z").toEpochMilli(), range[1]);
    }
    @Test public void localAndOffsetIsoQueriesAgree() {
        assertArrayEquals(CalendarReadRange.resolve(null, "2026-10-20T09:00:00+08:00", "2026-10-20T10:00:00+08:00", zone, now),
            CalendarReadRange.resolve(null, "2026-10-20T09:00:00", "2026-10-20T10:00:00", zone, now));
    }
    @Test public void calendarDayAcrossDstHasTwentyThreeHours() {
        long[] range = CalendarReadRange.resolve("2026-03-08", null, null, ZoneId.of("America/New_York"), now);
        assertEquals(23 * 3600000L, range[1] - range[0]);
    }
    @Test(expected = IllegalArgumentException.class) public void reversedRangeIsRejected() {
        CalendarReadRange.resolve(null, "2026-10-20T10:00:00Z", "2026-10-20T09:00:00Z", zone, now);
    }
    @Test public void adjacentUtcAllDayEventIsExcludedInShanghai() {
        long[] range = CalendarReadRange.resolve("2026-10-20", null, null, zone, now);
        assertFalse(CalendarReadRange.overlapsAllDay(Instant.parse("2026-10-19T00:00:00Z").toEpochMilli(),
            Instant.parse("2026-10-20T00:00:00Z").toEpochMilli(), range[0], range[1], zone));
        assertTrue(CalendarReadRange.overlapsAllDay(Instant.parse("2026-10-20T00:00:00Z").toEpochMilli(),
            Instant.parse("2026-10-21T00:00:00Z").toEpochMilli(), range[0], range[1], zone));
    }
}
