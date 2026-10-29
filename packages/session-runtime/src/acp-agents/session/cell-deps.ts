import type { PromptAttachment, ProviderPermissionModeMap } from '@gugu/session-core/acp';
import type {
  AcpAgentApi,
  LiveSettingCapability,
  LiveSettingsCapability,
} from '@gugu/session-core/agents/plugins';
import type { AcpSendPromptError } from '@gugu/session-core/acp';
import type { Result } from '@gugu/session-shared';
import type { Logger } from '@gugu/session-shared/logger';

export interface ResolvedPromptAttachment {
  data: string;
  mimeType: string;
}

export type ResolvePromptAttachment = (
  attachment: PromptAttachment
) => Promise<ResolvedPromptAttachment>;

export interface SessionCellCallbacks {
  /** A real mid-turn input was admitted; the host may release only registered human-tool waits. */
  onPromptSteered?: () => void;
  onSessionStateChanged?: () => void;
  onTranscriptChanged?: () => void;
  onDraftChanged?: () => void;
  onClosed?: (exitCode: number | null) => void;
  /** v2 native admission failed internally. Retire the executor through the existing lifecycle. */
  onPromptRejected?: () => Promise<void>;
  onAgentEvent?: (phase: 'start' | 'stop' | 'error') => void;
}

export interface TurnEnvelope {
  readonly sessionId: string;
  readonly turnSequence: number;
  readonly model: string | null;
  readonly permissionMode: string | null;
  readonly effort: string | null;
  readonly providerSessionId: string;
  readonly requestId: string;
}

export type LiveSettingApplyResult =
  | {
      status: 'applied';
      effectiveValue: string;
      channel: LiveSettingCapability['channel'];
      /**
       * 我们请求的值，仅在它与 provider 回读回来的值**不同、且 provider 自己的目录里确实
       * 有我们请求的那一项**时出现 —— 也就是「它本可以照办，却停在了别处」。
       *
       * ⚠️ 别名被规范化（请求 `opus`、回读 `opus[1m]`，而目录里根本没有 `opus` 这一项）
       * **不算** substituted：那是 provider 把简称翻成它自己的正式写法，跑的就是我们要的那个东西。
       * 两者分开，是因为只有前者需要告诉用户，后者说出来只是噪音。
       */
      substituted?: string;
    }
  | { status: 'pending_next_turn'; requestedValue: string; channel: LiveSettingCapability['channel'] }
  | { status: 'restart_required'; requestedValue: string; channel: LiveSettingCapability['channel'] };

export interface SessionCellDeps {
  sessionId: string;
  projectId: string;
  providerId: string;
  acpSessionId: string;
  /**
   * 这条会话跑的是咕咕平台模型(宿主签了平台凭据)。那时被鉴权拒说的是平台那一侧,
   * ❌ 说成「这家在这台机器上的登录已失效」(#6264)。
   */
  platformCredentials?: boolean;
  agent?: AcpAgentApi;
  /** Provider-declared live setting contract. Missing declarations are an explicit runtime error. */
  liveSettings?: LiveSettingsCapability;
  /** Stable ACP modes are a permission source unless the provider explicitly says otherwise. */
  sessionModes?: 'permission' | 'none';
  /**
   * 会话开出来时用户选的档是不是完全访问(`isAutoApproveIntent(input)`)。
   * 是 ⇒ `session/request_permission` 由 cell 当场替用户作答,不进待决、不带状态。
   * 之后以用户在会话里改档的结果为准(见 `SessionCell.autoApprovePermissions`)。
   */
  autoApprovePermissions?: boolean;
  /** 该家声明的原生档位 ↔ 咕咕四档对应表;会话中改档时据它判新档是不是完全访问。 */
  permissionModeMap?: ProviderPermissionModeMap;
  resolveAttachment: ResolvePromptAttachment;
  /**
   * 这条会话的 agent 收不收 image 块(连接期 `initialize` 报的)。缺省 false = 协议默认。
   * 它是**连接级**事实,不是转录里推出来的,所以在连接建立后回填到 cell 并在 `config` 上发布。
   */
  acceptsImagePrompts?: boolean;
  /** Whether initialize negotiated the ACP `_session/steering` extension. */
  supportsSteering?: boolean;
  /** Host-verified personal assistant owner; absent for task agents and ordinary sessions. */
  assistantOwnerId?: string;
  /** Synchronous queue persistence must have succeeded before cancelling a replied continuation. */
  queuedPromptsPersisted?: () => boolean;
  /** 这一家「失败报成正常结束」的识别(插件 `acp.turnFailure`,语义见那里)。 */
  turnFailure?: {
    fromAgentMessage?: (text: string) => string | null;
    /** 还会从 stderr 报(晚到的那一行要等一下)。 */
    watchesStderr: boolean;
  };
  /**
   * 把回合期间攒下的**多条投递信封**合成一条 provider 输入。
   *
   * ⚠️ 实现体是 core 里那唯一一份 `mergeDeliveryEnvelopes`(spec delivery-routing 的单一属主),
   * 由宿主 composition root 接线注入 —— session-runtime 不依赖 `@gugu/core`,也 ❌ 不在这里复制信封语义
   * (那正是 #4429 删掉的第二属主)。缺省不注入时,多条信封**响亮失败**,❌ 不悄悄退回逐条发。
   */
  mergeEnvelopes?: (texts: readonly string[]) => string;
  /** Core-owned envelope identity and uncertainty marking, injected by the host. */
  recoverDelivery?: (text: string, replayedUserInputs: readonly string[], historyUnknown: boolean, receivedMessageIds?: ReadonlySet<string>) => string | null;
  logger: Logger;
  /**
   * behavior `agent-context-injection` 的 **③**:走用户级载体的会话级系统提示词。
   *
   * 这家没有系统位可坐,所以这段话以用户级载体进到**第一次真正发出去的那一轮**里,
   * 之后清空 —— 它是会话级的,**只说一次**。
   *
   * ⚠️ 与 `PromptInput.hiddenContext` **不是同一格**,即使线上长得一模一样(都是这一轮
   * prompt 里的一个文本块)。那一格是**这一条消息自己**的附加上下文(工单展开、mention),
   * 每轮可能有;这一格是会话级的。会话级的东西借道每轮的字段,就是把会话级状态伪装成
   * 消息内容 —— #3701 拆掉的正是那条路,后果实测过两条:按「一条消息」读取的地方认不出它,
   * 且 agent 把它读成「用户现在要我做的事」照着调工具。
   *
   * ⚠️ 不进转录:用户看不见它(它的身份是系统提示词)。
   */
  sessionContext?: string;
  callbacks?: SessionCellCallbacks;
}

export interface SessionPromptResult {
  queued: boolean;
  /** Internal target-side drain outcome; never part of sender admission. */
  requeuedAfterTokenBoundary?: boolean;
}

/** Admission is returned to host scheduling before the provider turn settles. */
export interface DetachedPromptResult {
  admission: Promise<Result<{ queued: boolean; steered?: boolean }, AcpSendPromptError>>;
  completion: Promise<Result<SessionPromptResult, AcpSendPromptError>>;
}
