package app.gugu.chat;

import org.junit.Test;
import static org.junit.Assert.*;

public class PhoneReadNumbersTest {
    @Test public void mediaDateFiltersPreserveExclusiveSubsecondBoundaries() {
        assertEquals(2, PhoneReadNumbers.mediaSeconds(2000));
        assertEquals(3, PhoneReadNumbers.mediaSeconds(2001));
        assertEquals(3, PhoneReadNumbers.mediaSeconds(2999));
    }
    @Test public void acceptsIntegerOffsetsAndLongDates() {
        assertEquals(Long.valueOf(98304), PhoneReadNumbers.optional(Integer.valueOf(98304), "offset"));
        assertEquals(Long.valueOf(1792396800000L), PhoneReadNumbers.optional(1792396800000L, "date"));
        assertEquals(Long.valueOf(0), PhoneReadNumbers.optional(0, "offset"));
        assertNull(PhoneReadNumbers.optional(null, "offset"));
    }
    @Test public void refusesFractionalNegativeAndNonNumericValues() {
        for (Object value : new Object[] { -1, 1.5, "123", Double.NaN, Double.POSITIVE_INFINITY, 9007199254740992d }) {
            try { PhoneReadNumbers.optional(value, "offset"); fail("accepted " + value); }
            catch (IllegalArgumentException expected) { assertTrue(expected.getMessage().contains("offset")); }
        }
    }
}
