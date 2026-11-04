package app.gugu.chat;

/** Foreground startup budget. Paused/background time cannot turn a healthy launch into failure. */
final class StartupDeadline {
    private long remainingMs;
    private long resumedAt = -1;

    StartupDeadline(long budgetMs) {
        remainingMs = budgetMs;
    }

    long resume(long now) {
        if (resumedAt < 0) resumedAt = now;
        return remaining(now);
    }

    void pause(long now) {
        remainingMs = remaining(now);
        resumedAt = -1;
    }

    long remaining(long now) {
        if (resumedAt < 0) return remainingMs;
        return Math.max(0, remainingMs - Math.max(0, now - resumedAt));
    }

    boolean resumed() {
        return resumedAt >= 0;
    }
}
