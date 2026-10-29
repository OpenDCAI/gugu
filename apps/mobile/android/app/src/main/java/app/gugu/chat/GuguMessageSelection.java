package app.gugu.chat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

@CapacitorPlugin(name = "GuguMessageSelection")
public class GuguMessageSelection extends Plugin {
    private MessageSelectionWebView selectionView;
    @Override public void load() {
        getActivity().runOnUiThread(() -> {
            selectionView = (MessageSelectionWebView) getBridge().getWebView();
            selectionView.setSelectionEvents(new MessageSelectionWebView.Events() {
                public void settled() {
                    getBridge().eval("document.dispatchEvent(new Event('gugu:message-selection-settled'))", ignored -> {});
                }
                public void action(String contextId, String key) {
                    notifyListeners("action", new JSObject().put("contextId", contextId).put("key", key));
                }
            });
        });
    }
    @PluginMethod public void setContext(PluginCall call) {
        String contextId = call.getString("contextId");
        JSArray input = call.getArray("actions");
        if (contextId == null || contextId.isEmpty() || input == null) { call.reject("contextId and actions are required"); return; }
        List<MessageSelectionContext.Action> actions = new ArrayList<>();
        try {
            for (int i = 0; i < input.length(); i++) {
                JSONObject action = input.getJSONObject(i);
                actions.add(new MessageSelectionContext.Action(action.getString("key"), action.getString("label"), action.optBoolean("disabled", false)));
            }
            // Validate before crossing to the UI thread.
            new MessageSelectionContext().set(contextId, actions);
        } catch (Exception error) { call.reject("invalid message actions", error); return; }
        getActivity().runOnUiThread(() -> {
            if (selectionView == null) { call.reject("selection view is unavailable"); return; }
            selectionView.setMessageContext(contextId, actions);
            call.resolve();
        });
    }
    @PluginMethod public void clearContext(PluginCall call) {
        String contextId = call.getString("contextId");
        if (contextId == null) { call.reject("contextId is required"); return; }
        getActivity().runOnUiThread(() -> {
            if (selectionView != null) selectionView.clearMessageContext(contextId);
            call.resolve();
        });
    }
    @Override protected void handleOnDestroy() {
        if (selectionView != null) selectionView.setSelectionEvents(null);
        selectionView = null;
    }
}
