package app.gugu.chat;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.UUID;

/** Native FileSink: pending directories cannot be addressed by a readonly FileProvider token. */
final class PrivateFileSink {
    static final int FRAME_BYTES = 512 * 1024;
    final String id = UUID.randomUUID().toString();
    private final File pending, ready, file;
    private final MessageDigest digest;
    private final long size;
    private final String expected;
    private long written;
    private boolean closed, committed;

    PrivateFileSink(File root, String name, long size, String sha256) throws Exception {
        if (size < 0 || size > 9007199254740991L || sha256 == null || !sha256.matches("[0-9a-f]{64}") ||
                name == null || name.isEmpty() || name.equals(".") || name.equals("..") || name.matches("(?s).*[\\\\/\\p{Cntrl}].*")) throw new IOException("Invalid file commitment");
        this.size = size;
        expected = sha256;
        digest = MessageDigest.getInstance("SHA-256");
        pending = new File(root, "pending-" + id);
        ready = new File(root, id);
        file = new File(pending, name);
        if (!pending.mkdirs()) throw new IOException("Could not create private file stage");
        try (FileOutputStream output = new FileOutputStream(file)) { output.getFD().sync(); }
        catch (IOException error) { pending.delete(); throw error; }
    }

    void write(byte[] bytes) throws IOException {
        if (closed || committed || bytes.length > FRAME_BYTES || bytes.length > size - written) throw fail("Invalid file frame");
        try (FileOutputStream output = new FileOutputStream(file, true)) { output.write(bytes); }
        digest.update(bytes);
        written += bytes.length;
    }

    File commit() throws IOException {
        if (closed || committed || written != size || file.length() != size) throw fail("Incomplete file stage");
        StringBuilder actual = new StringBuilder(64);
        for (byte value : digest.digest()) actual.append(String.format("%02x", value & 255));
        if (!actual.toString().equals(expected)) throw fail("File SHA-256 mismatch");
        try (FileOutputStream output = new FileOutputStream(file, true)) { output.getFD().sync(); }
        if (!file.setReadOnly() || ready.exists() || !pending.renameTo(ready)) throw fail("Could not publish verified file");
        committed = true;
        return new File(ready, file.getName());
    }

    boolean exists() { return !closed && pending.isDirectory(); }
    private IOException fail(String message) { abort(); return new IOException(message); }

    void abort() {
        File directory = committed ? ready : pending;
        new File(directory, file.getName()).delete();
        directory.delete();
        closed = true;
    }
}
