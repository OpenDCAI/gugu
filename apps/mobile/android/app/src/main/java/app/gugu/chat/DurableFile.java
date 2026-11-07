package app.gugu.chat;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

/** Replaces a file whole. Without the sync, losing power after the rename can leave the target empty. */
final class DurableFile {
    private DurableFile() {}

    static void write(File target, byte[] body) throws IOException {
        File temp = new File(target.getPath() + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temp)) {
            output.write(body);
            output.getFD().sync();
        }
        Files.move(temp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
    }
}
