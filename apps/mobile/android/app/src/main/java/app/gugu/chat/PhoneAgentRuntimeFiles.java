package app.gugu.chat;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Comparator;
import java.util.stream.Stream;

final class PhoneAgentRuntimeFiles {
    static String directoryName(String versionName, long lastUpdateTime) {
        return versionName + "-" + lastUpdateTime;
    }

    /** The caller supplies only directories inside its private embedded-node root. */
    static File[] obsoleteDirectories(String versionName, long lastUpdateTime, File[] directories) {
        String current = directoryName(versionName, lastUpdateTime);
        return directories == null ? new File[0] : Arrays.stream(directories)
            .filter(directory -> !directory.getName().equals(current)).toArray(File[]::new);
    }

    /** Do not follow library symlinks or let an obsolete cache block a new runtime. */
    static IOException remove(File directory) {
        try (Stream<Path> paths = Files.walk(directory.toPath())) {
            for (Path path : paths.sorted(Comparator.reverseOrder()).toArray(Path[]::new)) Files.delete(path);
            return null;
        } catch (IOException error) { return error; }
    }
}
