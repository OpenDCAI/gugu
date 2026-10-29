package app.gugu.chat;

import android.content.Context;
import android.graphics.Rect;
import android.util.AttributeSet;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.view.MotionEvent;
import android.view.View;
import com.getcapacitor.CapacitorWebView;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Keep Chromium's selection, handles and system actions; append the web message's current actions. */
public class MessageSelectionWebView extends CapacitorWebView {
    interface Events { void settled(); void action(String contextId, String key); }
    private final MessageSelectionContext context = new MessageSelectionContext();
    private Events events;
    private ActionMode activeMode;
    private boolean touching;
    public MessageSelectionWebView(Context context, AttributeSet attrs) { super(context, attrs); }
    void setSelectionEvents(Events events) { this.events = events; }
    void setMessageContext(String id, List<MessageSelectionContext.Action> actions) {
        context.set(id, actions);
        if (activeMode != null) activeMode.invalidate();
    }
    void clearMessageContext(String id) {
        context.clear(id);
        if (activeMode != null) activeMode.invalidate();
    }
    boolean finishSelectionMode() {
        if (activeMode == null) return false;
        activeMode.finish();
        return true;
    }
    private void settled() {
        post(() -> { if (!touching && activeMode != null && events != null) events.settled(); });
    }
    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) touching = true;
        boolean handled = super.dispatchTouchEvent(event);
        if (event.getActionMasked() == MotionEvent.ACTION_UP) { touching = false; settled(); }
        if (event.getActionMasked() == MotionEvent.ACTION_CANCEL) touching = false;
        return handled;
    }
    @Override public ActionMode startActionMode(ActionMode.Callback callback, int type) {
        if (type != ActionMode.TYPE_FLOATING) return super.startActionMode(callback, type);
        return super.startActionMode(new ActionMode.Callback2() {
            final Map<Integer, String> added = new HashMap<>();
            String menuContext;
            private void append(Menu menu) {
                // Remove only entries we added. Chromium uses its own IDs, not android.R.id.copy.
                for (int id : added.keySet()) menu.removeItem(id);
                added.clear();
                menuContext = context.id();
                for (MessageSelectionContext.Action action : context.actions()) {
                    // The original native Copy is already present. Never inspect localized native titles.
                    if (action.key.equals("copy")) continue;
                    int id = View.generateViewId();
                    added.put(id, action.key);
                    menu.add(Menu.NONE, id, Menu.NONE, action.label).setEnabled(!action.disabled)
                        .setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM);
                }
            }
            @Override public boolean onCreateActionMode(ActionMode mode, Menu menu) {
                boolean created = callback.onCreateActionMode(mode, menu);
                if (created) { activeMode = mode; append(menu); settled(); }
                return created;
            }
            @Override public boolean onPrepareActionMode(ActionMode mode, Menu menu) {
                boolean changed = callback.onPrepareActionMode(mode, menu);
                append(menu); settled();
                return changed || !added.isEmpty();
            }
            @Override public boolean onActionItemClicked(ActionMode mode, MenuItem item) {
                String key = added.get(item.getItemId());
                if (key == null) return callback.onActionItemClicked(mode, item);
                if (context.canDispatch(menuContext, key) && events != null) events.action(menuContext, key);
                return true;
            }
            @Override public void onDestroyActionMode(ActionMode mode) {
                if (activeMode == mode) activeMode = null;
                callback.onDestroyActionMode(mode);
            }
            @Override public void onGetContentRect(ActionMode mode, View view, Rect rect) {
                if (callback instanceof ActionMode.Callback2) ((ActionMode.Callback2) callback).onGetContentRect(mode, view, rect);
                else super.onGetContentRect(mode, view, rect);
            }
        }, type);
    }
}
