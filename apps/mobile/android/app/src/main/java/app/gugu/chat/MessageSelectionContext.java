package app.gugu.chat;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Web capabilities, scoped to one current range. Native code does not invent message permissions. */
final class MessageSelectionContext {
    static final class Action {
        final String key;
        final String label;
        final boolean disabled;
        Action(String key, String label, boolean disabled) {
            if (key == null || key.isEmpty() || label == null || label.isEmpty()) {
                throw new IllegalArgumentException("action key and label are required");
            }
            this.key = key; this.label = label; this.disabled = disabled;
        }
    }
    private String id;
    private List<Action> actions = Collections.emptyList();
    void set(String id, List<Action> next) {
        if (id == null || id.isEmpty()) throw new IllegalArgumentException("contextId is required");
        Set<String> keys = new HashSet<>();
        for (Action action : next) if (!keys.add(action.key)) throw new IllegalArgumentException("duplicate action key");
        this.id = id;
        this.actions = Collections.unmodifiableList(new ArrayList<>(next));
    }
    String id() { return id; }
    List<Action> actions() { return actions; }
    boolean canDispatch(String id, String key) {
        if (this.id == null || !this.id.equals(id)) return false;
        for (Action action : actions) if (action.key.equals(key)) return !action.disabled;
        return false;
    }
    void clear(String id) {
        if (this.id != null && this.id.equals(id)) { this.id = null; actions = Collections.emptyList(); }
    }
}
