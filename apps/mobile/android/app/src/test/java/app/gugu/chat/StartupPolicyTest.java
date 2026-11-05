package app.gugu.chat;

import org.junit.Test;
import static org.junit.Assert.*;

public class StartupPolicyTest {
    private static class Memory implements StartupPolicy.Store {
        String value;
        public String read() { return value; }
        public boolean write(String mode) { value = mode; return true; }
    }
    @Test public void defaultAndExplicitRestoreAreEnabled() {
        Memory store = new Memory(); assertTrue(StartupPolicy.enabled(store, 31));
        assertTrue(StartupPolicy.setEnabled(store, false)); assertFalse(StartupPolicy.enabled(store, 31));
        assertTrue(StartupPolicy.setEnabled(store, true)); assertTrue(StartupPolicy.enabled(store, 31));
    }
    @Test public void unknownOrUnreadablePolicyFailsOpenToCompatibility() {
        Memory store = new Memory(); store.value = "unknown"; assertFalse(StartupPolicy.enabled(store, 31));
        StartupPolicy.Store bad = new StartupPolicy.Store() {
            public String read() { throw new IllegalStateException(); }
            public boolean write(String mode) { throw new IllegalStateException(); }
        };
        assertFalse(StartupPolicy.enabled(bad, 31)); assertFalse(StartupPolicy.setEnabled(bad, true));
    }
    @Test public void failedPersistenceIsNotReportedAsSuccess() {
        StartupPolicy.Store bad = new Memory() { public boolean write(String mode) { return false; } };
        assertFalse(StartupPolicy.setEnabled(bad, false));
    }
    @Test public void api30CannotEnableTheNewHandoffEvenAfterRestore() {
        Memory store = new Memory();
        assertFalse(StartupPolicy.supportsPlatform(24));
        assertFalse(StartupPolicy.supportsPlatform(30));
        assertFalse(StartupPolicy.enabled(store, 30));
        assertTrue(StartupPolicy.setEnabled(store, true));
        assertFalse(StartupPolicy.enabled(store, 30));
        assertTrue(StartupPolicy.enabled(store, 31));
        assertTrue(StartupPolicy.supportsPlatform(31));
    }
    @Test public void unsupportedSdkDoesNotReadPolicyStorage() {
        StartupPolicy.Store unused = new Memory() {
            public String read() { throw new AssertionError("legacy policy must stay off"); }
        };
        assertFalse(StartupPolicy.enabled(unused, 30));
    }
}
