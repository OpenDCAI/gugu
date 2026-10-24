package app.gugu.chat;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;

/** Models provide calendar dates, never arithmetic on Unix timestamps. */
final class CalendarReadRange {
    static long[] resolve(String date, String start, String end, ZoneId zone, Instant now) {
        Instant from;
        Instant until;
        if (date != null) {
            LocalDate day = LocalDate.parse(date);
            from = day.atStartOfDay(zone).toInstant();
            until = day.plusDays(1).atStartOfDay(zone).toInstant();
        } else if (start != null || end != null) {
            from = start == null ? now : instant(start, zone);
            until = end == null ? from.plus(7, ChronoUnit.DAYS) : instant(end, zone);
        } else {
            LocalDate today = now.atZone(zone).toLocalDate();
            from = today.atStartOfDay(zone).toInstant();
            until = today.plusDays(7).atStartOfDay(zone).toInstant();
        }
        if (!until.isAfter(from)) throw new IllegalArgumentException("end 要晚于 start");
        return new long[] { from.toEpochMilli(), until.toEpochMilli() };
    }
    private static Instant instant(String text, ZoneId zone) {
        try { return OffsetDateTime.parse(text).toInstant(); }
        catch (java.time.format.DateTimeParseException error) { return LocalDateTime.parse(text).atZone(zone).toInstant(); }
    }
    static boolean overlapsAllDay(long eventStart, long eventEnd, long start, long end, ZoneId zone) {
        LocalDate first = Instant.ofEpochMilli(start).atZone(zone).toLocalDate();
        LocalDate last = Instant.ofEpochMilli(end - 1).atZone(zone).toLocalDate();
        LocalDate eventFirst = Instant.ofEpochMilli(eventStart).atZone(ZoneId.of("UTC")).toLocalDate();
        LocalDate eventUntil = Instant.ofEpochMilli(eventEnd).atZone(ZoneId.of("UTC")).toLocalDate();
        return !eventFirst.isAfter(last) && eventUntil.isAfter(first);
    }
}
