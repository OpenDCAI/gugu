import type { TerminalState } from '../acp/models/terminals';
import { textFilePatch } from '../lib/text-diff';
import type { PermissionSubject } from '../acp/models/permissions';
/**
 * 会话记录（session record）契约 —— product spec 的读侧骨架。
 *
 * 定性：手机/桌面看到的「同一份时间线」来自 harness 自己留在机器上的会话记录，
 * 不来自咕咕怎么把它拉起来。各家的 JSONL / SQLite 原生记录直接解码成领域事件，
 * 喂进 `AcpTranscriptParser`，产出同一种 `TranscriptTurn[]`。记录源不构造 ACP 通知。
 *
 * 分层：
 *   SessionRecordSource（一家一个：定位文件/库、尾读、解码成 RecordEntry）
 *     → SessionTimeline（喂 reducer、发游标、按轮增量、审批/提问一次性结算）
 *       → 宿主 RPC / 设备 RPC（apps/desktop/electron/session/main/core/session-timeline）
 *         → 桌面渲染层 / 手机（apps/desktop/src/mobile/agent-watch）
 *
 * 只写 JSON 可序列化的东西：每一个类型都会经 Realtime 广播到手机。
 */
import type { NormalizedEvent } from '../acp/reducer/normalized-event';
import type { TranscriptItem, TranscriptTurn } from '../acp/models/turns/turn';
import type { QueuedPrompt } from '../acp/models/prompt';
import type { SessionLiveReply } from './live-reply';
export type { SessionLiveReply } from './live-reply';

/**
 * D-31 (owner 10-06「怎么符合用户思维和操作路径怎么来」): an approval the host asks on an agent's behalf — not one its
 * harness asked — kept on the session's timeline by the host itself, a chat-UI session's and a terminal one's alike: the
 * person answers it wherever they follow that session, and the first answer settles it (`respond`). `kind` says how a
 * surface draws it; `payload` is that kind's own.
 */
export const ASK_SOURCES = ['harness-permission', 'harness-question', 'agent-question', 'app-install', 'browser-assistance'] as const;
export type AskSource = (typeof ASK_SOURCES)[number];
export type AskOrigin = { source: AskSource; payload?: unknown };

/**
 * 协议 12 的宿主把 `origin` 叫 `host`(`{kind, payload}`,97ca6e73 改名):新的一端收进来时照新名读 ——
 * 两边差一档时由新的一侧降级(serverMachineHealth.ts「向下兼容一档」),❌ 让装 App / agent 提问画成光秃秃的权限卡。
 */
export function settlementFromWire<T extends { origin?: AskOrigin }>(settlement: T): T {
  const legacy = (settlement as { host?: { kind?: unknown; payload?: unknown } }).host;
  if (settlement.origin || !legacy || !(ASK_SOURCES as readonly unknown[]).includes(legacy.kind)) return settlement;
  return { ...settlement, origin: { source: legacy.kind as AskSource, payload: legacy.payload } };
}

/**
 * ⚠️ 协议下次升级时删掉(同 settlementFromWire,「向下兼容一档、新的一侧降级」;删它就删这一个 helper 和它的调用点)。
 *
 * 协议 14 把改文件的三种实体(13 的 create/modify/delete-file-tool-call)换成一个规范 patch 实体。差一档的两端在线上互通:
 *  · `from-peer`:13 的宿主发来的旧实体换成 patch(13 本来就带整份前后文本,`textFilePatch` 换算是精确的);
 *  · `to-peer`:发给 13 的端时,patch 实体降成 13 认识的通用工具行 —— 标题、路径照旧,输出是原始 patch 文本。
 *    13 的界面因此看不到彩色 diff;❌ 编造 13 要的整份文件。
 * 对端是 14 及以上 = 原样返回同一个引用(14↔14 不经过这里)。渲染层只认 14 的 patch 实体。
 */
export const FILE_PATCH_PROTOCOL = 14;
export function protocol13FileChanges<T>(value: T, peerProtocol: number, direction: 'from-peer' | 'to-peer'): T {
  if (peerProtocol >= FILE_PATCH_PROTOCOL) return value;
  const convert = direction === 'from-peer' ? fileToolFrom13 : patchToolTo13;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      const next = node.map(walk);
      return next.some((item, i) => item !== node[i]) ? next : node;
    }
    if (!node || typeof node !== 'object') return node;
    const record = node as Record<string, unknown>;
    let changed = false;
    const entries = Object.entries(record).map(([key, child]) => {
      const next = walk(child);
      if (next !== child) changed = true;
      return [key, next] as const;
    });
    const walked = changed ? Object.fromEntries(entries) : record;
    return convert(walked) ?? walked;
  };
  return walk(value) as T;
}

function fileToolFrom13(node: Record<string, unknown>): Record<string, unknown> | null {
  const { kind, path, content, oldText, newText, ...rest } = node;
  if (typeof path !== 'string') return null;
  const block = kind === 'create-file-tool-call' && typeof content === 'string' ? textFilePatch(path, null, content)
    : kind === 'modify-file-tool-call' && typeof oldText === 'string' && typeof newText === 'string' ? textFilePatch(path, oldText, newText)
    // 13 的删除不带内容:只说删了哪个路径,❌ 编一份被删的全文。
    : kind === 'delete-file-tool-call' ? { type: 'diff', changes: [{ operation: 'delete', path }], scope: 'unknown' }
    : null;
  return block ? { ...rest, kind: 'patch-tool-call', contentBlocks: [block] } : null;
}

function patchToolTo13(node: Record<string, unknown>): Record<string, unknown> | null {
  if (node.kind !== 'patch-tool-call') return null;
  const { contentBlocks, ...rest } = node;
  const diffs = (Array.isArray(contentBlocks) ? contentBlocks : [])
    .filter((block): block is { changes?: { operation?: string; path?: string }[]; patch?: { text?: string } } => block?.type === 'diff');
  const text = diffs.map(diff => diff.patch?.text
    ?? (diff.changes ?? []).map(change => `${change.operation ?? 'change'} ${change.path ?? ''}`).join('\n')).join('\n');
  const title = typeof rest.title === 'string' && rest.title ? rest.title : 'Edit';
  return { ...rest, kind: 'unknown-tool-call', name: title, toolKind: typeof rest.toolKind === 'string' ? rest.toolKind : 'edit',
    ...(text ? { outputText: text } : {}) };
}
import type { TimelineArchive } from './timeline';
import type { InstallationReading } from '../host-dependencies/runtime/types';

// ─── 定位一份记录 ──────────────────────────────────────────────────────────

/**
 * 读侧认得的**记录格式**(一族共用一个解码器),不是 provider id:opencode 这一格也装着 mimocode。
 * provider → 格式那张表在宿主的 `locate.ts`。
 */
export type SessionRecordHarness = 'claude' | 'codex' | 'opencode' | 'copilot' | 'hermes' | 'qwen' | 'pi';


/**
 * 记录在哪。由宿主按会话行(provider + sessionId + agent home)解析出来，
 * 记录源自己只按这个去找,❌ 不再猜路径。各家的差别(环境变量、默认目录、子路径)都在宿主那张表上，
 * 这里只剩一种形状。
 */
export type SessionRecordLocator = {
  harness: SessionRecordHarness;
  /**
   * provider 自己的会话 id(codex 是 thread id)。pi 终端腿记的是会话文件的绝对路径，
   * ACP 腿记的是 pi 的会话 id —— 是哪一种由值本身说(绝对路径与否),源自己认。
   */
  providerSessionId: string;
  /**
   * 候选位置，按序找第一个装着这条会话的。目录型的家是记录目录(`projects`、`sessions`…),
   * 库型的家(opencode 族、hermes)是库文件。
   * ⚠️ 是**列表**:各家的环境变量是覆盖不是替换，只认一个 ⇒ 挪过家的机器上旧会话在手机上静默消失。
   */
  roots: string[];
  /**
   * opencode 族：只读这个 agent 的消息(`message.agent_id`)。mimocode 把子 agent(checkpoint-writer 之类)
   * 的消息存在父会话里、靠这一列区分，它自己的 ACP 也只取 `main`;opencode 没有这一列，不填。
   */
  agentId?: string;
  /**
   * opencode 族：这些目录里的 `<app>-<通道>.db` 也认，排在 `roots` 之后。上游 `getChannelPath`:安装通道不是
   * latest / beta / prod 的构建库名带通道;通道是 harness 构建时定的，宿主不知道。关了按通道分库就不给。
   */
  channelDbs?: { app: string; dirs: string[] };
};

// ─── 游标 ────────────────────────────────────────────────────────────────

