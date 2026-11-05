package app.gugu.chat;

import org.junit.Test;
import static org.junit.Assert.*;

public class StartupHandoffStateTest {
    @Test public void aBrandFrameDoesNotHideAMissingMainModule() {
        StartupHandoffState state = new StartupHandoffState();
        assertTrue(state.requestFrame());
        assertTrue(state.frameDrawn(state.frameGeneration()));
        assertTrue(state.reveal());
        assertTrue(state.needsDeadline());
        assertTrue(state.freezesTone());
        assertTrue(state.fail());
        assertFalse(state.active());
    }
    @Test public void reactCommitDoesNotPrematurelyRemoveTheNativeSurface() {
        StartupHandoffState state = new StartupHandoffState();
        assertTrue(state.reactCommit());
        assertTrue(state.needsDeadline());
        assertFalse(state.reveal());
        assertTrue(state.retainSurface());
    }
    @Test public void legitimateContentLoadingHasNoNativeNetworkDeadline() {
        StartupHandoffState state = new StartupHandoffState();
        state.reactCommit(); state.requestFrame(); state.frameDrawn(state.frameGeneration()); state.reveal();
        assertFalse(state.needsDeadline());
        assertTrue(state.freezesTone());
        assertTrue(state.contentReady());
        assertFalse(state.freezesTone());
        assertFalse(state.fail());
    }
    @Test public void lateOrRepeatedFramesCannotUndoFailure() {
        StartupHandoffState state = new StartupHandoffState();
        state.requestFrame(); state.fail();
        assertFalse(state.frameDrawn(state.frameGeneration()));
        assertFalse(state.reveal());
        assertFalse(state.contentReady());
        assertFalse(state.retainSurface());
    }
    @Test public void destructionRejectsEveryLateSignal() {
        StartupHandoffState state = new StartupHandoffState();
        state.requestFrame(); state.destroy();
        assertFalse(state.frameDrawn(state.frameGeneration())); assertFalse(state.reactCommit());
        assertFalse(state.contentReady()); assertFalse(state.fail());
        assertFalse(state.needsDeadline()); assertFalse(state.reveal());
    }
    @Test public void hotResumeCannotRequestASecondBrandSequence() {
        StartupHandoffState state = new StartupHandoffState();
        assertTrue(state.requestFrame()); assertFalse(state.requestFrame());
        state.frameDrawn(state.frameGeneration()); assertTrue(state.reveal()); assertFalse(state.reveal());
        assertFalse(state.requestFrame());
    }
    @Test public void fastContentCanHandoverWithoutWaitingForBrand() {
        StartupHandoffState state = new StartupHandoffState();
        state.contentReady();
        assertTrue(state.freezesTone());
        assertTrue(state.requestFrame()); assertTrue(state.frameDrawn(state.frameGeneration())); assertTrue(state.reveal());
        assertFalse(state.needsDeadline());
        assertFalse(state.freezesTone());
    }
    @Test public void committedContentWithoutADrawStillHasAFailureExit() {
        StartupHandoffState state = new StartupHandoffState();
        state.contentReady(); state.requestContentFrame();
        assertTrue(state.needsDeadline()); assertTrue(state.retainSurface());
        assertTrue(state.isStarting()); assertTrue(state.fail());
        assertFalse(state.retainSurface());
    }
    @Test public void contentSupersedesTheEarlierBrandVisualSnapshot() {
        StartupHandoffState state = new StartupHandoffState();
        state.requestFrame(); long brand = state.frameGeneration();
        state.frameDrawn(brand); state.contentReady(); state.requestContentFrame();
        assertFalse(state.hasDrawn());
        assertFalse(state.frameDrawn(brand)); assertFalse(state.reveal());
        assertTrue(state.frameDrawn(state.frameGeneration())); assertTrue(state.reveal());
        assertFalse(state.freezesTone()); assertFalse(state.needsDeadline());
    }
}
