import type { HistoryCursor } from '@gugu/session-core/acp/client';
import {
  agentStateSchema,
  sessionPlansSchema,
  promptDraftSchema,
  sessionUsageSchema,
  sessionConfigStateSchema,
  sessionStateSchema,
  terminalStateSchema,
  transcriptTurnSchema,
  type AttachmentMimeType,
  type AttachmentRef,
  type AcpRuntimeError,
  type HistoryPage,
  type PromptDraftUpdate,
  type PromptInput,
  type QueuedPromptEdit,
  type LiveSettingResult,
  type SessionState,
  type TerminalState,
} from '@gugu/session-core/acp/client';
import type { Result } from '@gugu/session-shared';
import type { Unsubscribe } from '@gugu/session-shared';
import { machineRegistry } from '../machine-routing';
import { ReplicaState, type BlobSource, type LiveClientHandle } from '@gugu/session-wire';
import { createImmutableMobxStore } from '@gugu/session-wire/util/mobx';
import { z } from 'zod';
import { getAcpRuntimeClient, type AcpRuntimeRpcClient } from './runtime-client';

export interface LiveValueSource<T> {
  getSnapshot(): T;
  subscribe(cb: () => void): Unsubscribe;
}

export function asValueSource<T>(replica: ReplicaState<T>): LiveValueSource<T> {
  return {
    getSnapshot: () => replica.current(),
    subscribe: (cb) => replica.onChange(() => cb()),
  };
}

export class AcpStartError extends Error {
  constructor(readonly runtimeError: AcpRuntimeError) {
    super(runtimeError.message ?? runtimeError.cause?.message ?? runtimeError.type);
    this.name = 'AcpStartError';
  }

  get errorType(): AcpRuntimeError['type'] {
    return this.runtimeError.type;
  }
}

export class AcpLiveSession {
  readonly sessionState: ReplicaState<SessionState>;
  readonly config: ReplicaState<z.infer<typeof sessionConfigStateSchema>>;
  readonly usage: ReplicaState<z.infer<typeof sessionUsageSchema> | null>;
  readonly plan: ReplicaState<z.infer<typeof sessionPlansSchema> | null>;
  readonly activeTurn: ReplicaState<z.infer<typeof transcriptTurnSchema> | null>;
  readonly agents: ReplicaState<z.infer<typeof agentStateSchema>[]>;
  readonly draft: ReplicaState<z.infer<typeof promptDraftSchema> | null>;
  readonly terminals: ReplicaState<TerminalState[]>;
  private disposed = false;

  private constructor(
    readonly sessionId: string,
    private readonly client: AcpRuntimeRpcClient
  ) {
    const key = { sessionId };
    this.agents = createReplicaState(client.session.state(key, 'agents'), z.array(agentStateSchema));
    this.sessionState = createReplicaState(client.session.state(key, 'state'), sessionStateSchema);
    this.config = createReplicaState(client.session.state(key, 'config'), sessionConfigStateSchema);
    this.usage = createReplicaState(
      client.session.state(key, 'usage'),
      sessionUsageSchema.nullable()
    );
    this.plan = createReplicaState(client.session.state(key, 'plan'), sessionPlansSchema.nullable());
    this.activeTurn = createReplicaState(
      client.session.state(key, 'activeTurn'),
      transcriptTurnSchema.nullable()
    );
    this.draft = createReplicaState(
      client.session.state(key, 'draft'),
      promptDraftSchema.nullable()
    );
    this.terminals = createReplicaState(
      client.session.state(key, 'terminals'),
      z.array(terminalStateSchema)
    );
  }

  /** Attach to a session its host's session-life already runs; a page never starts, resumes or stops one. */
  static async create(sessionId: string): Promise<AcpLiveSession> {
    const client = await getAcpRuntimeClient(machineRegistry.machineOf(sessionId));
    const session = new AcpLiveSession(sessionId, client);
    try {
      // Attachment waits for its result. A busy runtime delivering snapshots slowly has not failed.
      await Promise.all([
        session.sessionState.ready,
        session.config.ready,
        session.usage.ready,
        session.plan.ready,
        session.activeTurn.ready,
        session.draft.ready,
        session.terminals.ready,
        session.agents.ready,
      ]);
    } catch (error) {
      // @@@replica-failed-ready — 副本里拒掉的那一份会自己放掉 attach,可已经接上的另外几份只有这个对象拿着,而调用方收到的是错误、拿不到它 ⇒ 在这里整份拆掉再抛。
      session.dispose();
      throw error;
    }
    return session;
  }