/**
 * 时间线上的位置。`epoch` 是这份时间线的世代号：宿主重开这份记录、记录被分叉/重建、
 * 记录源整份重读，都换新 epoch。拿旧 epoch 的游标来续 = 必须整份重载。
 * `seq` 在一个 epoch 内单调递增，0 = 「什么都没收到」。
 */
export type RecordCursor = { epoch: string; seq: number };

export const RECORD_RESET_REASONS = [
  'epoch_changed',
  'cursor_ahead',
  'source_replaced',
  'source_unreadable',
  // 推送是「发出去不管有没有到」的广播:丢一批之后,后一批的 `from` 会比手里的游标大。
  // 客户端认出这个断层就要整份重载 —— ❌ 不许把两段不连续的内容拼起来当完整的一份。
  'gap',
  // 缺口大过一份快照:补缺口已经不比整份重载便宜,而且拼接面越大越容易出错。
  'gap_too_large',
] as const;
export type RecordResetReason = (typeof RECORD_RESET_REASONS)[number];

// ─── 记录源 ───────────────────────────────────────────────────────────────

/**
 * 一条记录里解出多条时，key 后缀 `#<下标>`（下标 = 这条记录内容块的序号）。
 * 块数由记录本身定死 ⇒ 重读同一份记录得到同一批 key，去重才成立。
 * 边界条固定用 `#end` 后缀，与内容块的数字下标不会撞。
 */
export const RECORD_KEY_BOUNDARY_SUFFIX = '#end';

/**
 * 一轮的收尾。记录源说「这一轮到此为止」，时间线据此关掉当前这一轮并给它一个结局。
 *
 * ⚠️ 没有这条通道时，**最后一轮永远是 active、永远没有 outcome** —— 一个早就结束的会话
 * 在手机上看起来像还在跑（reducer 只在下一条用户消息到来时才顺手关掉上一轮，而"最后一轮"
 * 后面没有下一条）。这正是 product spec「状态与桌面一致」那条验收要的东西。
 *
 * 各家的记号（都拿真记录核过，不是照文档猜的）：
 *   claude   → assistant 记录的 `message.stop_reason`（`tool_use` 是"还要接着干"，❌ 不是边界）
 *   codex    → `event_msg` 的 `task_complete` / `turn_aborted`
 *   opencode → assistant 消息的 `time.completed`
 *   copilot  → 主 agent 不带 `toolRequests` 的 `assistant.message`;`abort` = 打断。
 *              (`assistant.turn_end` 按模型步发，❌ 不是回合结束)
 *   hermes   → 不带 `tool_calls` 的 assistant 行的 `finish_reason`;打断盘上没有记号，按下一句用户话到来时
 *              上一轮最后一行的形状认(Hermes 自己的 `classify_session_status` 同一个判法)
 *   qwen     → `system/branch_checkpoint`(ACP 腿上以 `end_turn` 结束才写;终端腿没有结束记号)
 *   pi       → assistant 消息的 `stopReason`（`toolUse` 同 claude 的 `tool_use`;`aborted` = 打断）
 */
