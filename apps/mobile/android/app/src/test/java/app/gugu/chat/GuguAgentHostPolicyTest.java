package app.gugu.chat;

import org.junit.Test;
import static org.junit.Assert.*;

public class GuguAgentHostPolicyTest {
    private static final String OWNER = "66a943dd-7452-412c-bfca-1b4f74346c46";
    private static final String INSTALL = "279fb3e0-b1df-49da-a8ae-5b16ded76550";

    @Test public void canonicalOwnerAndMatchingPhoneAreAccepted() {
        assertEquals(OWNER, GuguAgentHostPolicy.owner(OWNER.toUpperCase()));
        GuguAgentHostPolicy.device(OWNER, INSTALL, "phone-" + INSTALL + "-" + OWNER);
    }
    @Test(expected = IllegalArgumentException.class) public void shortUuidCannotSelectAnotherDirectory() {
        GuguAgentHostPolicy.owner("1-1-1-1-1");
    }
    @Test(expected = IllegalArgumentException.class) public void pathIsNotAnOwner() {
        GuguAgentHostPolicy.owner("../../phone-agent");
    }
    @Test(expected = IllegalArgumentException.class) public void otherOwnersPhoneIsRejected() {
        GuguAgentHostPolicy.device(OWNER, INSTALL, "phone-" + INSTALL + "-" + INSTALL);
    }
    @Test public void httpsEndpointIsAccepted() { GuguAgentHostPolicy.endpoint("https://test.example.invalid"); }
    @Test(expected = IllegalArgumentException.class) public void insecureEndpointIsRejected() { GuguAgentHostPolicy.endpoint("http://test.example.invalid"); }
    @Test(expected = IllegalArgumentException.class) public void endpointCredentialsAreRejected() { GuguAgentHostPolicy.endpoint("https://password@test.example.invalid"); }
    @Test public void runtimeErrorRedactsCredentialAndBearerButKeepsDiagnosis() {
        String message = GuguAgentHostPolicy.publicMessage("refresh denied refresh-secret, Bearer header-secret", "refresh-secret");
        assertEquals("refresh denied [redacted], Bearer [redacted]", message);
        assertEquals("network unavailable", GuguAgentHostPolicy.publicMessage("network unavailable", "unused-secret"));
    }
}
