package app.gugu.chat;

import org.junit.Test;
import static org.junit.Assert.*;

public class StartupDeadlineTest {
    @Test public void doesNotCountTimeBeforeTheFirstResume() {
        StartupDeadline deadline = new StartupDeadline(20_000);
        assertFalse(deadline.resumed());
        assertEquals(20_000, deadline.remaining(90_000));
        assertEquals(20_000, deadline.resume(90_000));
    }

    @Test public void countsForegroundTimeAndKeepsTheRemainderAcrossBackground() {
        StartupDeadline deadline = new StartupDeadline(20_000);
        deadline.resume(1_000);
        deadline.pause(6_000);
        assertFalse(deadline.resumed());
        assertEquals(15_000, deadline.remaining(1_000_000));
        assertEquals(15_000, deadline.resume(1_000_000));
        assertEquals(0, deadline.remaining(1_015_000));
    }

    @Test public void repeatedResumeDoesNotResetTheBudget() {
        StartupDeadline deadline = new StartupDeadline(20_000);
        deadline.resume(1_000);
        assertEquals(15_000, deadline.resume(6_000));
        assertEquals(0, deadline.remaining(21_000));
    }

    @Test public void repeatedPauseDoesNotConsumeBackgroundTime() {
        StartupDeadline deadline = new StartupDeadline(20_000);
        deadline.resume(0);
        deadline.pause(2_000);
        deadline.pause(500_000);
        assertEquals(18_000, deadline.resume(900_000));
    }
}
