package app.gugu.chat;

import java.util.Arrays;
import java.util.Collections;
import org.junit.Test;
import static org.junit.Assert.*;

public class MessageSelectionContextTest {
    private MessageSelectionContext.Action action(String key) {
        return new MessageSelectionContext.Action(key, key, false);
    }
    @Test public void preservesEveryWebCapabilityIncludingLaterExtensions() {
        MessageSelectionContext context = new MessageSelectionContext();
        context.set("message-a", Arrays.asList(action("reply"), action("forward"), action("delete"), action("keep")));
        assertEquals(4, context.actions().size());
        assertTrue(context.canDispatch("message-a", "keep"));
        assertTrue(context.canDispatch("message-a", "delete"));
        assertFalse(context.canDispatch("message-a", "invented-action"));
    }
    @Test public void cannotReplayAnOldMessageActionAfterSelectionMoves() {
        MessageSelectionContext context = new MessageSelectionContext();
        context.set("message-a", Collections.singletonList(action("delete")));
        context.set("message-b", Collections.singletonList(action("reply")));
        assertFalse(context.canDispatch("message-a", "delete"));
        assertFalse(context.canDispatch("message-b", "delete"));
        assertTrue(context.canDispatch("message-b", "reply"));
    }
    @Test public void staleClearsCannotRemoveAnotherMessagesActions() {
        MessageSelectionContext context = new MessageSelectionContext();
        context.set("message-a", Collections.singletonList(action("reply")));
        context.set("message-b", Collections.singletonList(action("forward")));
        context.clear("message-a");
        assertTrue(context.canDispatch("message-b", "forward"));
        context.clear("message-b");
        assertTrue(context.actions().isEmpty());
        assertFalse(context.canDispatch("message-b", "forward"));
    }
    @Test public void keepsDisabledActionsVisibleButNeverDispatchesThem() {
        MessageSelectionContext context = new MessageSelectionContext();
        context.set("message-a", Collections.singletonList(new MessageSelectionContext.Action("forward", "Forward", true)));
        assertEquals(1, context.actions().size());
        assertFalse(context.canDispatch("message-a", "forward"));
    }
    @Test public void rejectsAmbiguousDuplicateActionKeys() {
        MessageSelectionContext context = new MessageSelectionContext();
        try { context.set("message-a", Arrays.asList(action("reply"), action("reply"))); fail("duplicate action"); }
        catch (IllegalArgumentException expected) { }
    }
}
