import type { NewSessionResponse, SessionUpdate } from '@agentclientprotocol/sdk';
import type { SerializedError } from '@gugu/session-shared';

export interface RawAcpLogMeta {
  sessionId: string;
  providerId: string;
  acpSessionId: string;
  createdAt: string;
}

export interface RawAcpLogExportMeta extends RawAcpLogMeta {
  generatedAt: string;
}

export interface RawAcpSessionUpdateEvent {
  kind: 'session_update';
  sessionId: string;
  update: SessionUpdate;
}

export interface RawAcpPromptEvent {
  kind: 'prompt';
  sessionId: string;
  content: unknown;
}

export interface RawAcpPromptResultEvent {
  kind: 'prompt_result';
  sessionId: string;
  stopReason: string | null | undefined;
  error?: SerializedError;
}

export interface RawAcpTurnEnvelopeEvent {
  kind: 'turn_envelope';
  sessionId: string;
  envelope: {
    sessionId: string;
    turnSequence: number;
    model: string | null;
    permissionMode: string | null;
    effort: string | null;
    providerSessionId: string;
    requestId: string;
  };
}

export interface RawAcpSessionNewEvent {
  kind: 'session_new';
  sessionId: string;
  request: {
    cwd: string;
    mcpServerNames: string[];
  };
  response: Pick<NewSessionResponse, 'sessionId' | 'modes' | 'configOptions'>;
}

export interface RawAcpSessionConfigOptionRequestEvent {
  kind: 'session_config_option_request';
  sessionId: string;
  request: unknown;
}

export interface RawAcpSessionConfigOptionResponseEvent {
  kind: 'session_config_option_response';
  sessionId: string;
  response: unknown;
}

export interface RawAcpPermissionRequestEvent {
  kind: 'permission_request';
  sessionId: string;
  request: unknown;
}

export interface RawAcpPermissionResolvedEvent {
  kind: 'permission_resolved';
  sessionId: string;
  requestId: string;
  optionId: string;
}

export type RawAcpEvent =
  | { kind: 'prompt_accepted'; sessionId: string; clientMessageId: string; messageId: string }
  | RawAcpSessionUpdateEvent
  | RawAcpPromptEvent
  | RawAcpPromptResultEvent
  | RawAcpTurnEnvelopeEvent
  | RawAcpSessionNewEvent
  | RawAcpSessionConfigOptionRequestEvent
  | RawAcpSessionConfigOptionResponseEvent
  | RawAcpPermissionRequestEvent
  | RawAcpPermissionResolvedEvent;

export interface RawAcpLogEntry {
  seq: number;
  ts: number;
  event: RawAcpEvent;
}

const DEFAULT_MAX_ENTRIES = 50_000;

/**
 * Append-only, fixture-compatible log of raw ACP traffic observed by a session.
 * This records data at the runtime boundary before the reducer normalizes it.
 */
export class RawAcpLog {
  private seq = 0;
  private readonly entries: RawAcpLogEntry[] = [];

  constructor(
    private readonly meta: RawAcpLogMeta,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES
  ) {}

  setAcpSessionId(acpSessionId: string): void {
    this.meta.acpSessionId = acpSessionId;
  }

  record(event: RawAcpEvent): void {
    this.entries.push({ seq: this.seq++, ts: Date.now(), event });
    if (this.entries.length > this.maxEntries) this.entries.shift();
  }

  snapshot(): { meta: RawAcpLogExportMeta; events: RawAcpLogEntry[] } {
    return {
      meta: {
        ...this.meta,
        generatedAt: new Date().toISOString(),
      },
      events: structuredClone(this.entries),
    };
  }

  exportJson(): string {
    return JSON.stringify(this.snapshot(), null, 2);
  }
}
