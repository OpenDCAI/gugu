import type { SessionConfig } from './session-config';
import type { SessionMessage } from './sessions';

export type EnqueueMessageStatus = 'queued' | 'accepted' | 'outcome-unknown';

export const MAX_SESSION_OUTBOX_MESSAGES = 256;
export const MAX_SESSION_OUTBOX_TEXT_BYTES = 1024 * 1024;

function textBytes(messages: readonly { text: string }[]): number {
  const encoder = new TextEncoder();
  return messages.reduce((total, message) => total + encoder.encode(message.text).byteLength, 0);
}

export function enqueueSessionMessage(
  config: SessionConfig,
  message: { id: string; text: string; kind?: SessionMessage['kind'] },
): { config: SessionConfig; status: EnqueueMessageStatus } {
  const outbox = config.messageOutbox ?? [];
  const existing = outbox.find((candidate) => candidate.id === message.id);
  if (existing) {
    if (existing.text !== message.text || (existing.kind ?? 'ordinary') !== (message.kind ?? 'ordinary')) {
      throw new Error(`clientMessageId ${message.id} already belongs to different text`);
    }
    return {
      config,
      status: existing.state === 'dispatching' ? 'outcome-unknown' : 'queued',
    };
  }
  if (outbox.length >= MAX_SESSION_OUTBOX_MESSAGES) {
    throw new Error(`session outbox capacity is ${MAX_SESSION_OUTBOX_MESSAGES} messages`);
  }
  if (textBytes(outbox) + new TextEncoder().encode(message.text).byteLength > MAX_SESSION_OUTBOX_TEXT_BYTES) {
    throw new Error(`session outbox capacity is ${MAX_SESSION_OUTBOX_TEXT_BYTES} text bytes`);
  }
  return {
    config: {
      ...config,
      messageOutbox: [...outbox, { ...message, state: 'pending' }],
    },
    status: 'queued',
  };
}

export function nextPendingSessionMessage(
  config: SessionConfig,
  accepts: (message: SessionMessage) => boolean = () => true,
): SessionMessage | null {
  return config.messageOutbox?.find(
    (message) => message.state !== 'dispatching' && accepts(message),
  ) ?? null;
}

export function markSessionMessageDispatching(
  config: SessionConfig,
  messageId: string,
): SessionConfig {
  return {
    ...config,
    messageOutbox: (config.messageOutbox ?? []).map((message) =>
      message.id === messageId ? { ...message, state: 'dispatching' } : message,
    ),
  };
}

export function markSessionMessagePending(
  config: SessionConfig,
  messageId: string,
): SessionConfig {
  return {
    ...config,
    messageOutbox: (config.messageOutbox ?? []).map((message) =>
      message.id === messageId ? { ...message, state: 'pending' } : message,
    ),
  };
}

/** Remove a message after an adapter has rejected it before acceptance. */
export function failSessionMessage(
  config: SessionConfig,
  messageId: string,
): SessionConfig {
  return {
    ...config,
    messageOutbox: (config.messageOutbox ?? []).filter((message) => message.id !== messageId),
  };
}

export function acceptSessionMessage(
  config: SessionConfig,
  expected: { id: string; text: string; kind?: SessionMessage['kind'] },
  receiptMessageId: string,
): SessionConfig {
  if (receiptMessageId !== expected.id) {
    throw new Error(`transport accepted ${receiptMessageId} for outbox ${expected.id}`);
  }
  const outbox = config.messageOutbox ?? [];
  const current = outbox.find((message) => message.id === expected.id);
  if (!current || current.text !== expected.text || (current.kind ?? 'ordinary') !== (expected.kind ?? 'ordinary') || current.state !== 'dispatching') {
    throw new Error(`outbox ${expected.id} changed during transport acceptance`);
  }
  return {
    ...config,
    messageOutbox: outbox.filter((message) => message.id !== expected.id),
  };
}
