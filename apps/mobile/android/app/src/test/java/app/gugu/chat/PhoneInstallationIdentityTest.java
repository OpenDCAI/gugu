package app.gugu.chat;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public class PhoneInstallationIdentityTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private static final String OWNER = "11111111-1111-4111-8111-111111111111";
    private static final String PREVIOUS = "0123456789abcdef";
    private static final PhoneInstallationIdentity.Commit ATOMIC = (source, target) ->
        Files.move(source.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE);

    @Test public void freshInstallRevokesBeforePublishingAndKeepsOneDurableRandomIdentity() throws Exception {
        File root = temporary.newFolder();
        AtomicInteger revoked = new AtomicInteger();
        PhoneInstallationIdentity.Identity first = PhoneInstallationIdentity.open(root, () -> { fail("no continuity anchor"); return PREVIOUS; }, () -> {
            assertFalse(marker(root).exists());
            revoked.incrementAndGet();
        }, (source, target) -> {
            assertEquals(1, revoked.get());
            assertFalse(target.exists());
            ATOMIC.move(source, target);
        });
        assertEquals(first.key, UUID.fromString(first.key).toString());
        assertNull(first.previousKey);
        PhoneInstallationIdentity.Identity second = PhoneInstallationIdentity.open(root, () -> { fail("already initialized"); return null; }, () -> fail("already initialized"), ATOMIC);
        assertEquals(first.key, second.key);
        assertNull(second.previousKey);
        assertEquals(1, revoked.get());
        assertEquals(1, marker(root).getParentFile().list().length);
    }

    @Test public void aRealNoBackupHostPreservesUpgradeConsentAndStoresTheTrustedLegacyKey() throws Exception {
        File root = temporary.newFolder();
        File journal = journal(root, OWNER, OWNER, "synthetic existing tasks");
        byte[] original = Files.readAllBytes(journal.toPath());
        PhoneInstallationIdentity.Identity first = PhoneInstallationIdentity.open(root, () -> PREVIOUS, () -> fail("existing installation must retain consent"), ATOMIC);
        assertEquals(PREVIOUS, first.previousKey);
        assertArrayEquals(original, Files.readAllBytes(journal.toPath()));
        assertTrue(journal.delete());
        // A native permission read can initialize before deviceInfo asks for migration metadata.
        PhoneInstallationIdentity.Identity afterPermissionRead = PhoneInstallationIdentity.open(root, () -> { fail("read the persisted marker"); return null; }, () -> fail("must not revoke twice"), ATOMIC);
        assertEquals(first.key, afterPermissionRead.key);
        assertEquals(PREVIOUS, afterPermissionRead.previousKey);
    }

    @Test public void preparedDirectoriesAndAnEmptyJournalNeverProveInstallationContinuity() throws Exception {
        for (boolean emptyJournal : new boolean[] { false, true }) {
            File root = temporary.newFolder();
            File journal = journal(root, OWNER, OWNER, "");
            if (!emptyJournal) assertTrue(journal.delete());
            AtomicInteger revoked = new AtomicInteger();
            PhoneInstallationIdentity.Identity identity = PhoneInstallationIdentity.open(root, () -> { fail("directory is not an anchor"); return PREVIOUS; }, revoked::incrementAndGet, ATOMIC);
            assertNull(identity.previousKey);
            assertEquals(1, revoked.get());
        }
    }

    @Test public void backedUpPreferencesAndFilesCannotStandInForANoBackupJournal() throws Exception {
        File backedUp = temporary.newFolder(), noBackup = temporary.newFolder();
        journal(backedUp, OWNER, OWNER, "synthetic restored tasks");
        Files.write(new File(backedUp, "phone-agent-grants.xml").toPath(), "synthetic old consent".getBytes(StandardCharsets.UTF_8));
        AtomicBoolean restoredGrant = new AtomicBoolean(true), collecting = new AtomicBoolean(true);
        PhoneInstallationIdentity.Identity identity = PhoneInstallationIdentity.open(noBackup, () -> { fail("no non-backed-up anchor"); return PREVIOUS; }, () -> {
            restoredGrant.set(false);
            collecting.set(false);
        }, ATOMIC);
        assertFalse(restoredGrant.get());
        assertFalse(collecting.get());
        assertNull(identity.previousKey);
    }

    @Test public void invalidOrMismatchedOwnerPathsCannotAuthorizeLegacyMigration() throws Exception {
        for (String directory : new String[] { "not-an-owner", OWNER }) {
            File root = temporary.newFolder();
            journal(root, directory, "22222222-2222-4222-8222-222222222222", "not the exact host path");
            AtomicInteger revoked = new AtomicInteger();
            PhoneInstallationIdentity.Identity identity = PhoneInstallationIdentity.open(root, () -> { fail("invalid path"); return PREVIOUS; }, revoked::incrementAndGet, ATOMIC);
            assertNull(identity.previousKey);
            assertEquals(1, revoked.get());
        }
    }

    @Test public void aSymlinkedJournalCannotImportContinuityFromElsewhere() throws Exception {
        File root = temporary.newFolder();
        File outside = temporary.newFile();
        Files.write(outside.toPath(), "synthetic outside journal".getBytes(StandardCharsets.UTF_8));
        File link = journal(root, OWNER, OWNER, "");
        assertTrue(link.delete());
        Files.createSymbolicLink(link.toPath(), outside.toPath());
        AtomicInteger revoked = new AtomicInteger();
        PhoneInstallationIdentity.Identity identity = PhoneInstallationIdentity.open(root, () -> { fail("linked journal is not an anchor"); return PREVIOUS; }, revoked::incrementAndGet, ATOMIC);
        assertNull(identity.previousKey);
        assertEquals(1, revoked.get());
    }

    @Test public void missingLegacyDeviceIdCannotRestoreConsentEvenWithAnOldHost() throws Exception {
        File root = temporary.newFolder();
        journal(root, OWNER, OWNER, "synthetic host");
        AtomicInteger revoked = new AtomicInteger();
        PhoneInstallationIdentity.Identity identity = PhoneInstallationIdentity.open(root, () -> null, revoked::incrementAndGet, ATOMIC);
        assertNull(identity.previousKey);
        assertEquals(1, revoked.get());
    }

    @Test public void failedGrantClearDoesNotCommitAnIdentityAndCanBeRetried() throws Exception {
        File root = temporary.newFolder();
        AtomicBoolean mayClear = new AtomicBoolean(false);
        PhoneInstallationIdentity.Revoke clear = () -> { if (!mayClear.get()) throw new IOException("cannot clear consent"); };
        expectFailure(() -> PhoneInstallationIdentity.open(root, () -> PREVIOUS, clear, ATOMIC));
        assertFalse(marker(root).exists());
        mayClear.set(true);
        assertNotNull(PhoneInstallationIdentity.open(root, () -> PREVIOUS, clear, ATOMIC).key);
    }

    @Test public void failedAtomicCommitReturnsNoIdentityAndNeverLeavesAPartialMarker() throws Exception {
        File root = temporary.newFolder();
        AtomicInteger revoked = new AtomicInteger();
        expectFailure(() -> PhoneInstallationIdentity.open(root, () -> PREVIOUS, revoked::incrementAndGet,
            (source, target) -> { assertTrue(source.length() > 0); throw new IOException("atomic rename failed"); }));
        assertFalse(marker(root).exists());
        assertEquals(0, marker(root).getParentFile().list().length);
        assertNotNull(PhoneInstallationIdentity.open(root, () -> PREVIOUS, revoked::incrementAndGet, ATOMIC).key);
        assertEquals(2, revoked.get());
    }

    @Test public void storageCreationFailureCannotReturnAnIdentity() throws Exception {
        File root = temporary.newFolder();
        Files.write(new File(root, "phone-installation").toPath(), new byte[] { 1 });
        AtomicInteger revoked = new AtomicInteger();
        expectFailure(() -> PhoneInstallationIdentity.open(root, () -> PREVIOUS, revoked::incrementAndGet, ATOMIC));
        assertFalse(marker(root).exists());
    }

    @Test public void corruptSavedIdentityFailsClosedInsteadOfRotatingOrClaimingAnOldHost() throws Exception {
        for (String body : new String[] { "", "partial", "1\nnot-a-uuid\n\n", "1\n" + OWNER + "\nuntrusted-previous\n" }) {
            File root = temporary.newFolder();
            journal(root, OWNER, OWNER, "synthetic old host");
            assertTrue(marker(root).getParentFile().mkdirs());
            Files.write(marker(root).toPath(), body.getBytes(StandardCharsets.UTF_8));
            expectFailure(() -> PhoneInstallationIdentity.open(root, () -> { fail("must not remigrate corrupt markers"); return PREVIOUS; }, () -> fail("must not replace a committed identity"), ATOMIC));
            assertEquals(body, new String(Files.readAllBytes(marker(root).toPath()), StandardCharsets.UTF_8));
        }
    }

    @Test public void anUnreadableMarkerShapeOrLegacyReadFailureDoesNotEnableNativeAccess() throws Exception {
        File malformed = temporary.newFolder();
        assertTrue(marker(malformed).mkdirs());
        expectFailure(() -> PhoneInstallationIdentity.open(malformed, () -> PREVIOUS, () -> fail("cannot recreate malformed marker"), ATOMIC));
        File anchored = temporary.newFolder();
        journal(anchored, OWNER, OWNER, "synthetic old host");
        expectFailure(() -> PhoneInstallationIdentity.open(anchored, () -> { throw new IOException("cannot read legacy identity"); }, () -> fail("cannot proceed after failed read"), ATOMIC));
        assertFalse(marker(anchored).exists());
    }

    @Test public void concurrentPermissionAndDeviceInfoInitializationShareOneCommittedIdentity() throws Exception {
        File root = temporary.newFolder();
        AtomicInteger revoked = new AtomicInteger();
        ExecutorService callers = Executors.newFixedThreadPool(4);
        try {
            List<Future<PhoneInstallationIdentity.Identity>> results = new ArrayList<>();
            for (int index = 0; index < 8; index++) results.add(callers.submit(() -> PhoneInstallationIdentity.open(root, () -> PREVIOUS, revoked::incrementAndGet, ATOMIC)));
            String key = results.get(0).get().key;
            for (Future<PhoneInstallationIdentity.Identity> result : results) assertEquals(key, result.get().key);
            assertEquals(1, revoked.get());
        } finally { callers.shutdownNow(); }
    }

    private static File marker(File root) { return new File(root, "phone-installation/identity"); }
    private static File journal(File root, String ownerDirectory, String journalOwner, String contents) throws IOException {
        File journal = new File(root, "phone-agent-runtime/" + ownerDirectory + "/hosts/" + journalOwner + "/host.json");
        if (!journal.getParentFile().isDirectory()) assertTrue(journal.getParentFile().mkdirs());
        Files.write(journal.toPath(), contents.getBytes(StandardCharsets.UTF_8));
        return journal;
    }
    private static void expectFailure(Callable<?> action) throws Exception {
        try { action.call(); fail("native installation must stay unavailable"); }
        catch (IOException expected) { assertNotNull(expected.getMessage()); }
    }
}
