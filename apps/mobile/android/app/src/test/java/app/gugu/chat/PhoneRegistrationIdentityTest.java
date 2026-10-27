package app.gugu.chat;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public class PhoneRegistrationIdentityTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private static final String KEY = "11111111-1111-4111-8111-111111111111";
    private static final String CURRENT = "22222222-2222-4222-8222-222222222222";
    private static final String OWNER = "33333333-3333-4333-8333-333333333333";
    private static final String OTHER = "44444444-4444-4444-8444-444444444444";
    private static final String PACKAGE = "app.gugu.chat.test";
    private static final PhoneInstallationIdentity.Commit ATOMIC = (source, target) -> Files.move(source.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE);

    @Test public void aNewOriginAndRestartReuseTheExistingNativeHostsRegistrationWithoutAThirdId() throws Exception {
        File root = temporary.newFolder();
        String current = PhoneRegistrationIdentity.open(root, KEY, () -> PhoneRegistrationIdentity.adoptHost(OWNER, PACKAGE, KEY, null, host(OWNER, PACKAGE, KEY)), ATOMIC);
        assertEquals(CURRENT, current);
        // A different origin has an empty or stale cache; it cannot supply another registration.
        assertEquals(current, PhoneRegistrationIdentity.open(root, KEY, () -> { fail("must not consult another origin's cache"); return OTHER; }, ATOMIC));
        assertEquals(current, PhoneRegistrationIdentity.open(root, KEY, () -> null, ATOMIC));
    }

    @Test public void aFreshPackageOrReinstallationUsesItsOwnNativeKeyAndAccountsHaveSeparateDeviceIds() throws Exception {
        assertEquals(KEY, PhoneRegistrationIdentity.open(temporary.newFolder(), KEY, () -> null, ATOMIC));
        assertEquals(OTHER, PhoneRegistrationIdentity.open(temporary.newFolder(), OTHER, () -> null, ATOMIC));
        GuguAgentHostPolicy.device(OWNER, KEY, "phone-" + KEY + "-" + OWNER);
        GuguAgentHostPolicy.device(OTHER, KEY, "phone-" + KEY + "-" + OTHER);
        try { GuguAgentHostPolicy.device(OTHER, KEY, "phone-" + KEY + "-" + OWNER); fail("cross-account ID"); }
        catch (IllegalArgumentException expected) { }
    }

    @Test public void legacyHostAdoptionRequiresTheSameAccountPackageAndNativeInstallation() throws Exception {
        for (PhoneRegistrationIdentity.LegacyHost invalid : new PhoneRegistrationIdentity.LegacyHost[] {
            host(OTHER, PACKAGE, KEY), host(OWNER, "app.gugu.chat.other", KEY), host(OWNER, PACKAGE, OTHER),
            new PhoneRegistrationIdentity.LegacyHost(OWNER, PACKAGE, KEY, CURRENT, "phone-" + CURRENT + "-" + OTHER),
        }) failure(() -> PhoneRegistrationIdentity.adoptHost(OWNER, PACKAGE, KEY, null, invalid));
        assertEquals(CURRENT, PhoneRegistrationIdentity.adoptHost(OWNER, PACKAGE, KEY, "0123456789abcdef", host(OWNER, PACKAGE, "0123456789abcdef")));
    }

    @Test public void unreadableOrInvalidLegacyStateNeverCreatesAReplacementRegistration() throws Exception {
        File root = temporary.newFolder();
        failure(() -> PhoneRegistrationIdentity.open(root, KEY, () -> { throw new IOException("cannot decrypt host"); }, ATOMIC));
        assertFalse(marker(root).exists());
        failure(() -> PhoneRegistrationIdentity.open(root, KEY, () -> "corrupt-registration", ATOMIC));
        assertFalse(marker(root).exists());
        assertEquals(CURRENT, PhoneRegistrationIdentity.open(root, KEY, () -> CURRENT, ATOMIC));
    }

    @Test public void failedAtomicCommitCanRetryMigrationWithoutPublishingAnotherIdentity() throws Exception {
        File root = temporary.newFolder();
        failure(() -> PhoneRegistrationIdentity.open(root, KEY, () -> CURRENT, (a, b) -> { throw new IOException("rename failed"); }));
        assertFalse(marker(root).exists());
        assertEquals(0, marker(root).getParentFile().list().length);
        assertEquals(CURRENT, PhoneRegistrationIdentity.open(root, KEY, () -> CURRENT, ATOMIC));
    }

    @Test public void corruptOrRestoredNativeMarkersFailInsteadOfRotatingTheRegistration() throws Exception {
        for (String body : new String[] { "partial", "1\n" + OTHER + "\n" + CURRENT + "\n", "1\n" + KEY + "\ninvalid\n" }) {
            File root = temporary.newFolder();
            assertTrue(marker(root).getParentFile().mkdirs());
            Files.write(marker(root).toPath(), body.getBytes(StandardCharsets.UTF_8));
            failure(() -> PhoneRegistrationIdentity.open(root, KEY, () -> { fail("must not remigrate corrupt marker"); return CURRENT; }, ATOMIC));
            assertEquals(body, Files.readString(marker(root).toPath()));
        }
    }

    @Test public void concurrentOriginsCommitOneNativeRegistration() throws Exception {
        File root = temporary.newFolder(); AtomicInteger migrated = new AtomicInteger();
        var callers = Executors.newFixedThreadPool(4);
        try {
            List<Future<String>> results = new ArrayList<>();
            for (int i = 0; i < 8; i++) results.add(callers.submit(() -> PhoneRegistrationIdentity.open(root, KEY, () -> { migrated.incrementAndGet(); return CURRENT; }, ATOMIC)));
            for (Future<String> result : results) assertEquals(CURRENT, result.get());
            assertEquals(1, migrated.get());
        } finally { callers.shutdownNow(); }
    }

    private static PhoneRegistrationIdentity.LegacyHost host(String owner, String pkg, String key) { return new PhoneRegistrationIdentity.LegacyHost(owner, pkg, key, CURRENT, "phone-" + CURRENT + "-" + owner); }
    private static File marker(File root) { return new File(root, "phone-installation/registration"); }
    private static void failure(Callable<?> action) throws Exception {
        try { action.call(); fail("must not publish a replacement identity"); }
        catch (IOException expected) { assertNotNull(expected.getMessage()); }
    }
}
