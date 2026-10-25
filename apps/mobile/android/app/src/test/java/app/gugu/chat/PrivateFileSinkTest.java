package app.gugu.chat;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.UUID;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

/** JVM tests exercise the production sink; no Android framework or emulator is involved. */
public class PrivateFileSinkTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private interface Operation { void run() throws Exception; }

    private static String sha(byte[] bytes) throws Exception {
        StringBuilder result = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) result.append(String.format("%02x", value & 255));
        return result.toString();
    }

    private static void refuses(Operation operation) throws Exception {
        try { operation.run(); fail("an invalid stage must not publish a file"); }
        catch (IOException expected) { assertNotNull(expected.getMessage()); }
    }

    private static byte[] binary(int size) {
        byte[] bytes = new byte[size];
        for (int index = 0; index < size; index++) bytes[index] = (byte) (index % 251);
        return bytes;
    }

    @Test public void onlyAnExactVerifiedOriginalPublishesTheOpaqueTokenDirectory() throws Exception {
        File root = temporary.newFolder();
        byte[] bytes = binary(PrivateFileSink.FRAME_BYTES * 2 + 9);
        PrivateFileSink sink = new PrivateFileSink(root, "原文件.bin", bytes.length, sha(bytes));
        assertEquals(sink.id, UUID.fromString(sink.id).toString());
        assertArrayEquals(new String[] { "pending-" + sink.id }, root.list());
        File target = new File(new File(root, sink.id), "原文件.bin");
        for (int offset = 0; offset < bytes.length; offset += PrivateFileSink.FRAME_BYTES) {
            assertFalse(target.exists());
            sink.write(Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + PrivateFileSink.FRAME_BYTES)));
        }
        assertFalse(target.exists());
        assertEquals(target, sink.commit());
        assertArrayEquals(bytes, Files.readAllBytes(target.toPath()));
        assertArrayEquals(new String[] { sink.id }, root.list());
        assertFalse("published snapshots must not be writable", target.canWrite());
        assertFalse(sink.exists());
        sink.abort();
        assertArrayEquals(new String[0], root.list());
    }

    @Test public void zeroByteFilesStillCheckTheFinalShaBeforePublication() throws Exception {
        File root = temporary.newFolder();
        PrivateFileSink empty = new PrivateFileSink(root, "empty", 0, sha(new byte[0]));
        assertEquals(0, empty.commit().length());
        empty.abort();
        PrivateFileSink bad = new PrivateFileSink(root, "bad", 0, sha(new byte[] { 1 }));
        refuses(bad::commit);
        assertArrayEquals(new String[0], root.list());
    }

    @Test public void oversizedFramesAreRejectedBeforeAppendingAndDestroyOnlyTheirOwnStage() throws Exception {
        File root = temporary.newFolder();
        File other = new File(root, "unrelated");
        Files.write(other.toPath(), new byte[] { 7 });
        byte[] bytes = binary(PrivateFileSink.FRAME_BYTES + 1);
        PrivateFileSink sink = new PrivateFileSink(root, "large", bytes.length, sha(bytes));
        refuses(() -> sink.write(bytes));
        assertFalse(sink.exists());
        assertArrayEquals(new String[] { "unrelated" }, root.list());
        assertArrayEquals(new byte[] { 7 }, Files.readAllBytes(other.toPath()));
        refuses(sink::commit);
    }

    @Test public void extraBytesAndPrematureEofNeverPublishAPartialFile() throws Exception {
        File root = temporary.newFolder();
        PrivateFileSink extra = new PrivateFileSink(root, "extra", 1, sha(new byte[] { 1 }));
        extra.write(new byte[] { 1 });
        refuses(() -> extra.write(new byte[] { 2 }));
        PrivateFileSink shortFile = new PrivateFileSink(root, "short", 2, sha(new byte[] { 1, 2 }));
        shortFile.write(new byte[] { 1 });
        refuses(shortFile::commit);
        assertArrayEquals(new String[0], root.list());
    }

    @Test public void aFailedDigestCannotBeRetriedAfterMessageDigestResetsToEmpty() throws Exception {
        File root = temporary.newFolder();
        PrivateFileSink sink = new PrivateFileSink(root, "wrong", 1, sha(new byte[0]));
        sink.write(new byte[] { 1 });
        refuses(sink::commit);
        refuses(sink::commit);
        refuses(() -> sink.write(new byte[0]));
        assertArrayEquals(new String[0], root.list());
    }

    @Test public void externalTruncationIsNotMistakenForTheCommittedStream() throws Exception {
        File root = temporary.newFolder();
        PrivateFileSink sink = new PrivateFileSink(root, "changed", 2, sha(new byte[] { 1, 2 }));
        sink.write(new byte[] { 1, 2 });
        Files.write(new File(root, "pending-" + sink.id + "/changed").toPath(), new byte[] { 1 });
        refuses(sink::commit);
        assertArrayEquals(new String[0], root.list());
    }

    @Test public void invalidSizesDigestsAndPathNamesNeverAllocateAStage() throws Exception {
        File root = temporary.newFolder();
        for (long size : new long[] { -1, 9007199254740992L }) refuses(() -> new PrivateFileSink(root, "file", size, sha(new byte[0])));
        for (String digest : new String[] { null, "", "a".repeat(63), "A".repeat(64), "g".repeat(64) })
            refuses(() -> new PrivateFileSink(root, "file", 0, digest));
        for (String name : new String[] { null, "", ".", "..", "../escape", "a/b", "a\\b", "line\nfeed", "nul\u0000byte" })
            refuses(() -> new PrivateFileSink(root, name, 0, sha(new byte[0])));
        assertArrayEquals(new String[0], root.list());
    }

    @Test public void interleavedStagesRemainIndependentAndAbortIsIdempotent() throws Exception {
        File root = temporary.newFolder();
        PrivateFileSink one = new PrivateFileSink(root, "same.bin", 1, sha(new byte[] { 1 }));
        PrivateFileSink two = new PrivateFileSink(root, "same.bin", 1, sha(new byte[] { 2 }));
        one.write(new byte[] { 1 }); two.write(new byte[] { 2 });
        one.abort(); one.abort();
        refuses(one::commit);
        File published = two.commit();
        assertArrayEquals(new byte[] { 2 }, Files.readAllBytes(published.toPath()));
        assertArrayEquals(new String[] { two.id }, root.list());
        two.abort();
    }

    @Test public void anExistingTokenDirectoryCannotBeOverwritten() throws Exception {
        File root = temporary.newFolder();
        PrivateFileSink sink = new PrivateFileSink(root, "file", 1, sha(new byte[] { 1 }));
        File collision = new File(root, sink.id);
        assertTrue(collision.mkdir());
        Files.write(new File(collision, "preserve").toPath(), new byte[] { 8 });
        sink.write(new byte[] { 1 });
        refuses(sink::commit);
        assertArrayEquals(new String[] { sink.id }, root.list());
        assertArrayEquals(new byte[] { 8 }, Files.readAllBytes(new File(collision, "preserve").toPath()));
    }
}
