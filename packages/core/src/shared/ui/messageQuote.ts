import { guguLink, parseGuguLink } from './guguLink';

export type MessageQuoteSource =
  | { kind: 'session'; sessionId: string; itemId: string }
  | { kind: 'chat'; chatId: string; messageId: string };

const escapeLabel = (value: string) => value.replace(/\\/g, '\\\\').replace(/([[\]])/g, '\\$1').replace(/[\r\n]+/g, ' ');

/** A timeline item keeps its own identity; an IM message keeps its real chat/message identity. */
export function messageQuoteLink(source: MessageQuoteSource): string {
  return guguLink(source);
}

export function parseMessageQuoteLink(link: string): MessageQuoteSource | null {
  const target = parseGuguLink(link);
  if (target?.kind === 'chat' && target.messageId) return { kind: 'chat', chatId: target.chatId, messageId: target.messageId };
  if (target?.kind === 'session' && target.itemId) return { kind: 'session', sessionId: target.sessionId, itemId: target.itemId };
  return null;
}

/** Ordinary prompt text already survives queues and native histories; no separate transient reply state. */
export function messageQuoteText(source: MessageQuoteSource, text: string, sender: string): string {
  return `> [${escapeLabel(sender)}](${messageQuoteLink(source)})\n${text.split(/\r?\n/).map(line => `> ${line}`).join('\n')}\n\n`;
}

/** Only a leading, explicitly identified quote is projected. Plain blockquotes are never guessed. */
export function readMessageQuote(text: string): { source: MessageQuoteSource; link: string; sender: string; excerpt: string; body: string } | null {
  const lines = text.split(/\r?\n/);
  const header = /^> \[((?:\\.|[^\]\\])*)\]\(([^\s]+)\)$/.exec(lines[0] ?? '');
  if (!header) return null;
  const source = parseMessageQuoteLink(header[2]!);
  if (!source) return null;
  const quoted: string[] = [];
  let index = 1;
  while (index < lines.length && /^>(?: |$)/.test(lines[index]!)) quoted.push(lines[index++]!.replace(/^> ?/, ''));
  if (!quoted.length || lines[index] !== '') return null;
  return { source, link: header[2]!, sender: header[1]!.replace(/\\([\\[\]])/g, '$1'), excerpt: quoted.join('\n'), body: lines.slice(index + 1).join('\n') };
}
