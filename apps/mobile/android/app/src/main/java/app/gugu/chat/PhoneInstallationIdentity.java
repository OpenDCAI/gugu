package app.gugu.chat;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Installation consent is bound to a durable identity that Android backup cannot restore. */
final class PhoneInstallationIdentity {
    private PhoneInstallationIdentity() {}

    static final class Identity {
        final String key;
        final String previousKey;
        Identity(String key, String previousKey) { this.key = key; this.previousKey = previousKey; }
    }

    interface LegacyKey { String read() throws IOException; }
    interface Revoke { void run() throws IOException; }
    interface Commit { void move(File temporary, File target) throws IOException; }

    /** Native components share one Android process; serialize initialization before granting access. */
    static synchronized Identity open(File noBackupDirectory, LegacyKey legacyKey, Revoke revoke, Commit commit) throws IOException {
        if (noBackupDirectory == null) throw new IOException("Missing installation storage");
        File root = noBackupDirectory.getCanonicalFile();
        File marker = new File(root, "phone-installation/identity");
        if (!marker.getCanonicalFile().equals(marker.getAbsoluteFile())) throw new IOException("Invalid installation identity path");
        if (marker.exists()) {
            if (!marker.isFile() || marker.length() > 256) throw new IOException("Invalid installation identity");
            try (FileInputStream input = new FileInputStream(marker); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[257];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    bytes.write(buffer, 0, count);
                    if (bytes.size() > 256) throw new IOException("Invalid installation identity");
                }
                return decode(bytes.toByteArray());
            }
        }

        // Only a real journal under no_backup proves a pre-marker installation. Runtime preparation
        // can create directories, while backed-up preferences and encrypted config are not anchors.
        String previous = hasLegacyHost(root) ? legacyKey.read() : null;
        if (previous != null && !previous.matches("[0-9a-f]{16}")) throw new IOException("Invalid previous installation identity");
        if (previous == null) revoke.run();
        Identity created = new Identity(UUID.randomUUID().toString(), previous);
        persist(marker, created, commit);
        return created;
    }

    private static Identity decode(byte[] bytes) throws IOException {
        String[] lines = new String(bytes, StandardCharsets.UTF_8).split("\n", -1);
        if (lines.length != 4 || !"1".equals(lines[0]) || !canonicalUuid(lines[1]) || !lines[3].isEmpty()
            || (!lines[2].isEmpty() && !lines[2].matches("[0-9a-f]{16}"))) throw new IOException("Invalid installation identity");
        return new Identity(lines[1], lines[2].isEmpty() ? null : lines[2]);
    }

    private static void persist(File marker, Identity identity, Commit commit) throws IOException {
        File directory = marker.getParentFile();
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create installation storage");
        File temporary = File.createTempFile("identity-", ".tmp", directory);
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(("1\n" + identity.key + "\n" + (identity.previousKey == null ? "" : identity.previousKey) + "\n").getBytes(StandardCharsets.UTF_8));
                output.getFD().sync();
            }
            // Do not publish an identity if the filesystem cannot commit it atomically.
            commit.move(temporary, marker);
        } finally {
            if (temporary.exists() && !temporary.delete()) throw new IOException("Cannot remove incomplete installation identity");
        }
    }

    private static boolean hasLegacyHost(File root) throws IOException {
        File runtime = new File(root, "phone-agent-runtime");
        if (!directory(runtime)) return false;
        File[] owners = runtime.listFiles();
        if (owners == null) throw new IOException("Cannot inspect phone runtime storage");
        for (File owner : owners) {
            String id = owner.getName();
            File hosts = new File(owner, "hosts"), journalOwner = new File(hosts, id);
            if (!canonicalUuid(id) || !directory(owner) || !directory(hosts) || !directory(journalOwner)) continue;
            File journal = new File(journalOwner, "host.json");
            if (journal.getCanonicalFile().equals(journal.getAbsoluteFile()) && journal.isFile() && journal.length() > 0) return true;
        }
        return false;
    }

    private static boolean directory(File path) throws IOException {
        if (!path.getCanonicalFile().equals(path.getAbsoluteFile())) return false;
        if (!path.exists()) return false;
        if (!path.isDirectory()) throw new IOException("Invalid phone runtime storage");
        return true;
    }

    private static boolean canonicalUuid(String value) {
        try { return UUID.fromString(value).toString().equals(value); }
        catch (IllegalArgumentException invalid) { return false; }
    }
}
