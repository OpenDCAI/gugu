import { isHumanDmDelivery, readDeliveryEnvelope, renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';

/** Queue UI edits the person's words while the runtime retains delivery provenance and reply routing. */
export function conversationQueueText(text: string): string {
  return isHumanDmDelivery(text) ? readDeliveryEnvelope(text)!.body : text;
}

export function editedConversationQueueText(original: string, text: string): string {
  if (!isHumanDmDelivery(original)) return text;
  const parts = readDeliveryEnvelope(original)!.segments;
  if (parts.length !== 1 || !parts[0].facts) throw new Error('A batched delivery cannot be edited as one message');
  const facts = parts[0].facts;
  if (!facts.fromId || !facts.messageId || !facts.at || (facts.chatKind !== 'ai' && facts.chatKind !== 'dm')) throw new Error('Delivery provenance is incomplete');
  if (facts.listenMode !== null && facts.listenMode !== 'active' && facts.listenMode !== 'passive') throw new Error('Delivery listen mode is invalid');
  return renderDeliveryEnvelope({
    route: 'chat', from: facts.from, fromId: facts.fromId, fromType: 'human',
    chat: facts.chat, chatKind: facts.chatKind, messageId: facts.messageId, at: facts.at,
    sourceLink: facts.sourceLink, replyTo: facts.replyTo, thread: facts.thread,
    whisperTo: facts.whisperTo, viaApp: facts.viaApp, listenMode: facts.listenMode,
    threadContext: facts.threadContext, messageContext: facts.messageContext, content: text,
  });
}