/** The ending message ID also identifies fragments recorded after that end. */
export type RecordBoundary = { messageId?: string } & (
  /** 正常收尾。`stopReason` 是 provider 自己的说法，映射到 ACP 的那五种。 */
  | { kind: 'turn_end'; stopReason?: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' }
  /** 被打断（用户 ESC、进程被杀）。 */
  | { kind: 'turn_aborted' }
  /** 没做完：harness 自己记下的报错（claude 的 `isApiErrorMessage` 行）。 */
  | { kind: 'turn_failed' });

/**
 * 一条解码后的记录。`key` 是跨来源身份键：同一件事从两个来源各报一次也只算一次。
 *   claude   → `claude:<uuid>`
 *   codex    → `codex:<threadId>:<turn ordinal>:<item ordinal>`（Codex 恢复时会重编号，❌ 直接用它的 item id）
 *   opencode → `opencode:<message id>` / `opencode:<part id>`
 * `at` 是 provider 自己的时钟（epoch ms），拿不到就不填，❌ 拿 Date.now() 冒充。
 *
 * 两种形态二选一：带 `event` 的是**内容**（喂 reducer），带 `boundary` 的是**边界**
 * （不进时间线，只关掉当前这一轮）。❌ 不许一条同时是两者 —— 那样"这条要不要去重"没有答案。
 */
export type RecordEntry =
  | { key: string; at?: number; event: NormalizedEvent; boundary?: never }
  | { key: string; at?: number; boundary: RecordBoundary; event?: never };

export interface SessionRecordSourceEvents {
  /** 新解码出的记录，按记录里的先后顺序。 */
  onEntries(entries: RecordEntry[]): void;
  /** 记录整份换掉了（分叉、被删重建、库被重置）。收到后 timeline 必须换 epoch 并整份重读。 */
  onReset(reason: Extract<RecordResetReason, 'source_replaced' | 'source_unreadable'>): void;
}

/**
 * 「上次读到哪儿了」。由记录源自己产出、自己认领，外面只负责存起来再原样递回来 ——
 * 每一家的记录长得不一样（尾读一个文件 / 跟着分叉链走 / 查一张表），续读点的形状只有它自己知道。
 *
 * `fingerprint` 是给**外面**用的那一半：它必须能识别「这份记录还是不是上次那一份」。
 * 存续读点的那一层拿它做校验，对不上就整份重来 —— ❌ 不许拿着一个过期的偏移量往下读，
 * 那会静默拼出一份少了中间的时间线（而少一段和读得慢，在界面上完全分不出来）。
 */
export type SessionRecordResume = {
  /** 记录源自己的续读数据。对外不透明。 */
  readonly data: unknown;
  /** 这份记录此刻的身份指纹（路径 + inode + 大小 + mtime 之类，由源自己定义）。 */
  readonly fingerprint: string;
};

export interface SessionRecordSource {
  readonly locator: SessionRecordLocator;
  /**
   * 先整份读出已有内容（通过 onEntries 分批给），然后进入尾读；返回时首轮读取已完成。
   *
   * 给了 `resume` 就只读它之后的增量。⚠️ 源必须自己校验这个续读点还成不成立
   * （文件换了 inode、变短了、指纹对不上）；不成立就当没给，整份重读，
   * ❌ 不许勉强接着读 —— 接错了拼出来的是一份缺了中间的记录，而它不会报错。
   */
  start(events: SessionRecordSourceEvents, resume?: SessionRecordResume): Promise<void>;
  /**
   * 此刻的续读点。返回 null = 这一家不支持续读（或此刻还不能安全地续），
   * 外面据此退回「每次整份重读」，那是慢，不是错。
   */
  resumePoint?(): Promise<SessionRecordResume | null>;
  /** 立刻把尾读追到文件尾,读完(行已交给 onEntries)才返回。不支持的源没有这个口。 */
  catchUp?(): Promise<void>;
  stop(): void;
}

// ─── 时间线 ───────────────────────────────────────────────────────────────

export const SETTLEMENT_STATES = ['pending', 'resolved', 'cancelled'] as const;
export type SettlementState = (typeof SETTLEMENT_STATES)[number];

/**
 * 一个可选项。`optionId` 是 provider 自己的字符串（ACP `PermissionOption.optionId`），
 * `kind` 是它的提示（allow_once / reject_once / …，各家可扩展）。
 * ❌ 读侧不许自造 optionId —— 造出来的 id 发回去 agent 认不得，按钮就是个骗人的按钮。
 */
export type SettlementOption = {
  optionId: string;
  name: string;
  kind?: string;
  /**
   * 这一项是什么意思（AskUserQuestion 的 `options[].description`）。
   * 光有 label 时，几个选项在手机小屏上常常只差一两个词，人分不出来 ⇒ 要么点错、要么放着不点。
   */
  description?: string;
};

/**
 * 审批/提问的一次性结算。谁先答谁生效；第二个端答的被拒并拿到已有结算。
 * `resolvedBy` 是端的不透明标识（"desktop" / 设备 id / 手机 id），只用来显示「已在某端回答」。
 *
 * @@@settlement-prompt 手机端要**画出**这张卡才能让人答，而画一张卡至少要知道
 * 「问的是什么」与「有哪些选项」。这三个字段就是为此加的（2026-09-05，手机端实现时发现
 * 原契约只带结算状态、不带提问内容 ⇒ 手机拿到 pending 也只能干瞪眼）。
 * 全部可选：宿主没填时手机如实说「请在桌面端回答」，❌ 不渲染任何猜出来的按钮。
 */
export type Settlement = {
  itemId: string;
  /** 这是审批还是提问 —— 决定卡片形态，也回填 `sessionTimeline.sessionRespond` 的 `kind`。 */
  kind?: 'permission' | 'question';
  /** 问的是什么：审批取触发它的工具调用标题，提问取问题正文。 */
  title?: string;
  /** 次要说明（命令行、路径、提问的补充）。 */
  detail?: string;
  subject?: PermissionSubject | null;
  /** 可选项。空或缺省 ⇒ 手机不渲染可点按钮。 */
  options?: readonly SettlementOption[];
  /**
   * 提问工具的全部题目(Claude AskUserQuestion / codex request_user_input / opencode question)。**有它 ⇔ 宿主能从
   * 别的端代答这道题**(终端腿、这家声明了关掉选择器的取消键 —— 宿主开时间线时判一次,只在那里判)。`title` / `options` 仍是第一题,老手机照旧画得出。
   */
  questions?: readonly SettlementQuestion[];
  /** 记录里问出这道题的时刻(与 `questions` 同在)。选择器只开在问出它的那一代 agent 进程里。 */
  askedAt?: number;
  /** 记录里这道题已经有了结果(答了或拒了)—— 终端里的选择器已经关了。只对带 `questions` 的项记。 */
  resultRecorded?: boolean;
  /** D-31 宿主替 agent 问的那一种(装 App):端上画它自己的卡,答案经 `respond` 交回宿主。 */
  origin?: AskOrigin;
  /**
   * 协议 12 的端读的旧名(`origin` 之前叫 `host: {kind, payload}`,只给宿主替 agent 问的那两种):新宿主照旧带上,
   * 老桌面 / 老手机连上来时装 App、agent 提问照旧画成自己的卡(向下兼容一档,新的一侧负责降级)。新端只读 `origin`。
   */
  host?: { kind: 'app-install' | 'agent-question'; payload?: unknown };
  state: SettlementState;
  optionId: string | null;
  resolvedBy: string | null;
  resolvedAt: number | null;
};

/** 提问的一道题。`options[].optionId` 同样取 label 原文。 */
export type SettlementQuestion = {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: readonly SettlementOption[];
};

/**
 * 一道题怎么答:选中的 label,外加(可选)自己写的一段话。
 * 单选:恰好一个 label,或者只有 `other`;多选:零到全部 label,外加可选的 `other`。
 */
export type QuestionAnswer = { selected: readonly string[]; other?: string };

/**
 * 这一项从另一端(手机)答不答得了;答不了时码与宿主写侧抛的 `SessionWriteError` 同名。
 * 写侧据此拒绝,手机据此一开始就说去哪答、不画按钮 —— 同一条判据只有这一份(#6739:
 * 两边各判一份时,手机画出一排按下去必被拒的按钮,拒了之后卡上还写着「已回答」)。
 *
 * 终端腿的审批/提问画在终端里,没有请求 id —— 除非这道提问带着 `questions`(宿主能关掉选择器、把回答当消息发回);
 * ACP 腿的提问宿主还没有结算入口。
 */
export function remoteSettlementGap(
  runtime: string | null | undefined,
  kind: Settlement['kind'],
  questions?: Settlement['questions'],
  /** D-31 The host's own ask: settled by the host, on either kind of session. */
  origin?: Settlement['origin']
): 'no_permission_channel' | 'no_question_channel' | null {
  if (origin && origin.source !== 'harness-permission' && origin.source !== 'harness-question') return null;
  if (kind === 'question' && questions) return null;
  if (runtime !== 'acp') return 'no_permission_channel';
  return kind === 'question' ? 'no_question_channel' : null;
}

/** 整份快照：从最新往回取 `limit` 轮。 */
export type TimelineSnapshot = {
  cursor: RecordCursor;
  turns: TranscriptTurn[];
  settlements: Settlement[];
  hasOlder: boolean;
  /** Shared, name-only action projection used by desktop and mobile surfaces. */
  recentActions?: string[];
  /** Newest known tool-action timestamp, including actions outside the window. */
  lastActionAt?: number | null;
  /**
   * 已发出、还排着没被 agent 接走的输入 —— 与桌面「Queued prompts」同一份（ACP 腿：宿主运行时的队列）。
   * 每次都是此刻的全集；缺省 = 宿主太旧，不报队列。终端腿不投影（owner 2026-10-04）。
   */
  queuedPrompts?: Pick<QueuedPrompt, 'id' | 'text'>[];
  /** Actual in-flight reply stage; absent on older hosts, null when no live reply is present. */
  liveReply?: SessionLiveReply | null;
  /** Live presentation only; not serialized into the native-record archive. */
  terminals?: readonly TerminalState[];
};

/**
 * 增量里的一轮：只带**从 `from` 之后变过的条目**，外加这一轮此刻完整的条目 id 顺序。
 *
 * 为什么不整轮重播（#3566 手机看会话审计，2026-09-08 实测）：整轮重播时一轮里每有一点变化
 * 就把全部消息 + 全部工具调用 + 全部工具输出再发一遍，一条 45 秒的会话推送包从 1.3KB 涨到
 * 78KB、累计 339KB，其中 3/4 是重复搬运；而广播通道的额度是整个库每秒 100 条消息共用。
 *
 * 收批人按 `itemIds` 重排：id 在 `items` 里的取新的，不在的沿用手里那份；手里也没有的
 * ⇒ 中间丢过一批，按「缺口」处理（整份重拉），❌ 不拼出一份少了中间的。
 * 同一批应用两次结果一样（按 id 替换是幂等的）。
 */
export type TurnPatch = Omit<TranscriptTurn, 'items'> & {
  /** 这一轮此刻**全部**条目的 id，按顺序。缺省的条目沿用收批人手里的。 */
  itemIds: string[];
  /** 从 `from` 之后新出现或改过的条目（嵌套的工具组整个作为一条）。 */
  items: TranscriptItem[];
};

/**
 * 增量。以**条目**为单位替换（见 `TurnPatch`）：每一批带的是变过的条目，不是整轮。
 * `removedTurnIds` 给分叉/回滚用。
 */
export type TimelineBatch = {
  /**
   * 这一批是从哪个序号接上的（= 收批人应有的当前 seq）。
   *
   * 没有这个字段就判不出「中间丢了一批」：广播推送是 fire-and-forget，丢一批之后下一批照样
   * 是合法的 `cursor`，客户端会把游标直接跳过去，被跳过的那段**再也不会被请求第二次**。
   */
  from: number;
  cursor: RecordCursor;
  turns: TurnPatch[];
  removedTurnIds: string[];
  settlements: Settlement[];
  /** Shared, name-only action projection used by desktop and mobile surfaces. */
  recentActions?: string[];
  /** Newest known tool-action timestamp, including actions outside the window. */
  lastActionAt?: number | null;
  /** 同快照的 `queuedPrompts`：每一批都带此刻的全集。 */
  queuedPrompts?: Pick<QueuedPrompt, 'id' | 'text'>[];
  /** Actual in-flight reply stage; absent on older hosts, null when no live reply is present. */
  liveReply?: SessionLiveReply | null;
  /** Live presentation only; not serialized into the native-record archive. */
  terminals?: readonly TerminalState[];
};

export type TimelineAfterResult =
  | { ok: true; batch: TimelineBatch }
  | { ok: false; reset: RecordResetReason; snapshot: TimelineSnapshot };

/**
 * 往**前**取更早的轮（快照是从最新往回取 `limit` 轮，更早的那些要用这个懒加载）。
 *
 * 带 `epoch`：翻页途中宿主换过代（记录被分叉、整份重读）时，这一批与手里那份不是同一条
 * 时间线，拼进去就是「少了中间的那一份」。❌ 不静默丢弃，也 ❌ 不静默合并 —— 交给客户端判。
 */
export type TimelineOlderResult = {
  epoch: string;
  turns: TranscriptTurn[];
  /** 这一批之前还有没有更早的。 */
  hasOlder: boolean;
};

/**
 * 宿主报进来的一条「provider 此刻正在等人回答」的请求。
 *
 * 为什么读侧自己认不出来：ACP 的审批走 `session/request_permission`，那是一条**请求应答** ——
 * 它不进会话记录，只有当时连着的那个 ACP 客户端看得见。记录里能看到的只有触发它的那条工具调用，
 * 而工具调用本身并不说明「它卡在这儿等人」。所以这一档只能由宿主从活运行时里同步进来。
 *
 * 字段与 `Settlement` 的同名字段一一对应 —— 它进时间线之后就是一条 `state: 'pending'` 的结算，
 * 与记录里认出来的提问项走同一套 CAS、同一套推送、同一张卡。
 */
export type PendingRequest = {
  /** provider 自己的请求 id。回答时原样发回去（ACP `resolvePermission` 的 requestId）。 */
  itemId: string;
  kind: 'permission' | 'question';
  title: string;
  detail?: string;
  subject?: PermissionSubject | null;
  options: readonly SettlementOption[];
  /** Host-owned structured question, answerable on every harness. */
  questions?: readonly SettlementQuestion[];
  askedAt?: number;
  /** D-31 宿主替 agent 问的(不是它的 harness 问的):端上按 `host.kind` 画它自己的卡。 */
  origin?: AskOrigin;
};

export type SettleResult = { ok: true; settlement: Settlement } | { ok: false; existing: Settlement };

export interface SessionTimeline {
  readonly epoch: string;
  getSnapshot(options?: { limit?: number }): TimelineSnapshot;
  /** 从 cursor 之后取；epoch 不对或 cursor 超前 → reset + 快照。 */
  getAfter(cursor: RecordCursor): TimelineAfterResult;
  /** 取 `beforeTurnId` 之前的若干轮。那一轮不在手里这份里（已被分叉掉）时按「没有更早的」回。 */
  getOlder(input: { beforeTurnId: string; limit?: number }): TimelineOlderResult;
  /** 从 cursor 之后持续推；订阅那一刻先补一次缺口。 */
  subscribe(cursor: RecordCursor | null, listener: (result: TimelineAfterResult) => void): () => void;
  /** compare-and-set：pending → resolved 只成功一次。终端提问的认领没有 optionId(答案写进终端,不记在这里)。 */
  settle(input: { itemId: string; optionId: string | null; by: string }): SettleResult;
  /** 把记录读到此刻的文件尾(读完才返回)。判「选择器还开着没有」之前先调它。 */
  catchUp(): Promise<void>;
  /** 记录里这条提问型工具调用还没有结果 = 终端里的选择器还开着。与结算状态无关:认领了也还开着。 */
  questionOpen(itemId: string): boolean;
  /**
   * 宿主把**活运行时**里此刻正在等人回答的请求整份同步进来（不是增量：这一批就是当前全集）。
   *
   * 只管自己报过的那些 itemId：
   *  · 新出现的 → 落一条 `pending`，手机据此画卡。
   *  · 报过、这次不在名单里、且还是 `pending` 的 → `cancelled`（那边已经答了/超时了，
   *    这台机器上再点也没用）。**不碰**已 `resolved` 的：那是刚被谁答掉的，不许倒回去。
   *  · 记录里认出来的提问项（AskUserQuestion / ExitPlanMode）一概不碰 —— 它们不由活运行时供给。
   *
   * 幂等：同一批同步两次结果一样。
   */
  syncPendingRequests(requests: readonly PendingRequest[]): void;
  /**
   * 宿主把**活运行时**里这条会话的排队提示（`session.state` 的 `queuedPrompts`）整份同步进来（ACP 腿）。
   */
  syncQueuedPrompts(prompts: readonly Pick<QueuedPrompt, 'id' | 'text'>[]): void;
  syncLiveReply(reply: SessionLiveReply | null): void;
  syncTerminals(terminals: readonly TerminalState[]): void;

  /** 一个 item 已由 provider 侧了结（超时、取消）时由宿主调用。终态，❌ 不能再答。 */
  cancelSettlement(itemId: string): void;
  /**
   * 回滚一次结算：CAS 抢到了，但往 provider 投递失败 ⇒ 把这一项放回 pending，让人重答。
   *
   * ❌ 别拿 `cancelSettlement` 顶替：它的意思是「这一项已经了结了」，用在这里手机上显示成
   * 「已取消」，而 agent 其实还在等人答 —— 一个还能救的会话被显示成救不了的。
   *
   * 提问的结果已经进了记录(`resultRecorded`)时,放掉认领就是这条已经不需要回答了(`cancelled`),❌ 放回可答。
   */
  releaseSettlement(itemId: string): void;
  dispose(): void;
  /**
   * 交出此刻的存档，供宿主存盘、下次开这条会话时直接装回来。
   * 返回 null = 这条时间线存不了（记录源不支持续读）——那只是慢，不是错。
   */
  archive?(): Promise<TimelineArchive | null>;
}

// ─── agent 的跨机器动作(机器 ↔ 机器)──────────────────────────────────────────────────────────────────
//
// 会话页的读写都在会话页路由表上(手机和别的电脑开 `taskhost.*` 窗口问)。agent 的 session_* 跨机器动作(owner
// 2026-09-30)是同一张表上的 `agentSession.<动作>(caller, action)`,经 `taskhost.call` 一问一答:载荷是本机工具的那一份
// (`SessionAction`,外加 locate / peers / app_install),应答是那个动作的结果(id 裸的,发起方在 MCP 边界编码)。
// 另一台机器上的 App 调用方只收 `message`、`read_file` 和 `app_call`;后两个也只收 App(agent 在自己那台机器上有
// 文件工具、有自己的工具)。

export const AGENT_SESSION_ACTIONS = [
  'activity_list', 'activity_context', 'peers', 'locate', 'list_harnesses', 'list_models', 'spawn', 'children', 'message',
  'get', 'stop', 'archive', 'set_parent', 'app_install', 'app_manage', 'read_file', 'app_call',
  'project_list', 'project_create', 'project_get', 'project_add_folder', 'project_remove_folder',
  'project_remove_device', 'project_restore_device', 'project_prepare_device', 'project_bind_folder',
] as const;

export type AgentSessionActionName = (typeof AGENT_SESSION_ACTIONS)[number];

/**
 * 发起跨机器 session 动作的那条会话(在另一台机器上)的自述。凡是本机工具从发起方会话行上读的,
 * 这里都由请求带来:默认 harness / 形态 / 模型、信封里的名字。信任边界是账号(设备 RPC 频道只对本账号开)。
 */
export type RemoteSessionCaller = {
  deviceId: string;
  /** 发起方那台机器给人看的名字;收信方信封里的 `from` 带着它。 */
  deviceLabel: string | null;
  /** 发起方会话的地址(裸 conversation id)—— `session:` 跨机器可达,对方直接回得来。 */
  sessionId: string;
  /** 发起方的 Agent ID;身份还没铸出来时为 null。 */
  agentUserId: string | null;
  name: string | null;
  harness: string | null;
  /**
   * #7199 发起方 agent 配的「子 agent 不指定 harness 时用哪个」;没配(或与 harness 相同)= null / 缺席,照旧继承 harness。
   * 可选:旧版本的发起方不带,收方按没配处理。
   */
  childHarness?: string | null;
  transport: 'acp' | 'pty';
  /** 发起方跑的 harness 自家模型;没有 = null。 */
  model: string | null;
  /** 发起方跑在咕咕平台模型上时,那个模型在 `session_list_models` 里的 id(`platform:` 前缀);没有 = null。 */
  platformModel: string | null;
};

/** 另一台机器上的一个 App(`agents:control:all-machines`):不是一条会话,没有 `sessionId`。 */
export type RemoteAppCaller = {
  kind: 'app';
  deviceId: string;
  deviceLabel: string | null;
  extensionId: string;
  /** 发起方宿主上已装清单里的名字:收信方信封里「来自哪个 App」。 */
  extensionName: string;
};

export type RemoteCaller = RemoteSessionCaller | RemoteAppCaller;

/** App 发消息的送法(`messageAgent` 的 queue / defer / key):本机这台和别的机器上同一份。 */
export type AppMessageOptions = { delivery?: 'queue' | 'defer'; key?: string };
export type AppMessageReceipt = { id: string; deferred?: true };
/** An App starts an agent on another computer through the same App spawn core. */
export type AppSpawnAction = { action: 'spawn'; prompt: string; spawn: {
  title?: string; harness?: string; model?: string; transport?: 'acp' | 'pty'; project?: string; chat?: string; device?: string;
} };
/** App 调用方给一条会话发消息(会话 id 由发起方从那台机器的会话列表里取)。 */
export type AppMessageAction = { action: 'message'; session_ids: [string]; text: string } & AppMessageOptions;
/** App 调用方读一条会话工作副本里的一块(#6264 的块,路径相对那份工作副本;`files:read:all-machines`)。 */
export type AppReadFileAction = { action: 'read_file'; session_id: string; path: string; offset: number; length: number };

/**
 * App 调用方让那台机器替它的页面做一个「跟着会话的机器」的动词(页面在那台机器的一条会话里;owner 10-16「程序跟着数据」):
 * `method` / `args` 就是页面调的那个 bridge 动词和它的参数,哪些动词能这样走由 `BRIDGE_VERBS` 的 `machine` 定(两边读同一张表)。
 * `call_id` 是发起方给这一次调用的编号:同一次请求被设备 RPC 重发时编号相同,那台机器接回第一次的结果,❌ 再做一遍。
 * `version` 是发起方装的那一版:两台不同版就拒。
 */
export type AppCallAction = {
  action: 'app_call';
  call_id: string;
  session_id?: string;
  /** Explicit machine target when the call is not attached to a session. Exactly one target is present. */
  device_id?: string;
  version: string;
  method: string;
  args: Record<string, unknown>;
};

/**
 * 页面叫另一台机器(桌面或手机发起都一样)的规矩，只在这里定一份:一次调用和它的回答各自最多 1 MB(JSON 的 UTF-8 字节，
 * 超了整个拒，不截断 —— 跨机器的数据文件因此也是 1 MB,owner 10-17「更优雅的话就去做吧」);叫程序等 75 s(那台机器上
 * MCP 客户端自己的 60 s,加上来回),别的动词等 30 s。
 */
export const APP_CALL_MAX_BYTES = 1024 * 1024;
export const APP_PROGRAM_CALL_WAIT_MS = 75_000;
export const APP_CALL_WAIT_MS = 30_000;
export const appCallWaitMs = (action: Pick<AppCallAction, 'method'>): number => (action.method === 'callProgram' ? APP_PROGRAM_CALL_WAIT_MS : APP_CALL_WAIT_MS);

export type AgentSessionAction = { action: AgentSessionActionName } & Record<string, unknown>;

/**
 * 归档 / 删除「连同子会话」时这一次没够着的机器(owner 2026-10-01「一起收」):它上面的子会话原样留着。
 * `deviceId` / `label` 空 = 连别的机器都没问成;`detail` 是给 agent 看的那句话。
 */
export type UnreachedMachine = { deviceId: string | null; label: string | null; detail: string };

/**
 * 一条会话上可改的选项。三档各自可能不存在 —— provider 没声明就是 null，
 * 界面上**不摆不存在的档**（@@@permission-three-modes 那条规矩）：摆一个按下去必失败的
 * 选择器，比不摆更糟。
 */
export type SessionOptionChoice = { id: string; name: string; description?: string };

export type SessionOptionGroup = {
  selected: string | null;
  available: SessionOptionChoice[];
};

export type SessionpageSessionOptions = {
  /** 权限档（plan / 只读 / 可改 / 全放开，各家声明的那几档）。 */
  mode: SessionOptionGroup | null;
  model: SessionOptionGroup | null;
  effort: SessionOptionGroup | null;
};

export const SESSION_OPTION_DIMENSIONS = ['mode', 'model', 'effort'] as const;
export type SessionOptionDimension = (typeof SESSION_OPTION_DIMENSIONS)[number];

export type SessionpageSessionCancelRequest = { conversationId: string };
export type SessionpageSessionDeleteRequest = { conversationId: string };
/** 三格都可选,给了哪格改哪格;`archived: true` 只归档(手机上不列归档的,取消归档在桌面做)。 */
export type SessionpageSessionUpdateRequest = {
  conversationId: string;
  title?: string;
  pinned?: boolean;
  archived?: true;
};
export type SessionpageSessionUpdateResult = { title: string; isPinned: boolean; archived: boolean };
/** `cancelled=false` = 这条会话此刻没有在飞的东西可停(引擎不在 / 终端腿没起),不是失败。 */
export type SessionpageSessionCancelResult = { cancelled: boolean };

export type SessionpageSessionSetOptionRequest = {
  conversationId: string;
  dimension: SessionOptionDimension;
  value: string;
};

export type SessionpageSessionReloadModelRequest = {
  conversationId: string;
  /** 裸 id(咕咕模型不带 `platform:`)。 */
  model: string;
  /** 新模型走哪条计费路,与 `model` 同进同出 —— 少了它重开会带着旧的那条路重来。 */
  modelSource: 'platform' | 'own';
};

/** `kind: 'workspace'`(#609):咕咕自己要用的目录(任务工作区、替人登记的 ~),不是项目 —— 它的会话列在「任务」里。 */
export type SessionpageProjectSummary = { id: string; name: string; path: string; kind?: 'workspace' };

export type SessionpageSessionSummary = {
  conversationId: string;
  projectId: string;
  title: string;
  harness: SessionRecordHarness | string;
  /** 会话启动形态：协议腿或终端腿。写侧按它走，读侧不看它。 */
  runtime: 'acp' | 'pty' | 'unknown';
  /**
   * 老版本手机读的那一项:写的是它认得的旧词(`needs_user` 写成 `needs_approval`)。新手机读 `status`。
   */
  agentStatus: string | null;
  /**
   * 这条会话此刻的读数(`@gugu/core/shared/agentStatus` 的 `AgentStatusView`:基础态 + 附属态),读侧用
   * `parseAgentStatusView` 解析。缺席 = 宿主版本还不报它(退回读 `agentStatus`),`null` = 没有状态源。
   */
  status?: { status: string; detail: string | null } | null;
  lastInteractedAt: string | null;
  /** 三家之外、或记录定位不到：如实标不支持，❌ 给空白页。 */
  supported: boolean;
  unsupportedReason?: string;
  /**
   * 以下三项都是 `conversations` 表里**早就有**的列，先前没往手机端传，于是手机上的会话列表
   * 既没有置顶区、也认不出未读，更画不出子 agent 的谱系 —— 而咕咕自己的桌面侧栏三样都有。
   * ❌ 不新增 schema：这里只是把已有的事实带过网。
   *
   * ⚠️ 三项都是**可选**的，因为还有第二条来路：机器离线时手机看的是心跳带上来的摘要，
   * 而**老宿主写的那份摘要里没有这三个键**。缺席的含义是「不知道」，不是 false ——
   * UI 见到 undefined 要画中性态（不标置顶、不点未读、不缩进），
   * ❌ 不许补一个默认值冒充事实：那会把一条置顶的会话画成没置顶。
   */
  /** 置顶。置顶的行离开项目分组，聚到列表顶部的「置顶」区（与桌面侧栏同一条口径）。 */
  isPinned?: boolean;
  /**
   * 这条会话的状态**你还没看过**。桌面侧栏据此点亮注意力点、标题加粗。
   * ⚠️ 语义是「未读」不是「有事」：做完了但你没看过，也算未读。
   */
  unseen?: boolean;
  /**
   * 谁把这条会话生出来的。咕咕的 agent 会递归派生子会话，桌面侧栏按它缩进成一棵树
   * （侧栏用的就是这一列，❌ 不是 `spawnedByConversationId`）；没有父的就是根。
   * ❌ 不用它判「支持与否」，只用来排版。
   */
  parentConversationId?: string | null;
  /**
   * 派它的会话。别的机器归档 / 删除「连同子会话」时按父子关系(父会话、由谁派的)找后代
   * (owner 2026-10-01「一起收」)。老宿主不带。
   */
  spawnedByConversationId?: string | null;
  /** Original request links persisted by session_spawn / session_message. Absent on older hosts. */
  activitySourceLinks?: readonly string[];
  /** 这条会话的 agent(本机名录的绑定,没有身份 = null)。只带 id:显示名只在云端 `identity.users`,看的一端按 id 取。老宿主不带。 */
  agent?: { userId: string } | null;
  /** 宿主提供的真实咕咕私聊；手机 Agent 可通过它继续任务，独立于 workspace 转录支持。 */
  chatId?: string;
  /** 起它的 App(`spawnedByExtensionId`);App 列 agent 时由发起方比对成「是不是我起的」。老宿主不带。 */
  spawnedByExtensionId?: string | null;
  /**
   * 为什么这条会话没有记录可读(`supported: false` 时):`not-started` = agent 还没真正开出会话
   * (建的时候没起来);`harness-unsupported` = 这一家的记录还没有接。老宿主不带这一格。
   * 两种都**照样打得开**:转录里是第一句话和一行说明,❌ 不是一行点不开的灰字。
   */
  recordState?: 'not-started' | 'harness-unsupported';
  /** 上一次起这条会话失败的原因码(见 `remoteFailureKind`);只在还没起来时出现。 */
  startFailure?: string;
  /**
   * 这条会话给自己排的定时(#7221 schedule_create)里还要给人看的:还会回来的,与最近一次没送到的。
   * `null` = 一条都没有;缺席 = 宿主版本还不报它,画中性态(❌ 当成「没有」)。
   */
  schedule?: SessionpageScheduleDigest | null;
};

/** 列表一行上那枚定时标记要的全部:几条、下一个几点回来做什么、有没有没送到的。 */
export type SessionpageScheduleDigest = {
  count: number;
  /** 下一个要回来的那一刻(ISO);只剩没送到的 = null。 */
  nextAt: string | null;
  /** 下一个要回来的那条的标题;只剩没送到的就是那一条的。 */
  title: string;
  /** 有一条最近一次没送到:失败,或错过(机器关着过了点 / 上一次还没跑完);带它自己的标题(未必是下一个那条)。 */
  attention: { kind: 'failed' | 'missed'; title: string } | null;
};

/**
 * 这台机器上可选的一家 harness。
 *
 * `status` **原样带三态**（那台机器的依赖管理器怎么报就怎么报）：
 *   · `available` 能用 · `missing` 没装 · `error` 装了但坏了
 * ❌ 不在传输层压成一个 `installed: boolean`：那会把「装了但坏了」和「压根没装」说成同一句，
 * 而这两种情况人要做的事完全不同（一个是去修，一个是去装）。
 * 不能用的也照报 —— ❌ 不静默过滤：过滤剩一个空列表，而空列表说不出「为什么空」。
 */
/** 展示(产品词):编程 = 终端腿,通用 = 聊天腿。与桌面 composer 的 SessionView 同一套词。 */
export type SessionpageSessionView = 'code' | 'general';
export type SessionpagePermissionMode = 'plan' | 'read-only' | 'edit' | 'full-access';

export type SessionpageHarnessOption = {
  id: string;
  name: string;
  status: 'available' | 'missing' | 'error';
  /**
   * 这家在**这台机器上**的四态安装读数(已装 / 选中那份没了 / 装了起不来 / 没装)—— 与这台机器自己的
   * 桌面新建面、资源库同一格(`AgentPayload.reading`)。别的机器上的创建框照它分组,❌ 拿发问那台电脑的读数顶替。
   * 旧版机器端不报 ⇒ 按 `status` 折(`readingFromStatus`)。
   */
  reading?: InstallationReading;
  /**
   * 这家在这台机器上给哪几种展示 —— 与桌面新建面同一份判定(`agentOffersSessionView`)。
   * 空数组 = 一种都接不通(此时按 `status` 那一格说原因)。
   */
  sessionViews: SessionpageSessionView[];
  /**
   * 这家声明过的咕咕权限档(从严到松)—— 与桌面新建面同一份判定(`agentSupportsPermissionMode`)。
   * 空数组 = 这家没声明档位,界面不摆,会话用它自己的默认。
   */
  permissionModes: SessionpagePermissionMode[];
  /**
   * 手机端读得了这家的会话记录吗(= 宿主 `locate.ts` 的 provider → 记录格式表里有它)。
   * 装了、也能起,但读侧不认它的记录格式 ⇒ 从手机建出来的会话手机上打不开。
   * 照列不藏,标出来点不动 —— 与「没装」同一条口径。
   */
  watchable: boolean;
  /** 可在 Agent 的真实咕咕对话中继续任务；不代表支持 workspace 转录。 */
  chatAvailable?: boolean;
};

/**
 * 这台机器上**最近一次新建**的会话当时用的那一套 —— 手机新建页按它预选(behavior mobile-session-view
 * 「新建会话沿用上次的选择」)。桌面开的、手机开的都算。
 * 各格与 `SessionpageSessionCreateRequest` 同一套编码(`model` 的 `platform:` 前缀 = 咕咕平台模型);
 * 这台机器现在还能不能用,由手机端对照 `projects` / `harnesses` / 模型目录逐格核。
 */
export type SessionpageSessionCreateLastUsed = {
  projectId: string;
  harness: string;
  sessionView: SessionpageSessionView;
  permissionMode: SessionpagePermissionMode | null;
  model: string | null;
  effort: string | null;
};

/** 新建会话前的选项：项目 + harness + 上次用的那一套。都从**那台机器**上现读。 */
export type SessionpageSessionCreateOptions = {
  projects: SessionpageProjectSummary[];
  harnesses: SessionpageHarnessOption[];
  /** 这台机器上一条新建过的会话都没有 = null。 */
  lastUsed: SessionpageSessionCreateLastUsed | null;
};

export type SessionpageSessionCreateModelsRequest = {
  /** provider id，取自 `sessionCreateOptions` 报的那一份。 */
  harness: string;
  /** 目录按腿算(咕咕那组 provider × 腿);不给 = 那台电脑按自己的「终端」开关定(开 → 编程,关 → 通用),这家不给那种就取它给的第一种。 */
  sessionView?: SessionpageSessionView;
  /** 已选的模型(与 create 请求同一套编码);推理档按模型算(桌面同一条),没选就按默认模型。 */
  model?: string;
};

/** 一条可选模型。`id` 原样传回 `sessionCreate.model` 即可，❌ 手机端不解释前缀。 */
export type SessionpageSessionCreateModelChoice = {
  id: string;
  name: string;
  description?: string;
  /** 谁的额度：`harness` = 用户自己的 Key；`gugu` = 咕咕平台模型，按积分计费。 */
  source: 'harness' | 'gugu';
  credit_multiplier?: number;
  /**
   * 只有 `gugu` 条目可能有:这个用户的会员档用不了它、要开会员(#7056)。旧宿主不带 ⇒ 缺席 = 能用。
   * 手机新建页不列它(只在设置「模型」页出现,挂着升级解锁)。
   */
  requires_membership?: boolean;
  /** 只有 `gugu` 条目可能有:他在设置「模型」页关掉了它(#7056),手机新建页不列。旧宿主不带 ⇒ 缺席 = 没关。 */
  hidden?: boolean;
};

/**
 * 选定 harness 的模型目录（两组并成一份，harness 自家在前、咕咕的在后，与桌面下拉同序）。
 * 空列表要说得出为什么：两段 reason 各自解释自己那一组为什么缺席。
 */
export type SessionpageSessionCreateModels = {
  harness: string;
  transport: 'acp' | 'pty';
  models: SessionpageSessionCreateModelChoice[];
  /** harness 自家目录当前默认选中的那个；不选模型时会话就用它。 */
  selected: string | null;
  /** 推理档（引擎的固有属性，没登录也有）；不声明的家是空数组，界面不摆。 */
  efforts: Array<{ id: string; name: string; description?: string }>;
  selectedEffort: string | null;
  /**
   * harness 自家那一组的探测状态（与桌面目录同一套词）：`ready` 有货；`auth-required` 那台机器上这家没登录；
   * `not-installed` / `unsupported` / `unknown`（还没探完）/ `unavailable`（起不来，原因在 harnessReason）。
   * 手机端按这个词措辞，❌ 不把状态码画给人看。
   */
  harnessState: 'unknown' | 'ready' | 'not-installed' | 'unsupported' | 'auth-required' | 'unavailable';
  /** `unavailable` 时机器报的原话；其它状态 null。 */
  harnessReason: string | null;
  /** 咕咕那一组缺席的原因（产品定性原话）；在场时 null。 */
  guguReason: string | null;
  /**
   * `selected`(这家自家的默认模型)在那台机器上有没有凭据(#6264)—— 与桌面 composer 定默认值用的同一个读数。
   * 有的家(codex)没登录也报得出自家目录,光看 `harnessState: ready` 会把默认按在一个一跑就 401 的模型上。
   * 旧版机器端不报 = 缺席,按 `unknown` 处理(维持原行为)。
   */
  selectedCredential?: 'credentialed' | 'uncredentialed' | 'unknown';
  /**
   * 这家 harness 在那台机器上**登没登**(#6264)—— 与桌面「资源库 → 智能体 → 账号」那一行同一个读数
   * (跑会话会用的那份 CLI 与配置根,例如 `codex login status`)。
   *
   * ⚠️ 与 `harnessState` 不是一回事:模型目录探针问的是「起一次会话能不能列出模型」,而有的家(codex 经
   * app-server)没登录也列得出自家目录 —— 光看它,界面会把一台没登录的机器说成能用。旧版机器端不报 = 缺席。
   */
  harnessAuth?: SessionpageAgentAuthState;
  /**
   * `harnessAuth === 'signed-out'` 且是「登录已失效」(凭据文件还在、真用时被拒,#6264)——
   * 界面说「重新登录」而不是「登录」。旧版机器端不报 = 缺席 = 当作普通的没登录。
   */
  harnessAuthExpired?: boolean;
};

/** 一家 harness 在某台机器上的登录读数:登了 / 没登 / 判不出(维持原行为)。 */
export type SessionpageAgentAuthState = 'signed-in' | 'signed-out' | 'unknown';

/**
 * `guguReason` 的这一句 = 咕咕平台**本来就没有**这家 agent 能用的模型(合法的空,不是故障)。
 * 本机创建框遇到这种情况什么都不说、只是不出咕咕那一组;远端创建框据这句认出它,❌ 把它当报错铺出来
 * (#6264 owner 反馈:「使用远程时它提示我一个报错:咕咕平台目前没有这家 agent 能用的模型」)。
 */
export const GUGU_CATALOG_EMPTY_REASON = '咕咕平台目前没有这家 agent 能用的模型';

/**
 * 咕咕那一组缺席的**原因码**(`catalogError` / `guguReason` 里装的东西)。宿主只报码,各端按界面语言说人话;
 * 失败原文只进宿主日志。❌ 往这两格塞 `error.message`:服务端一句 `model access server is not configured`
 * 就原样铺进了新建任务的工具栏(#6264 真机)。空组那一句沿用 `GUGU_CATALOG_EMPTY_REASON`(老桌面按它认)。
 */
export type GuguCatalogReason =
  | 'not-routable'
  | 'no-identity-chat'
  | 'no-identity-terminal'
  | 'runtime-not-connected'
  | 'host-not-ready'
  | 'none-for-agent'
  | 'signed-out'
  /** 咕咕这边出错了(服务端 5xx / bad_request / 表外的原因,本机内部故障):原文只进日志(#7103)。 */
  | 'service-unavailable'
  | 'unreachable'
  /** 这个咕咕模型要开会员才能用(网关签票回 `membership_required`,#7092):说的是模型,❌「任务没能启动」。 */
  | 'membership-required'
  /** 选的咕咕模型下架了、或网关一条渠道都不卖它(服务端 `model_unavailable`,#7103):换个模型。 */
  | 'model-unavailable'
  /** 认不出的串(老版本宿主送来的原文):与 `service-unavailable` 同一句,❌ 原样显示。 */
  | 'unknown';

const GUGU_CATALOG_REASON_PREFIX = 'gugu-models:';

export function guguCatalogReasonCode(reason: Exclude<GuguCatalogReason, 'unknown' | 'none-for-agent'>): string {
  return `${GUGU_CATALOG_REASON_PREFIX}${reason}`;
}

/** 老版本宿主报的中文定性原话 → 码(它们在界面上本来就说得通,只是不能翻译)。 */
const LEGACY_GUGU_CATALOG_REASONS: ReadonlyArray<[string, GuguCatalogReason]> = [
  [GUGU_CATALOG_EMPTY_REASON, 'none-for-agent'],
  ['咕咕模型尚未对这个 Agent 开通', 'not-routable'],
  ['咕咕模型在 Chat UI 会话里还用不了', 'no-identity-chat'],
  ['咕咕模型在终端会话里还用不了', 'no-identity-terminal'],
  ['Agent 运行时尚未连接', 'runtime-not-connected'],
  ['咕咕模型目录还没接上(宿主未就绪)', 'host-not-ready'],
];

const GUGU_CATALOG_REASONS = new Set<GuguCatalogReason>([
  'not-routable', 'no-identity-chat', 'no-identity-terminal', 'runtime-not-connected', 'host-not-ready',
  'none-for-agent', 'signed-out', 'service-unavailable', 'unreachable', 'membership-required', 'model-unavailable',
]);

/** 读一格 `catalogError` / `guguReason`:null = 没有要说的;其余一定落在某个码上。 */
export function guguCatalogReasonKind(raw: string | null | undefined): GuguCatalogReason | null {
  const text = raw?.trim();
  if (!text) return null;
  if (text.startsWith(GUGU_CATALOG_REASON_PREFIX)) {
    const kind = text.slice(GUGU_CATALOG_REASON_PREFIX.length) as GuguCatalogReason;
    return GUGU_CATALOG_REASONS.has(kind) ? kind : 'unknown';
  }
  return LEGACY_GUGU_CATALOG_REASONS.find(([sentence]) => sentence === text)?.[1] ?? 'unknown';
}

/** 一个不带前缀的原因(转录里「回合失败」那一格的 `guguReason`,#7103)→ 认得的原因;认不出 ⇒ `unknown`。 */
export function guguReasonOf(kind: string): GuguCatalogReason {
  return GUGU_CATALOG_REASONS.has(kind as GuguCatalogReason) ? (kind as GuguCatalogReason) : 'unknown';
}

/**
 * 启动失败的原文里带没带原因码(签平台额度失败时宿主只抛码,见 `platformAccessStartError`)。
 * 失败穿过 ACP 运行时进程时只剩一段文字(前后可能被包上 `Error invoking …`),所以按子串找。
 */
export function guguReasonInText(text: string | null | undefined): GuguCatalogReason | null {
  const match = text?.match(/gugu-models:([a-z-]+)/);
  if (!match) return null;
  const kind = match[1] as GuguCatalogReason;
  return GUGU_CATALOG_REASONS.has(kind) ? kind : null;
}

export type SessionpageSessionCreateRequest = {
  /** 支持持久创建重试的宿主使用同一个请求 id，避免回复丢失后重复建身份。 */
  clientRequestId?: string;
  /** 可选的预设名字；不提供时由宿主命名。 */
  title?: string;
  /**
   * 建在哪个项目下。与 `projectPath` 二选一:给了 id 就用那台机器上已有的项目;
   * 只给 `projectPath` = 那台机器上的一个目录,没登记过就当场登记成项目(与远端建 agent 同一条规则,
   * #6264「会话页里的别的机器」:新建时选了哪台机器、哪个文件夹,会话就归到那台机器的那个项目下)。
   */
  projectId?: string;
  /** 那台机器上的目录(绝对路径或 `~` 开头);空串 = 那台机器的隐式任务工作区。 */
  projectPath?: string;
  /** provider id（`claude` / `codex` / …），取自 `sessionCreateOptions` 报的那一份。 */
  harness: string;
  /**
   * 选中的模型 id，取自 `sessionCreateModels` 报的那一份（`platform:` 前缀 = 咕咕平台模型）。
   * 不给 = harness 自己的默认。机器端按 spawn 同一套规则解释，❌ 平台 id 不在目录里不会降级成 BYOK。
   */
  model?: string;
  /** 第一句话。空的不建 —— 一条没有开场白的会话建出来就是个空壳。 */
  prompt: string;
  /** 展示;不给 = 那台电脑按自己的「终端」开关定(开 → 编程,关 → 通用),这家不给那种就取它给的第一种。给了须在 `sessionViews` 里。 */
  sessionView?: SessionpageSessionView;
  /** 咕咕权限档;不给 = 这家的默认。须在该 harness 的 `permissionModes` 里。 */
  permissionMode?: SessionpagePermissionMode;
  /** 推理档 id,取自 `sessionCreateModels.efforts`;不给 = 引擎默认。 */
  effort?: string;
  /** 生在哪个群里(群成员里「新建 Agent」):它的身份第一次建出来时进这个群,群规照常生效。老宿主不认这一格。 */
  chatId?: string;
  /**
   * 派任务(gugu-dev#181):第一句由那台机器落成这个对话里的一张任务卡,agent 进群坐任务座位(与 `chatId` 同给)。
   * 老宿主不认这一格。
   */
  taskChatId?: string;
  /** 在项目的哪个文件夹里开工(那台机器上的绝对路径或 `~` 开头),须是这个项目的文件夹;不给 = 项目根目录。老宿主不认这一格。 */
  cwd?: string;
};

/** 建成了：手机拿这两个 id 直接跳进新会话的时间线。 */
export type SessionpageSessionCreateResult = {
  conversationId: string;
  projectId: string;
  title: string;
  /** 手机宿主返回的真实入群结果；身份创建成功与入群成功分别表达。 */
  birthGroup?: { chatId: string; status: 'joined' | 'pending_approval' | 'failed'; error?: string } | null;
  /** 派任务时那张卡的消息 id(在 `taskChatId` 那个对话里)。老宿主不带这一格。 */
  taskMessageId?: string;
  /**
   * 会话行已经写下了,但 agent 没起来(原因码见 `remoteFailureKind`)。发起方照样进这条会话:
   * 第一句话在转录里,失败原因是其后的一行、可以再试一次 —— ❌ 留一条点不开的死行。老宿主不带这一格。
   */
  startFailure?: string;
  /** 这条会话此刻的摘要(与 `sessionsList` 同一个投影,读数由这台机器写):发起方拿它直接画页头。老宿主不带这一格。 */
  session?: SessionpageSessionSummary;
};

/**
 * 在别的机器上建会话 / 起会话失败时,给人看的是哪一类(#6264)。机器报的是原因码,
 * 各端按自己的界面语言把这一类说成人话(**原文只进日志**,❌ 摊给用户)。
 * 认不出的码一律归 `start-failed`:说「没开起来、再试一次」,而不是把机器那边的原文搬过来。
 */
export type RemoteFailureKind =
  /** 那台机器连不上咕咕的模型服务(选的是咕咕提供的模型)。 */
  | 'model-service-unreachable'
  /** 那台机器上的这家 agent 没登录。 */
  | 'agent-signed-out'
  | 'agent-install-failed'
  | 'agent-runtime-missing'
  | 'agent-not-found'
  /** 选的模型在那台机器上用不了。 */
  | 'model-unavailable'
  /** 选的展示 / 权限档这家不支持。 */
  | 'option-rejected'
  | 'folder-unavailable'
  | 'attachment-missing'
  /** 问不到那台机器(离线、没回话)。 */
  | 'machine-unreachable'
  /** #6264 远程 SSH 的机器:要先在这台电脑上登录它(SSH 密码 / 口令 / 新主机指纹)。 */
  | 'machine-sign-in-required'
  /** #6264 那台机器上的咕咕 server 太旧,还不认这台电脑的连法(空闲时会自动升级)。 */
  | 'machine-outdated'
  | 'start-failed';

const REMOTE_FAILURE_KIND_BY_CODE: Readonly<Record<string, RemoteFailureKind>> = {
  platform_model_unreachable: 'model-service-unreachable',
  agent_signed_out: 'agent-signed-out',
  harness_install_failed: 'agent-install-failed',
  harness_runtime_missing: 'agent-runtime-missing',
  harness_not_found: 'agent-not-found',
  model_rejected: 'model-unavailable',
  session_view_rejected: 'option-rejected',
  permission_mode_rejected: 'option-rejected',
  project_not_found: 'folder-unavailable',
  project_open_failed: 'folder-unavailable',
  project_not_open: 'folder-unavailable',
  attachment_missing: 'attachment-missing',
  attachment_incomplete: 'attachment-missing',
  invalid_attachment: 'attachment-missing',
  device_offline: 'machine-unreachable',
  timeout: 'machine-unreachable',
  // #6264 远程 SSH 的设备连接(src/lib/sshLink.ts 的 SSH_LINK_ERROR_CODE)。
  ssh_unreachable: 'machine-unreachable',
  ssh_unmapped: 'machine-unreachable',
  ssh_not_signed_in: 'machine-unreachable',
  ssh_not_installed: 'machine-unreachable',
  ssh_sign_in_required: 'machine-sign-in-required',
  ssh_host_key_changed: 'machine-sign-in-required',
  server_outdated: 'machine-outdated',
};

/** `code` 为 null = 没有业务码(传输层失败:超时、频道没开起来)⇒ 问不到那台机器。 */
export function remoteFailureKind(code: string | null | undefined): RemoteFailureKind {
  if (!code) return 'machine-unreachable';
  return REMOTE_FAILURE_KIND_BY_CODE[code] ?? 'start-failed';
}

export type SessionpageSessionsListResult = {
  projects: SessionpageProjectSummary[];
  sessions: SessionpageSessionSummary[];
};

/**
 * `trim`:要「过长的工具内容裁掉」的那一份(`transport-trim`)。手机给;桌面不给,一个字都不裁 ——
 * 「桌面看完整」靠的就是这一格只由调用方决定。
 */
export type SessionpageSessionSnapshotRequest = { conversationId: string; limit?: number; trim?: boolean };
export type SessionpageSessionAfterRequest = { conversationId: string; cursor: RecordCursor; trim?: boolean };
export type SessionpageSessionOlderRequest = { conversationId: string; beforeTurnId: string; limit?: number; trim?: boolean };
/**
 * 手机点开一张附件卡(#7193):agent 用 `session_open_in_tab` 打开给人看的那份文件,从那台机器上按块现读
 * (不经云,与时间线同一条线)。只读这条会话**真的打开过**的文件 —— 机器拿它自己的记录核对。
 */
export type SessionpageOpenedFileReadRequest = { conversationId: string; path: string; offset: number; length: number };
/** 读到的一段。`etag` 在文件被改时变:几段对不上 = 读的时候文件变了。`data` 是 base64。 */
export type SessionpageOpenedFileChunk = { size: number; etag: string; data: string };
/** 手机一次看的文件最多这么大:附件卡指的是给人看的汇报、网页、文档,不是任意大文件。 */
export const OPENED_FILE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 手机取一张工具交回来的图。发给手机的那一份里图只有类型和字数(`imageRefs`,transport-trim),图本身等它滚进
 * 视口、那一轮展开了再按 (会话, 条目, 第几张) 来取。`itemId` 是时间线里工具条目的 id(工具组里的子调用也认)。
 */
export type SessionpageSessionToolImageRequest = { conversationId: string; itemId: string; index: number };

/**
 * 手机取一张工具交回来的图时,宿主答的上限(base64 字数)。超过就回 `too_large`,手机说「在桌面上看」。
 *
 * 依据:这一问走一问一答的设备 RPC(mobile/agent-watch/sessionpage-rpc.ts 的 `once`),回包是**一条**广播、不拆片,
 * 手机等 12 秒。一条广播的上限是库的 Realtime 单包上限 3000KB:共享测试库 2026-10-15 实测,单条 2.9M 字到、3.2M 字
 * 被拒。1M 字留出三倍余量;慢网(约 1 Mbps)上约 8 秒到齐,还在 12 秒里。app_check 交回的图最大约 0.5M 字(噪点页
 * 实测 512K/张)。手机手里有每张图的字数(`imageRefs`),超过的不去问。
 */
export const TOOL_IMAGE_FETCH_LIMIT = 1_048_576;
export type SessionpageSessionSubscribeRequest = {
  conversationId: string;
  subscriptionId: string;
  cursor: RecordCursor | null;
  trim?: boolean;
};

/**
 * 消息预览(`taskpage.preview.*`,手机 / 别的电脑经设备 RPC 订)的保活周期与超时:订阅方每 `SUBSCRIPTION_KEEPALIVE_MS`
 * 报一次;机器端 `SUBSCRIPTION_IDLE_MS` 没收到就拆。会话页的订阅不用它:那些跟着 `taskhost` 窗口生灭。
 */
export const SUBSCRIPTION_KEEPALIVE_MS = 25_000;
export const SUBSCRIPTION_IDLE_MS = 90_000;

export type SessionpageSessionUnsubscribeRequest = { subscriptionId: string };
export type SessionpageSessionSendRequest = {
  conversationId: string;
  text: string;
};
/** 端上对一条结算的回答(会话 id 与回答者由调用方补上)。 */
export type SettlementResponse =
  /**
   * An App install's answer (D-31): `digest` — the manifest fingerprint of the sheet the person saw (an install answered
   * without it is refused: nobody saw what it may do). Who gets its tools is the install's own rule (InstallGrant), never
   * carried with the answer.
   */
  | { itemId: string; kind: 'permission' | 'question'; optionId: string; digest?: string }
  /** 终端选择器(结算带 `questions` 的提问):每题一个答案,题序与 `Settlement.questions` 一致。 */
  | { itemId: string; kind: 'question'; answers: readonly QuestionAnswer[] }
  | { itemId: string; kind: 'question'; decline: true };

export type SessionpageSessionRespondRequest = SettlementResponse & {
  conversationId: string;
  /** 回答者标识，进 Settlement.resolvedBy。 */
  by: string;
};

/**
 * 回答一个审批/提问项的**应答**。
 *
 * `accepted` 说的是**这一次点击**有没有生效：false = 已经被别人抢先答过了。
 * 两种情况都带回那条权威结算 —— 后答的一端要看到「已在某端回答」，而不是一句报错，
 * 而它要显示这句话就得拿到那条结算本身。
 *
 * ⚠️ 这个类型是 2026-09-05 补的，补之前**只声明了请求、没声明应答**：宿主回
 * `{ settlement }`，手机端却按 `{ ok, settlement | existing }` 解，于是取到 `undefined`
 * 当场把渲染层打崩（真机实测）。两边各写各的没人拦，是因为没有一个共同的类型。
 * 抢跑失败也走**正常应答**、不走错误码，同理：错误码这条路上两边的字符串也是错位的
 * （宿主 `already_settled` / 手机 `already_resolved`），而错位的字符串同样没人拦。
 */
export type SessionpageSessionRespondResult = {
  accepted: boolean;
  settlement: Settlement;
};

/** 一条时间线订阅的推送(事件 `session-timeline:push`,topic = subscriptionId)。 */
export type SessionpageSessionEvent = {
  subscriptionId: string;
  result: TimelineAfterResult;
};

/**
 * 整台机器的会话列表推送(事件 `session-list:push`,topic = subscriptionId)。
 *
 * 为什么推整份而不是「哪条变了」：列表本来就小（一台机器上的会话是十几条量级），
 * 推整份的收批人不需要做任何合并，也就不存在「合出一份与桌面不一致的列表」这种失败模式。
 */
/**
 * 会话列表订阅的推送(协议 8,只有这一种推法):订上那一刻一份整的(`full`),之后只推变了的行(`changed`,整行)与
 * 没了的会话(`removed`);项目表变了才带 `projects`。算法与合并见 `session-list-delta.ts`。
 */
export type SessionpageSessionsEvent =
  | { subscriptionId: string; full: SessionpageSessionsListResult }
  | {
      subscriptionId: string;
      changed: SessionpageSessionSummary[];
      removed: string[];
      projects?: SessionpageProjectSummary[];
    };

export * from './workspace-contract';

export * from './pane-contract';
