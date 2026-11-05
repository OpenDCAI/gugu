import { ownedAgentResourceTabs } from '@/lib/ownedAgentResources';
import { prepareSessionPane } from './session-pane-ready';
import { asProvisioned, getSessionPageStore } from './stores/session-selectors';

/** Keep the DM's resource in its authorized chat context, beside the original native conversation. */
export async function openChatResource(target: { projectId: string; sessionId: string; chatId: string; sourceTabId: string }): Promise<void> {
  const { projectId, sessionId, chatId, sourceTabId } = target;
  await prepareSessionPane(projectId, sessionId, { reviveArchived: false });
  const view = asProvisioned(getSessionPageStore(projectId, sessionId))?.viewModel;
  if (!view) throw new Error('The agent session is unavailable for this resource');
  const panel = ownedAgentResourceTabs().read(chatId, sourceTabId);
  if (!panel) throw new Error('The authorized chat resource is no longer open');
  view.paneLayout.open('chat-resource', { chatId, sourceTabId, item: panel.item }, { from: null, intent: 'beside' });
}
