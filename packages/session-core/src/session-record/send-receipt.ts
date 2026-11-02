/** Unwrap MCP text content without treating an error envelope as a successful receipt. */
export function sendReceipt(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') { try { return sendReceipt(JSON.parse(raw)); } catch { return null; } }
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.isError === true || value.ok === false || value.status === 'error' || value.status === 'failed') return null;
  if (typeof value.message_id === 'string' || Array.isArray(value.recipients)) return value;
  if (Array.isArray(value.content)) for (const block of value.content) {
    if (block?.type === 'text') { const result = sendReceipt(block.text); if (result) return result; }
  }
  return null;
}

/** A message attachment link carries its canonical source chat; the host still checks message access. */
export function sentAttachmentLink(messageId: string, chatId?: string): string {
  return `gugu-message-file://${messageId}${chatId ? `?chat=${encodeURIComponent(chatId)}` : ''}`;
}

export function parseSentAttachmentLink(href: string): { messageId: string; chatId?: string } | null {
  const match = /^gugu-message-file:\/\/([a-f0-9-]{36})(?:\?chat=([a-f0-9-]{36}))?$/i.exec(href);
  return match ? { messageId: match[1]!.toLowerCase(), ...(match[2] ? { chatId: match[2].toLowerCase() } : {}) } : null;
}
