package app.gugu.chat;

import org.junit.Test;
import static org.junit.Assert.*;

/** The shell's half of an App's gate (gate.ts): which origin is a gate, what it serves, where its frame may go. */
public class AppOriginsGateTest {
    @Test public void aGateOriginNamesItsApp() {
        assertEquals("board", AppOrigins.gateOf("board.gate.gugu.invalid"));
        assertEquals("board", AppOrigins.gateOf("BOARD.gate.gugu.invalid"));
        assertNull(AppOrigins.gateOf("board.apps.gugu.invalid"));
        assertNull(AppOrigins.gateOf("x.board.gate.gugu.invalid"));
        assertNull(AppOrigins.gateOf("localhost"));
        assertNull(AppOrigins.gateOf(null));
        // And an App origin is never a gate's, nor the other way round.
        assertNull(AppOrigins.appOf("board.gate.gugu.invalid"));
    }

    @Test public void aGateServesItsPageAndScriptOnly() {
        assertTrue(AppOrigins.isGatePath("/_gugu/1/gate.html"));
        assertTrue(AppOrigins.isGatePath("/_gugu/1/gate.js"));
        assertFalse(AppOrigins.isGatePath("/_gugu/1/gugu.js"));
        assertFalse(AppOrigins.isGatePath("/_gugu/1/forget.html"));
        assertFalse(AppOrigins.isGatePath("/index.html"));
        assertFalse(AppOrigins.isGatePath("/_gugu/../gate.html"));
        assertFalse(AppOrigins.isGatePath(null));
    }

    @Test public void theGatesPolicyFramesOnlyItsAppAndIsFramedOnlyByThePage() {
        String csp = AppOrigins.gateCsp("board", "https://localhost");
        assertTrue(csp.contains("frame-src https://board.apps.gugu.invalid;"));
        assertTrue(csp.contains("frame-ancestors https://localhost;"));
        assertTrue(csp.contains("script-src 'self'"));
        assertTrue(csp.startsWith("default-src 'none'"));
    }

    @Test public void aGateFramesItsOwnAppAndNothingElse() {
        assertTrue(AppOrigins.frameMayGo("board.gate.gugu.invalid", "board.apps.gugu.invalid"));
        assertFalse(AppOrigins.frameMayGo("board.gate.gugu.invalid", "radar.apps.gugu.invalid"));
        assertFalse(AppOrigins.frameMayGo("board.gate.gugu.invalid", "radar.gate.gugu.invalid"));
        assertFalse(AppOrigins.frameMayGo("board.gate.gugu.invalid", "example.com"));
        assertFalse(AppOrigins.frameMayGo("board.gate.gugu.invalid", null));
    }

    @Test public void anAppStaysInItsOriginAndCannotReachAGate() {
        assertTrue(AppOrigins.frameMayGo("board.apps.gugu.invalid", "board.apps.gugu.invalid"));
        assertFalse(AppOrigins.frameMayGo("board.apps.gugu.invalid", "board.gate.gugu.invalid"));
        assertFalse(AppOrigins.frameMayGo("board.apps.gugu.invalid", "radar.apps.gugu.invalid"));
        // No Referer at all is held to the same rule (it can go nowhere).
        assertFalse(AppOrigins.frameMayGo(null, "board.gate.gugu.invalid"));
    }

    @Test public void framesTheGuguPageOpensAreNotThisRules() {
        assertTrue(AppOrigins.frameMayGo("localhost", "board.gate.gugu.invalid"));
        assertTrue(AppOrigins.frameMayGo("localhost", "board.apps.gugu.invalid"));
        assertTrue(AppOrigins.frameMayGo("", "board.apps.gugu.invalid"));
    }
}
