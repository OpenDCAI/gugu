import type { ChatMessage } from '../model';

/** Display data read as the current person from the original IM message. Never provider input. */
export type DeliveryMessagePresentation = Pick<ChatMessage, 'text' | 'attachments'>;

/** These reserved lines are added by the inbox attachment adapter, inside a delivery envelope only. */
export function hasAttachmentDeliveryHints(body: string): boolean {
  return /^\[(?:Folder file gugu-file:\/\/|Image attached(?: at local path)?:|File saved at local path:)/m.test(body);
}
export function safeDeliveredBody(body: string): string {
  if (!hasAttachmentDeliveryHints(body)) return body;
  return body.split('\n').filter(line => !/^\[(?:Folder file gugu-file:\/\/|Image attached(?: at local path)?:|File saved at local path:|File not saved:)/.test(line)).join('\n').trimEnd();
}
