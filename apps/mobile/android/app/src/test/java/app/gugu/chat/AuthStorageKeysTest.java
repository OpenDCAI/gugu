package app.gugu.chat;

import org.junit.Test;
import static org.junit.Assert.*;

public class AuthStorageKeysTest {
    @Test public void sessionCannotBeRemovedByTheTemporaryStorageApi() {
        assertTrue(AuthStorageKeys.isAllowed("sb-main"));
        assertFalse(AuthStorageKeys.isTemporary("sb-main"));
    }
    @Test public void verifierAndAttemptCanBeReadWrittenAndRemoved() {
        for (String key : new String[] { "sb-main-code-verifier", "sb-main-oauth-pending" }) {
            assertTrue(AuthStorageKeys.isAllowed(key));
            assertTrue(AuthStorageKeys.isTemporary(key));
        }
    }
    @Test public void unknownAndPrefixMatchingKeysAreRejected() {
        for (String key : new String[] { null, "", "other", "sb-main-code-verifier-extra", "sb-main-oauth-pending-extra", "SB-MAIN", " sb-main" }) {
            assertFalse(AuthStorageKeys.isAllowed(key));
            assertFalse(AuthStorageKeys.isTemporary(key));
        }
    }
}
