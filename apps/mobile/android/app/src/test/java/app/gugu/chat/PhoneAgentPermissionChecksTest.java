package app.gugu.chat;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

public class PhoneAgentPermissionChecksTest {
    @Test public void allNineCategoriesCanBeAdmittedWithoutDeliveryProofs() throws Exception {
        List<String> groups = Arrays.asList("calendar", "contacts", "location", "notifications", "alarm", "health", "sms", "recordings", "photos");
        List<String> checked = new ArrayList<>();
        PhoneAgentPermissionChecks.preflight(groups, checked::add);
        assertEquals(groups, checked);
    }

    @Test(expected = SecurityException.class) public void preflightStillRejectsARevokedCategory() throws Exception {
        PhoneAgentPermissionChecks.preflight(Collections.singletonList("photos"), (group) -> { throw new SecurityException("category revoked"); });
    }

    @Test public void prooflessDeliveryStillUsesTheStrictLegacyCheckerForEveryCategory() throws Exception {
        for (String group : Arrays.asList("location", "alarm", "health", "recordings", "photos", "notifications")) {
            List<String> checked = new ArrayList<>();
            try {
                PhoneAgentPermissionChecks.delivery(Collections.singletonList(group), Collections.<String>emptyList(), checked::add,
                    (legacy) -> { assertEquals(group, legacy); throw new SecurityException("delivery proof required"); },
                    (proof) -> fail("there is no proof"));
                fail("must not admit proofless delivery");
            } catch (SecurityException expected) { assertEquals("delivery proof required", expected.getMessage()); }
            assertEquals(Collections.singletonList(group), checked);
        }
    }

    @Test public void actualNativeProofsReplaceLegacyChecksIncludingAnAlarmWithNoOsPermissions() throws Exception {
        for (String group : Arrays.asList("location", "alarm", "health", "recordings", "photos", "notifications")) {
            Object capturedProof = new Object();
            List<Object> checked = new ArrayList<>();
            PhoneAgentPermissionChecks.delivery(Collections.singletonList(group), Collections.singletonList(capturedProof),
                (granted) -> assertEquals(group, granted), (legacy) -> fail("captured proof must not require legacy permissions"), checked::add);
            assertEquals(Collections.singletonList(capturedProof), checked);
        }
    }

    @Test public void revocationBeforeDeliveryRejectsBothAGroupAndAnActualOsProof() throws Exception {
        for (boolean revokeGroup : new boolean[] { true, false }) {
            try {
                PhoneAgentPermissionChecks.delivery(Collections.singletonList("health"), Collections.singletonList("actual-health-proof"),
                    (group) -> { if (revokeGroup) throw new SecurityException("group revoked"); }, (legacy) -> fail("not legacy"),
                    (proof) -> { assertEquals("actual-health-proof", proof); throw new SecurityException("OS permission revoked"); });
                fail("revoked delivery must fail");
            } catch (SecurityException expected) { assertEquals(revokeGroup ? "group revoked" : "OS permission revoked", expected.getMessage()); }
        }
    }
}
