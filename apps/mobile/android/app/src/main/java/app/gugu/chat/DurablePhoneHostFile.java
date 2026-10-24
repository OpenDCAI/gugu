package app.gugu.chat;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.UUID;

/** A rename alone does not persist a file's bytes across device/emulator shutdown. */
final class DurablePhoneHostFile {
    interface Commit { void move(File source, File target) throws Exception; }
    static void write(File target, byte[] bytes) throws Exception {
        write(target, bytes, (source, destination) -> Files.move(source.toPath(), destination.toPath(),
            StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING));
    }
    static void write(File target, byte[] bytes, Commit commit) throws Exception {
        if (bytes.length == 0) throw new IllegalArgumentException("Refusing empty phone host state");
        File directory = target.getParentFile();
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("Cannot create phone host directory");
        File temporary = new File(directory, target.getName() + "." + UUID.randomUUID() + ".tmp");
        try {
            try (FileOutputStream stream = new FileOutputStream(temporary)) {
                stream.write(bytes);
                stream.getFD().sync();
            }
            commit.move(temporary, target);
            try (FileChannel parent = FileChannel.open(directory.toPath(), StandardOpenOption.READ)) { parent.force(true); }
        } finally { Files.deleteIfExists(temporary.toPath()); }
    }
}
