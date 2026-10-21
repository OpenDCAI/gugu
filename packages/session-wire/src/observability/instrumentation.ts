export type WireCallStartEvent = {
  callId: string;
  path: string;
  input?: unknown;
  side?: 'client' | 'server';
};

export type WireCallEndEvent = {
  callId: string;
  path: string;
  durationMs: number;
  ok: boolean;
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
  side?: 'client' | 'server';
};

export type WireSnapshotEvent = {
  requestId: string;
  topic: string;
  durationMs: number;
  ok: boolean;
  errorCode?: string;
};

export type WireTopicAttachEvent = {
  topic: string;
  attachmentCount?: number;
};

export type WireTopicDetachEvent = {
  topic: string;
  attachmentCount?: number;
};

export type WireCancelEvent = {
  callId: string;
  side?: 'client' | 'server';
};

export type WireResyncReason = 'generation' | 'sequence-gap' | 'patch-failed' | 'validation';

export type WireResyncEvent = {
  topic?: string;
  reason: WireResyncReason;
  details?: Record<string, unknown>;
};

export type WireMutationDedupedEvent = {
  mutationId: string;
  path: string;
};

export type WireBatchDroppedEvent = {
  error: unknown;
};

export type WireScopeCleanupErrorEvent = {
  label?: string;
  error: unknown;
};

export type WireTransportEvent = {
  event: 'connect' | 'disconnect' | 'reconnect';
};

export type WireInstrumentation = {
  callStart?(event: WireCallStartEvent): void;
  callEnd?(event: WireCallEndEvent): void;
  snapshot?(event: WireSnapshotEvent): void;
  topicAttach?(event: WireTopicAttachEvent): void;
  topicDetach?(event: WireTopicDetachEvent): void;
  cancel?(event: WireCancelEvent): void;
  resync?(event: WireResyncEvent): void;
  mutationDeduped?(event: WireMutationDedupedEvent): void;
  batchDropped?(event: WireBatchDroppedEvent): void;
  scopeCleanupError?(event: WireScopeCleanupErrorEvent): void;
  transport?(event: WireTransportEvent): void;
};

export const noopInstrumentation: WireInstrumentation = {};

