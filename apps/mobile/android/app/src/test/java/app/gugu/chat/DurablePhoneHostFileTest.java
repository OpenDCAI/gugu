package app.gugu.chat;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public class DurablePhoneHostFileTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    @Test public void commitHasCompleteBytesAndFailureKeepsThePreviousFile() throws Exception {
        File target = new File(temporary.newFolder(), "config.enc");
        byte[] original = "original encrypted configuration".getBytes(StandardCharsets.UTF_8);
        DurablePhoneHostFile.write(target, original);
        try {
            DurablePhoneHostFile.write(target, "replacement".getBytes(StandardCharsets.UTF_8), (source, destination) -> {
                assertEquals("replacement", new String(Files.readAllBytes(source.toPath()), StandardCharsets.UTF_8));
                assertArrayEquals(original, Files.readAllBytes(destination.toPath()));
                throw new java.io.IOException("interrupted before commit");
            });
            fail("Expected interruption");
        } catch (java.io.IOException expected) { assertEquals("interrupted before commit", expected.getMessage()); }
        assertArrayEquals(original, Files.readAllBytes(target.toPath()));
        assertEquals(1, target.getParentFile().list().length);
        try { DurablePhoneHostFile.write(target, new byte[0]); fail("Empty data accepted"); }
        catch (IllegalArgumentException expected) { assertArrayEquals(original, Files.readAllBytes(target.toPath())); }
        byte[] next = "durable replacement".getBytes(StandardCharsets.UTF_8);
        DurablePhoneHostFile.write(target, next);
        assertArrayEquals(next, Files.readAllBytes(target.toPath()));
    }
}
