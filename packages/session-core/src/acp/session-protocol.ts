import type { PromptInput } from './models/prompt';
import { z } from 'zod';

/** Kept with a committed cycle so unknown reasons and native usage/error facts survive replay. */
export const foregroundEndSchema = z.object({
  source: z.enum(['agent', 'request']),
  state: z.literal('idle'),
  stopReason: z.string().nullish(),
  usage: z.record(z.string(), z.unknown()).nullish(),
  error: z.object({ name: z.string().optional(), message: z.string(), stack: z.string().optional(),
    code: z.union([z.number(), z.string()]).optional(), data: z.unknown().optional() }).nullish(),
  _meta: z.record(z.string(), z.unknown()).nullish(),
});

/** Dispatch is not insertion. An accepted receipt must follow the matching user echo; a provider that reverses them violates the host contract. */
export type SessionPromptReceipt =
  ({ status: 'dispatched'; requestId: string }
  | { status: 'accepted'; requestId: string; messageId: string }) & {
    _meta?: Readonly<Record<string, unknown>> | null;
  };

/** Foreground work is independent of the prompt RPC and of background activity. */
export type SessionForegroundState = {
  /** Request activity is the strongest observation available on some transports. */
  source: 'agent' | 'request';
} & (
  | { state: 'running' | 'requires_action' | 'unknown' }
  | {
      state: 'idle';
      /** Missing or null means no reason was reported, not end_turn. */
      stopReason?: string | null;
      usage?: Readonly<Record<string, unknown>> | null;
      error?: { name?: string; code?: number | string; message: string; stack?: string; data?: unknown } | null;
      _meta?: Readonly<Record<string, unknown>> | null;
    }
);

export type SessionFileChange =
  | { operation: 'add' | 'delete' | 'modify'; path: string }
  | { operation: 'move' | 'copy'; oldPath: string; path: string }
  | { operation: string; path?: unknown; [key: string]: unknown };

/** A patch stays a patch; an unlocated replacement region is not a whole file. */
export interface SessionPatch {
  [key: string]: unknown;
  changes: readonly SessionFileChange[];
  patch?: { format: string; text: string } | null;
  scope: 'file' | 'fragment' | 'unknown';
  _meta?: Readonly<Record<string, unknown>> | null;
}

/**
 * Absent fields leave the entity unchanged; null clears them. Collections replace
 * rather than append. Metadata objects patch top-level keys; null clears metadata.
 */
export type SessionEntityUpsert<T extends object> = {
  [K in keyof T]?: T[K] | null;
} & { _meta?: Readonly<Record<string, unknown>> | null };

export type SessionMessageUpsert<TContent> = {
  messageId: string;
} & SessionEntityUpsert<{ content: readonly TContent[] }>;

/** Snapshot and chunk bytes are independently base64 encoded, not UTF-8 strings. */
export type SessionTerminalUpdate = {
  terminalId: string;
} & SessionEntityUpsert<{
  command: string;
  cwd: string;
  output: { data: string };
  /** An object marks exit even when neither exit code nor signal is known. */
  exitStatus: { exitCode?: number | null; signal?: string | null };
}>;

export interface SessionTerminalChunk {
  terminalId: string;
  data: string;
}

/**
 * A session-scoped transport boundary. TEvent is the host's domain vocabulary;
 * implementations keep wire versions, RPC correlation and SDK objects private.
 */
export interface SessionProtocolPort<TEvent> {
  prompt(request: { requestId: string; input: PromptInput }): Promise<SessionPromptReceipt>;
  cancel(): Promise<void>;
  subscribe(listener: (event: TEvent) => void): () => void;
}
