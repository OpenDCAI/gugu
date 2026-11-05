package app.gugu.chat;

/** Local startup policy; storage failure must never trap the app behind the new surface. */
final class StartupPolicy {
    interface Store {
        String read();
        boolean write(String mode);
    }

    private static final String ENABLED = "enabled-v1";
    private static final String DISABLED = "disabled-v1";

    private StartupPolicy() {}

    static boolean supportsPlatform(int sdk) { return sdk >= 31; }

    static boolean enabled(Store store, int sdk) {
        // Older systems cannot mirror an app-only night preference into the system launch window.
        if (!supportsPlatform(sdk)) return false;
        try {
            String mode = store.read();
            return mode == null || ENABLED.equals(mode);
        } catch (RuntimeException failure) {
            return false;
        }
    }

    static boolean setEnabled(Store store, boolean enabled) {
        try {
            return store.write(enabled ? ENABLED : DISABLED);
        } catch (RuntimeException failure) {
            return false;
        }
    }
}
