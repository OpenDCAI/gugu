package app.gugu.chat;

/** One Activity hands over once; drawing the brand does not prove React or real content is ready. */
final class StartupHandoffState {
    private boolean requested;
    private boolean drawn;
    private boolean revealed;
    private boolean reactCommitted;
    private boolean contentReady;
    private boolean failed;
    private boolean destroyed;
    private long generation;

    boolean requestFrame() {
        if (!active() || requested) return false;
        requested = true;
        generation++;
        return true;
    }

    boolean requestContentFrame() {
        if (!active() || revealed) return false;
        requested = true;
        drawn = false;
        generation++;
        return true;
    }

    long frameGeneration() { return generation; }

    boolean frameDrawn(long frameGeneration) {
        if (!active() || !requested || generation != frameGeneration) return false;
        drawn = true;
        return true;
    }

    boolean reveal() {
        if (!active() || !drawn || revealed) return false;
        revealed = true;
        return true;
    }

    boolean reactCommit() {
        if (!active()) return false;
        reactCommitted = true;
        return true;
    }

    boolean contentReady() {
        if (!active()) return false;
        reactCommitted = true;
        contentReady = true;
        return true;
    }

    boolean fail() {
        if (!active() || (contentReady && revealed)) return false;
        failed = true;
        return true;
    }

    boolean active() {
        return !failed && !destroyed;
    }

    boolean retainSurface() {
        return active() && !revealed;
    }

    boolean needsDeadline() {
        return active() && (!reactCommitted || !revealed);
    }

    boolean hasDrawn() {
        return drawn;
    }

    boolean hasRevealed() {
        return revealed;
    }

    boolean freezesTone() {
        return active() && (!contentReady || !revealed);
    }

    boolean isStarting() {
        return active() && (!contentReady || !revealed);
    }

    void destroy() {
        destroyed = true;
    }
}
