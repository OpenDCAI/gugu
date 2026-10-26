import type { HistoryCursor } from '@gugu/session-core/acp/client';
import {
  agentStateSchema,
  planStateSchema,
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
import { ReplicaLog, ReplicaState, type BlobSource, type LiveClientHandle } from '@gugu/session-wire';
import { createImmutableMobxStore, createMobxLogStore } from '@gugu/session-wire/util/mobx';
import { z } from 'zod';
import {
  getAcpRuntimeClient,
  type AcpRuntimeRpcClient,
  type StartSessionInput,
} from './runtime-client';

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
  readonly plan: ReplicaState<z.infer<typeof planStateSchema> | null>;
  readonly activeTurn: ReplicaState<z.infer<typeof transcriptTurnSchema> | null>;
  readonly agents: ReplicaState<z.infer<typeof agentStateSchema>[]>;
  readonly draft: ReplicaState<z.infer<typeof promptDraftSchema> | null>;
  readonly terminals: ReplicaState<TerminalState[]>;
  private readonly terminalLogs = new Map<string, ReplicaLog>();
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
    this.plan = createReplicaState(client.session.state(key, 'plan'), planStateSchema.nullable());
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

  static async create(sessionId: string, input?: StartSessionInput): Promise<AcpLiveSession> {
    const client = await getAcpRuntimeClient(machineRegistry.machineOf(sessionId));
    if (input) {
      // @@@6183 等的是启动的**结果**,❌ 墙钟。这里曾有 60s(opencode 120s)的客户端预算:负载下
      // mimocode 冷启动实测 52s,离它只差一口气 —— 而超时之后引擎其实还在起,界面却已宣布失败。
      // 等待在界面上就是首条消息那一轮的「处理中」(behavior session-page「打开速度」),不需要替用户猜一个上限。
      const result = await client.startSession({ input });
      if (!result.success) {
        throw new AcpStartError(result.error);
      }
    }
    const session = new AcpLiveSession(sessionId, client);
    try {
      await withTimeout(
        Promise.all([
          session.sessionState.ready,
          session.config.ready,
          session.usage.ready,
          session.plan.ready,
          session.activeTurn.ready,
          session.draft.ready,
          session.terminals.ready,
          session.agents.ready,
        ]),
        'Timed out connecting ACP live models'
      );
    } catch (error) {
      // @@@replica-failed-ready — 副本里拒掉的那一份会自己放掉 attach,可已经接上的另外几份(以及超时时
      // 还在接的全部)只有这个对象拿着,而调用方收到的是错误、拿不到它 ⇒ 在这里整份拆掉再抛。
      session.dispose();
      throw error;
    }
    return session;
  }

  async start(input: StartSessionInput): Promise<Result<{ providerSessionId: string }, unknown>> {
    return this.client.startSession({ input });
  }

  stop(): Promise<Result<void, unknown>> {
    return this.client.stopSession({ sessionId: this.sessionId });
  }

  async resume(
    input: StartSessionInput & { providerSessionId: string }
  ): Promise<Result<HistoryPage, unknown>> {
    const result = await this.client.resumeSession({ input });
    if (!result.success) return result;
    return {
      success: true,
      data: {
        turns: result.data.turns,
        nextCursor: result.data.nextCursor,
        cursor: result.data.cursor,
        reset: result.data.reset,
        count: result.data.count,
      },
    };
  }

  /** `changedSince`:只要这个改动游标之后新增或改过的回合(@@@history-change-cursor),忽略 before / limit。 */
  getHistory(before?: number, limit = 50, changedSince?: HistoryCursor): Promise<Result<HistoryPage, unknown>> {
    return this.client.getHistory({ sessionId: this.sessionId, before, limit, ...(changedSince === undefined ? {} : { changedSince }) });
  }

  exportTranscript(): Promise<Result<string, unknown>> {
    return this.client.exportACPTranscript({ sessionId: this.sessionId });
  }

  exportRawAcpLog(): Promise<Result<string, unknown>> {
    return this.client.exportRawAcpLog({ sessionId: this.sessionId });
  }

  uploadAttachment(input: {
    data?: Uint8Array;
    source?: BlobSource;
    size?: number;
    mimeType: AttachmentMimeType;
    name?: string;
    originalPath?: string;
  }): Promise<Result<AttachmentRef, unknown>> {
    return this.client.uploadAttachment(
      { originalPath: input.originalPath },
      {
        name: input.name ?? 'attachment',
        mimeType: input.mimeType,
        size: input.size ?? input.data?.byteLength,
        source:
          input.source ?? (input.data ? singleChunk(input.data) : singleChunk(new Uint8Array())),
      }
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

  sendPrompt(prompt: PromptInput): Promise<Result<{ queued: boolean }, unknown>> {
    return this.client.sendPrompt({ sessionId: this.sessionId, prompt });
  }

  queuePrompt(prompt: PromptInput): Promise<Result<{ queued: boolean }, unknown>> {
    return this.client.queuePrompt({ sessionId: this.sessionId, prompt });
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

  async terminalOutput(terminalId: string): Promise<ReplicaLog> {
    const existing = this.terminalLogs.get(terminalId);
    if (existing) return existing;
    const binding = new ReplicaLog(this.client.terminalOutput.handle({ terminalId }), {
      store: createMobxLogStore(),
    });
    this.terminalLogs.set(terminalId, binding);
    await binding.ready;
    if (this.disposed) void binding.dispose();
    return binding;
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
    for (const binding of this.terminalLogs.values()) {
      void binding.dispose();
    }
    this.terminalLogs.clear();
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

function withTimeout<T>(promise: Promise<T>, message: string, ms = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
