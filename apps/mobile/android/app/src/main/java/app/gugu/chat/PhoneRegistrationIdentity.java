package app.gugu.chat;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** A registration belongs to the native installation, never to a WebView origin. */
final class PhoneRegistrationIdentity {
    interface Legacy { String read() throws Exception; }

    static final class LegacyHost {
        final String owner, packageName, nativeKey, installId, deviceId;
        LegacyHost(String owner, String packageName, String nativeKey, String installId, String deviceId) {
            this.owner = owner; this.packageName = packageName; this.nativeKey = nativeKey; this.installId = installId; this.deviceId = deviceId;
        }
    }

    static String adoptHost(String owner, String packageName, String nativeKey, String previousKey, LegacyHost host) throws IOException {
        if (!owner.equals(host.owner) || !packageName.equals(host.packageName)
            || !(nativeKey.equals(host.nativeKey) || (previousKey != null && previousKey.equals(host.nativeKey)))
            || !("phone-" + uuid(host.installId) + "-" + uuid(owner)).equals(host.deviceId))
            throw new IOException("原有手机登记无法验证安装连续性");
        return host.installId;
    }

    static synchronized String open(File root, String installationKey, Legacy legacy, PhoneInstallationIdentity.Commit commit) throws Exception {
        uuid(installationKey);
        File marker = new File(root.getCanonicalFile(), "phone-installation/registration");
        if (!marker.getCanonicalFile().equals(marker.getAbsoluteFile())) throw new IOException("Invalid registration identity path");
        if (marker.exists()) {
            if (!marker.isFile() || marker.length() > 256) throw new IOException("Invalid registration identity");
            byte[] bytes = new byte[257];
            int length = 0;
            try (FileInputStream input = new FileInputStream(marker)) {
                int count;
                while (length < bytes.length && (count = input.read(bytes, length, bytes.length - length)) != -1) length += count;
            }
            if (length > 256) throw new IOException("Invalid registration identity");
            String[] lines = new String(bytes, 0, length, StandardCharsets.UTF_8).split("\n", -1);
            if (lines.length != 4 || !"1".equals(lines[0]) || !installationKey.equals(lines[1]) || !lines[3].isEmpty())
                throw new IOException("Registration does not belong to this installation");
            return uuid(lines[2]);
        }
        // Resolve legacy state before committing anything. A failed migration must not create a third identity.
        String previous = legacy.read();
        String registration = previous == null ? installationKey : uuid(previous);
        File directory = marker.getParentFile();
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create registration storage");
        File temporary = File.createTempFile("registration-", ".tmp", directory);
        try {
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(("1\n" + installationKey + "\n" + registration + "\n").getBytes(StandardCharsets.UTF_8));
                output.getFD().sync();
            }
            commit.move(temporary, marker);
        } finally {
            if (temporary.exists() && !temporary.delete()) throw new IOException("Cannot remove incomplete registration");
        }
        return registration;
    }

    private static String uuid(String value) throws IOException {
        try {
            if (value != null && UUID.fromString(value).toString().equals(value)) return value;
        } catch (IllegalArgumentException ignored) { }
        throw new IOException("Invalid registration UUID");
    }
}
