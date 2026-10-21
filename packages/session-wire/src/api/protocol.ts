import { toSerializedError, type Serializable, type SerializedError, type Unsubscribe } from '@gugu/session-shared';
import type { LiveUpdate } from '../live/protocol';

export type WireErrorCode =
  | 'CANCELLED'
  | 'DISCONNECTED'
  | 'UNKNOWN_PROCEDURE'
  | 'UNKNOWN_TOPIC'
  | 'NOT_FOUND'
  | 'MISSING_HANDLER'
  | 'CONTRACT_MISMATCH'
  | 'ALREADY_EXISTS'
  | 'HANDLER_ERROR';

export type WireCallMessage = {
  kind: 'call';
  id: string;
  path: string;
  input: unknown;
  upload?: {
    channel: string;
    meta: WireFileMeta;
  };
};

export type WireSnapshotMessage = {
  kind: 'snapshot';
  id: string;
  topic: string;
};

export type WireAttachMessage = {
  kind: 'attach';
  id: string;
  topic: string;
};

export type WireDetachMessage = {
  kind: 'detach';
  topic: string;
};

export type WireCancelMessage = {
  kind: 'cancel';
  id: string;
};

export type WireResultMessage =
  | {
      kind: 'result';
      id: string;
      ok: true;
      value: unknown;
    }
  | {
      kind: 'result';
      id: string;
      ok: false;
      code: WireErrorCode;
      message: string;
      cause?: SerializedError;
      details?: WireErrorDetails;
    };

export type WireUpdateMessage = {
  kind: 'update';
  topic: string;
  update: LiveUpdate;
};

export type WireTopicGapMessage = {
  kind: 'topic-gap';
  topic: string;
};

export type WireTopicErrorMessage = {
  kind: 'topic-error';
  topic: string;
  error: SerializedWireError;
  retrying: boolean;
};

export type WireFileMeta = {
  name: string;
  mimeType: string;
  size?: number;
  lastModified?: number;
  [key: string]: unknown;
};

export type WireBlobPullMessage = {
  kind: 'blob-pull';
  channel: string;
  credit: number;
};

export type WireBlobChunkMessage = {
  kind: 'blob-chunk';
  channel: string;
  seq: number;
  data: Uint8Array;
};

export type WireBlobEndMessage = {
  kind: 'blob-end';
  channel: string;
};

export type WireBlobErrorMessage = {
  kind: 'blob-error';
  channel: string;
  error: SerializedWireError;
};

export type WireBlobCloseMessage = {
  kind: 'blob-close';
  channel: string;
};

export type WireMessage =
  | WireCallMessage
  | WireSnapshotMessage
  | WireAttachMessage
  | WireDetachMessage
  | WireCancelMessage
  | WireResultMessage
  | WireUpdateMessage
  | WireTopicGapMessage
  | WireTopicErrorMessage
  | WireBlobPullMessage
  | WireBlobChunkMessage
  | WireBlobEndMessage
  | WireBlobErrorMessage
  | WireBlobCloseMessage;

export type WireTransport = {
  post(message: WireMessage): void;
  onMessage(cb: (message: WireMessage) => void): Unsubscribe;
  onDisconnect(cb: () => void): Unsubscribe;
  onReconnect?(cb: () => void): Unsubscribe;
  close?(): void;
};

/** Local attribution for a wire failure; never serialized as part of the wire protocol. */
export type WireErrorContext = {
  callId: string;
  operation: 'call' | 'snapshot' | 'attach';
  path?: string;
  topic?: string;
  sessionId?: string;
  providerSessionId?: string;
  agentUserId?: string;
};

export class WireError extends Error {
  constructor(
    readonly code: WireErrorCode,
    message: string,
    options: { cause?: unknown; context?: WireErrorContext; details?: WireErrorDetails } = {}
  ) {
    const details = options.details ?? serializeErrorDetails(options.cause);
    const causeMessage = errorMessage(options.cause);
    const normalizedMessage = message.trim().length > 0
      ? message
      : causeMessage ?? `WireError ${code}: ${errorType(options.cause)}`;
    super(normalizedMessage, options);
    this.name = 'WireError';
    this.context = options.context;
    this.details = details;
  }

