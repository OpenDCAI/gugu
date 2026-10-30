import { getAcpRuntimeClient } from '@main/core/acp/runtime-process/host';
import { readAcpSessionState } from '@main/core/acp/session-summary-reader';
import type { SessionpageQueueAction } from '@gugu/session-core/session-record/contract';
import { isVisibleQueuedPrompt } from '@shared/core/sessions/visible-queued-prompt';
import { editedConversationQueueText } from '@shared/core/sessions/conversation-queue-text';

/** The timeline is account-scoped. Queue writes still go through the existing ACP runtime. */
export async function changeConversationQueue(sessionId: string, action: SessionpageQueueAction): Promise<void> {
  if (!action || !['edit', 'delete', 'reorder', 'send-now'].includes(action.kind)) throw new Error('Unsupported queue action');
  if (action.kind === 'reorder' ? !Array.isArray(action.ids) || action.ids.some(id => typeof id !== 'string') : typeof action.id !== 'string') throw new Error('Invalid queue action');
  if (action.kind === 'edit' && (typeof action.text !== 'string' || action.queueEdit && (typeof action.queueEdit.draftText !== 'string' || typeof action.queueEdit.originalDraftText !== 'string'))) throw new Error('Invalid queue edit');
  const state = await readAcpSessionState(sessionId);
  if (!state) throw new Error('The session has no live queue');
  const client = await getAcpRuntimeClient();
  const prompts = state.queuedPrompts;
  const requireSuccess = async (result: Promise<{ success: boolean; error?: unknown }>) => {
    const value = await result;
    if (!value.success) throw new Error(typeof value.error === 'string' ? value.error : JSON.stringify(value.error));
  };
  if (action.kind === 'reorder') {
    const visible = prompts.filter(isVisibleQueuedPrompt);
    if (action.ids.length !== visible.length || new Set(action.ids).size !== visible.length || action.ids.some(id => !visible.some(prompt => prompt.id === id))) {
      throw new Error('The queue changed; reload it before reordering');
    }
    let index = 0;
    const ids = prompts.map(prompt => isVisibleQueuedPrompt(prompt) ? action.ids[index++] : prompt.id);
    await requireSuccess(client.changeQueuePromptOrder({ sessionId, ids }));
    return;
  }
  const prompt = prompts.find(item => item.id === action.id && isVisibleQueuedPrompt(item));
  if (!prompt) throw new Error('The queued message is no longer available');
  if (action.kind === 'edit') {
    if (!action.text.trim()) throw new Error('The queued message is empty');
    await requireSuccess(client.editQueuedPrompt({ sessionId, id: prompt.id, input: { text: editedConversationQueueText(prompt.text, action.text), hiddenContext: prompt.hiddenContext, attachments: prompt.attachments, origin: prompt.origin }, queueEdit: action.queueEdit ?? null }));
  } else if (action.kind === 'delete') {
    await requireSuccess(client.deleteQueuedPrompt({ sessionId, id: prompt.id }));
  } else if (action.steers) {
    await requireSuccess(client.steerQueuedPrompt({ sessionId, id: prompt.id }));
  } else {
    await requireSuccess(client.changeQueuePromptOrder({ sessionId, ids: [prompt.id, ...prompts.filter(item => item.id !== prompt.id).map(item => item.id)] }));
    if (state.isGenerating) await requireSuccess(client.cancelTurn({ sessionId }));
  }
}
