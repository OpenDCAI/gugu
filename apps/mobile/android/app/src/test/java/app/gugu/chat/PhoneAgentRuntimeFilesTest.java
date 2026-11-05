package app.gugu.chat;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public class PhoneAgentRuntimeFilesTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void replacingTheSameVersionSelectsAnUnpreparedInstallationDirectory() throws Exception {
        File root = temporary.newFolder();
        File old = new File(root, PhoneAgentRuntimeFiles.directoryName("0.3.1", 100));
        assertTrue(old.mkdir());
        assertTrue(new File(old, "complete").createNewFile());
        File replacement = new File(root, PhoneAgentRuntimeFiles.directoryName("0.3.1", 200));
        assertEquals("0.3.1-200", replacement.getName());
        assertNotEquals(old, replacement);
        assertFalse(new File(replacement, "complete").exists());
    }

    @Test public void theSameInstallationKeepsTheCompletedDirectoryAcrossRestarts() throws Exception {
        File root = temporary.newFolder();
        File runtime = new File(root, PhoneAgentRuntimeFiles.directoryName("0.3.1", 100));
        assertTrue(runtime.mkdir());
        File complete = new File(runtime, "complete");
        assertTrue(complete.createNewFile());
        assertTrue(complete.setLastModified(123000));
        for (int restart = 0; restart < 3; restart++) {
            assertEquals(runtime, new File(root, PhoneAgentRuntimeFiles.directoryName("0.3.1", 100)));
            assertTrue(complete.exists());
            assertEquals(123000, complete.lastModified());
        }
    }

    @Test public void obsoleteSelectionIncludesLegacyAndPreviousInstallsButExcludesTheCurrentOne() {
        File legacy = new File("embedded-node/0.3.1");
        File previous = new File("embedded-node/0.3.1-100");
        File current = new File("embedded-node/0.3.1-200");
        File earlierVersion = new File("embedded-node/0.3.0-50");
        assertArrayEquals(new File[] { legacy, previous, earlierVersion },
            PhoneAgentRuntimeFiles.obsoleteDirectories("0.3.1", 200, new File[] { legacy, current, previous, earlierVersion }));
        assertArrayEquals(new File[0], PhoneAgentRuntimeFiles.obsoleteDirectories("0.3.1", 200, null));
    }

    @Test public void removalLeavesCurrentCompleteAndOwnerDataUntouchedAndDoesNotFollowLibraryLinks() throws Exception {
        Path root = temporary.newFolder().toPath();
        Path runtimeRoot = Files.createDirectory(root.resolve("embedded-node"));
        Path current = Files.createDirectory(runtimeRoot.resolve("0.3.1-200"));
        Files.write(current.resolve("complete"), new byte[0]);
        Path old = Files.createDirectories(runtimeRoot.resolve("0.3.1/lib"));
        Path userData = Files.createDirectories(root.resolve("phone-agent-runtime/owner"));
        Files.write(userData.resolve("transcript"), "keep".getBytes(StandardCharsets.UTF_8));
        Files.createSymbolicLink(old.resolve("library-link"), userData);
        for (File directory : PhoneAgentRuntimeFiles.obsoleteDirectories("0.3.1", 200, runtimeRoot.toFile().listFiles(File::isDirectory))) {
            assertNull(PhoneAgentRuntimeFiles.remove(directory));
        }
        assertFalse(runtimeRoot.resolve("0.3.1").toFile().exists());
        assertTrue(current.resolve("complete").toFile().exists());
        assertEquals("keep", new String(Files.readAllBytes(userData.resolve("transcript")), StandardCharsets.UTF_8));
        assertEquals(1, runtimeRoot.toFile().list().length);
    }

    @Test public void anOldCacheDeletionFailureIsReturnedWithoutThrowingOrRemovingTheCurrentRuntime() throws Exception {
        Path root = temporary.newFolder().toPath();
        Path current = Files.createDirectory(root.resolve("0.3.1-200"));
        Files.write(current.resolve("complete"), new byte[0]);
        Path old = Files.createDirectory(root.resolve("0.3.1-100"));
        Files.write(old.resolve("locked"), new byte[0]);
        Files.setPosixFilePermissions(old, PosixFilePermissions.fromString("r-xr-xr-x"));
        try {
            assertNotNull(PhoneAgentRuntimeFiles.remove(old.toFile()));
            assertTrue(old.resolve("locked").toFile().exists());
            assertTrue(current.resolve("complete").toFile().exists());
        } finally {
            Files.setPosixFilePermissions(old, PosixFilePermissions.fromString("rwx------"));
        }
    }
}