  /** `changedSince`:只要这个改动游标之后新增或改过的回合(@@@history-change-cursor),忽略 before / limit。 */
  getHistory(before?: number, limit = 50, changedSince?: HistoryCursor): Promise<Result<HistoryPage, unknown>> {
    return this.client.getHistory({ sessionId: this.sessionId, before, limit, ...(changedSince === undefined ? {} : { changedSince }) });
  }

  getToolImage(itemId: string, index: number) {
    return this.client.getToolImage({ sessionId: this.sessionId, itemId, index });
  }

  exportTranscript(): Promise<Result<string, unknown>> {
    return this.client.exportACPTranscript({ sessionId: this.sessionId });
  }

  exportRawAcpLog(): Promise<Result<string, unknown>> {
    return this.client.exportRawAcpLog({ sessionId: this.sessionId });
  }

  uploadAttachment(input: {
    uploadId?: string;
    data?: Uint8Array;
    source?: BlobSource;
    size?: number;
    mimeType: AttachmentMimeType;
    name?: string;
    originalPath?: string;
    signal?: AbortSignal;
    onProgress?: (progress: { sent: number; total?: number }) => void;
  }): Promise<Result<AttachmentRef, unknown>> {
    return this.client.uploadAttachment(
      { originalPath: input.originalPath, uploadId: input.uploadId },
      {
        name: input.name ?? 'attachment',
        mimeType: input.mimeType,
        size: input.size ?? input.data?.byteLength,
        source:
          input.source ?? (input.data ? singleChunk(input.data) : singleChunk(new Uint8Array())),
      },
      { signal: input.signal, onProgress: input.onProgress }
    );
  }

  downloadAttachment(
    id: string
  ): Promise<Result<{ ref: AttachmentRef; data: Uint8Array }, unknown>> {
    return this.client.downloadAttachment({ id }).then(async (result) => {
      if (!result.success) return result;
      return {
        success: true,
        data: {
          ref: result.data.meta,
          data: await result.data.bytes(),
        },
      };
    });
  }

  deleteAttachment(id: string): Promise<Result<void, unknown>> {
    return this.client.deleteAttachment({ id });
  }

  revertSession(anchor: string) {
    return this.client.revertSession({ sessionId: this.sessionId, anchor });
  }

  editQueuedPrompt(id: string, input: PromptInput, queueEdit?: QueuedPromptEdit | null): Promise<Result<void, unknown>> {
    return this.client.editQueuedPrompt({ sessionId: this.sessionId, id, input, ...(queueEdit !== undefined ? { queueEdit } : {}) });
  }

  deleteQueuedPrompt(id: string): Promise<Result<void, unknown>> {
    return this.client.deleteQueuedPrompt({ sessionId: this.sessionId, id });
  }

  changeQueuePromptOrder(ids: string[]): Promise<Result<void, unknown>> {
    return this.client.changeQueuePromptOrder({ sessionId: this.sessionId, ids });
  }

  steerQueuedPrompt(id: string): Promise<Result<void, unknown>> {
    return this.client.steerQueuedPrompt({ sessionId: this.sessionId, id });
  }

  cancelTurn(): Promise<Result<void, unknown>> {
    return this.client.cancelTurn({ sessionId: this.sessionId });
  }

  /** 停一个后台子智能体(#5117);`backgroundTaskId` 传派发它那次调用的 tool_use id。 */
  stopBackgroundTask(backgroundTaskId: string): Promise<Result<void, unknown>> {
    return this.client.stopBackgroundTask({ sessionId: this.sessionId, taskId: backgroundTaskId });
  }

  setPromptDraft(draft: PromptDraftUpdate): Promise<Result<void, unknown>> {
    return this.client.setPromptDraft({ sessionId: this.sessionId, draft });
  }

  setModelOption(dimension: 'model' | 'effort', value: string): Promise<Result<LiveSettingResult, unknown>> {
    return this.client.setModelOption({ sessionId: this.sessionId, dimension, value });
  }

  setModeOption(value: string): Promise<Result<LiveSettingResult, unknown>> {
    return this.client.setModeOption({ sessionId: this.sessionId, value });
  }

  resolvePermission(requestId: string, optionId: string): Promise<Result<void, unknown>> {
    return this.client.resolvePermission({
      sessionId: this.sessionId,
      requestId,
      optionId,
    });
  }

  dispose(): void {
    this.disposed = true;
    void this.sessionState.dispose();
    void this.config.dispose();
    void this.usage.dispose();
    void this.plan.dispose();
    void this.activeTurn.dispose();
    void this.draft.dispose();
    void this.terminals.dispose();
    void this.agents.dispose();
  }
}

async function* singleChunk(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

function createReplicaState<T>(handle: LiveClientHandle<T>, schema: z.ZodType<T>): ReplicaState<T> {
  return new ReplicaState(handle, {
    schema,
    store: createImmutableMobxStore(),
  });
}
