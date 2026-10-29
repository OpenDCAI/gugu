import type {
  AcpRuntimeStartInput,
  PromptAttachment,
  PromptInput,
  QueuedPrompt,
  TranscriptTurn,
} from '@gugu/session-core/acp';
import type { AcpProcessHost } from '@gugu/session-core/acp/node';
import type { AgentPluginHost, ResolvedAcpProvider } from '@gugu/session-core/agents/plugins';
import type { Logger } from '@gugu/session-shared/logger';
import type { AttachmentStore } from './attachment-store';

export type AcpStartInput = AcpRuntimeStartInput;

export type ResolveAcpProvider = (providerId: string) => ResolvedAcpProvider | null;

export interface ResolvedPromptAttachment {
  data: string;
  mimeType: string;
}

export type ResolvePromptAttachment = (
  attachment: PromptAttachment
) => Promise<ResolvedPromptAttachment>;

/** The runtime machine's durable snapshot; no renderer-side queue is involved. */
export interface PromptQueueStore {
  load(sessionId: string): readonly PromptInput[];
  save(sessionId: string, prompts: readonly QueuedPrompt[]): void;
  clear(sessionId: string): void;
}

export type AcpRuntimeProcessHost = Omit<AcpProcessHost, 'resolveSpawnContext'>;

export interface AcpRuntimeDeps {
  onPromptSteered?: (sessionId: string) => void;
  agentHost: AgentPluginHost;
  host: AcpRuntimeProcessHost;
  resolveAttachment: ResolvePromptAttachment;
  /** 多条投递信封合成一条的唯一属主(core 的 mergeDeliveryEnvelopes),由宿主注入。 */
  mergeEnvelopes?: (texts: readonly string[]) => string;
  recoverDelivery?: (text: string, replayedUserInputs: readonly string[], historyUnknown: boolean, receivedMessageIds?: ReadonlySet<string>) => string | null;
  attachmentStore?: AttachmentStore;
  logger: Logger;
  /** Notifies the privileged main process when an adapter-held platform token has no consumer. */
  onPlatformSessionClosed?: (sessionId: string, platformAccessSessionId?: string) => void;
  /** Durable serialization of the runtime machine queue across worker restarts. */
  promptQueueStore?: PromptQueueStore;
  /**
   * 一条回合提交了(#5381)。主进程据此把历史落盘——运行时这份 transcript 只活在内存里,
   * 进程一走就没了,而重放能不能把它补回来取决于 provider(实测 claude 的适配器在上下文压缩
   * 之后只重放最后一次压缩边界之后的部分)。
   *
   * `source` 说明回合来源，或标记同一回合的最终改口（`revision`：最后一轮；`backfill`：更早的一轮被迟到的
   * 事件补了内容，#6582）；怎么持久化由主进程定。
   */
  onTurnCommitted?: (event: {
    sessionId: string;
    providerId?: string;
    platformCredentials?: boolean;
    source: 'live' | 'replay' | 'revision' | 'backfill';
    turn: TranscriptTurn;
  }) => void;
}

export interface SendPromptInput {
  sessionId: string;
  prompt: PromptInput;
  /**
   * spec session-injection(next-tool-call 档的 mid-turn 支):忙时把同一条标准 session/prompt
   * **立即**发进当前 turn,❌ 不落机器队列。只有会话上那家 harness 的 descriptor 声明了
   * `next-tool-call` 的调用方才允许带它。
   */
  steerIfBusy?: boolean;
}