  readonly context?: WireErrorContext;
  readonly details?: WireErrorDetails;
}

export type WireErrorDetails = Record<string, Serializable>;

export type SerializedWireError = {
  code: WireErrorCode;
  message: string;
  cause?: SerializedError;
  details?: WireErrorDetails;
};

export function serializeWireError(error: unknown): SerializedWireError {
  if (error instanceof WireError) {
    return {
      code: error.code,
      message: error.message,
      cause: serializeCause(error.cause),
      ...(error.details ? { details: error.details } : {}),
    };
  }
  if (error instanceof Error) {
    const details = serializeErrorDetails(error);
    return {
      code: 'HANDLER_ERROR',
      message: error.message,
      cause: toSerializedError(error),
      ...(details ? { details } : {}),
    };
  }
  return { code: 'HANDLER_ERROR', message: String(error), cause: toSerializedError(error) };
}

function errorMessage(value: unknown): string | undefined {
  if (value instanceof Error && value.message.trim()) return value.message;
  if (isRecord(value) && typeof value.message === 'string' && value.message.trim()) return value.message;
  return undefined;
}

function errorType(value: unknown): string {
  if (value instanceof Error && value.name) return value.name;
  if (isRecord(value) && typeof value.name === 'string' && value.name) return value.name;
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toSerializable(value: unknown, seen: Set<unknown>): Serializable | undefined {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => toSerializable(entry, seen) ?? null);
  }
  const out: Record<string, Serializable> = {};
  for (const [key, entry] of Object.entries(value)) {
    const serialized = toSerializable(entry, seen);
    if (serialized !== undefined) out[key] = serialized;
  }
  return out;
}

function serializeErrorDetails(value: unknown): WireErrorDetails | undefined {
  if (!isRecord(value)) return undefined;
  const details: WireErrorDetails = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') continue;
    const serialized = toSerializable(entry, new Set([value]));
    if (serialized !== undefined) details[key] = serialized;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

export function isWireError(error: unknown, code?: WireErrorCode): error is WireError {
  return error instanceof WireError && (code === undefined || error.code === code);
}

export function isWireMessage(value: unknown): value is WireMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  switch (message.kind) {
    case 'call':
      return typeof message.id === 'string' && typeof message.path === 'string';
    case 'snapshot':
    case 'attach':
      return typeof message.id === 'string' && typeof message.topic === 'string';
    case 'detach':
      return typeof message.topic === 'string';
    case 'cancel':
      return typeof message.id === 'string';
    case 'result':
      if (typeof message.id !== 'string') return false;
      if (message.ok === true) return true;
      return (
        message.ok === false &&
        typeof message.code === 'string' &&
        typeof message.message === 'string'
      );
    case 'update':
      return typeof message.topic === 'string' && typeof message.update === 'object';
    case 'topic-gap':
      return typeof message.topic === 'string';
    case 'topic-error':
      return (
        typeof message.topic === 'string' &&
        typeof message.error === 'object' &&
        typeof message.retrying === 'boolean'
      );
    case 'blob-pull':
      return typeof message.channel === 'string' && typeof message.credit === 'number';
    case 'blob-chunk':
      return (
        typeof message.channel === 'string' &&
        typeof message.seq === 'number' &&
        message.data instanceof Uint8Array
      );
    case 'blob-end':
    case 'blob-close':
      return typeof message.channel === 'string';
    case 'blob-error':
      return typeof message.channel === 'string' && typeof message.error === 'object';
    default:
      return false;
  }
}

function serializeCause(cause: unknown): SerializedError | undefined {
  if (cause === undefined) return undefined;
  if (isSerializedError(cause)) return cause;
  return toSerializedError(cause);
}

function isSerializedError(value: unknown): value is SerializedError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}
