/**
 * ChatCommands and ScrollToItemOptions — host-injectable callback contracts.
 *
 * Extracted from index.tsx so that internal modules (chat-view, ChatRoot,
 * CommandsContext) can import these types without creating a circular
 * dependency through the package entry point.
 */

import type { ChatAttachment, OpenedOutput } from './model';

export type ChatViewCommandId = 'chat.scrollToTop' | 'chat.scrollToBottom';

export type ChatViewCommand = {
  id: ChatViewCommandId;
  label: string;
  defaultKeybinding?: string;
};

export const CHAT_VIEW_COMMANDS = [
  {
    id: 'chat.scrollToTop',
    label: 'Scroll to top',
    defaultKeybinding: 'Mod+ArrowUp',
  },
  {
    id: 'chat.scrollToBottom',
    label: 'Scroll to bottom',
    defaultKeybinding: 'Mod+ArrowDown',
  },
] as const satisfies readonly ChatViewCommand[];

/**
 * Typed callbacks that host apps inject to respond to user actions inside the
 * chat transcript. Pass via `createChatView({ commands })` or update later
 * via `view.setCommands(commands)`.
 */
export type ChatCommands = {
  canRevertMessage?: (itemId: string) => boolean;
  onEditMessage?: (arg: { itemId: string }) => void;
  /** Host-owned draft: virtual row reuse must not move it to another message. */
  editingMessage?: {
    itemId: string;
    text: string;
    pending: boolean;
    canSubmit: boolean;
    onChange: (text: string) => void;
    onCancel: () => void;
    onSubmit: () => void;
  };
  /**
   * Called when the user clicks a file path in a diff header, file-op row,
   * resource-link card, or inline prose link.
   */
  onOpenFile?: (arg: {
    path: string;
    itemId: string;
    source: 'diff' | 'file-op' | 'resource-link' | 'prose-link';
    /** The place in it a prose link names (`path#k=v&…`, `#L10`), as a group file's pill carries it (`classifyLink`). */
    at?: Record<string, string>;
  }) => void;

  /**
   * Called when the user clicks an attachment inside a user message bubble ——
   * 图片缩略图与文件 chip **同一个回调**,由宿主按 `attachment.kind` 决定怎么打开
   * (图 → 看图,文件 → 用它该用的方式打开)。❌ 别为文件另开一个口子:两种附件在产品里
   * 是同一件事,分成两个回调会让宿主两边各实现一次(#5269)。
   */
  onViewAttachment?: (arg: {
    attachment: ChatAttachment;
    itemId: string;
    source: 'user-message';
    /** 被点的那张缩略图(文件 chip 没有)。 */
    thumb?: HTMLElement;
  }) => void;

  /**
   * 点了工具卡上的一张缩略图:宿主用全 app 那一个看图器打开同一次调用交回来的**全部**图,从被点的这张起
   * (缩略图只摆前几张,「+N」后面那些靠左右滑到)。
   */
  onViewImages?: (arg: {
    /** 画图用的地址,按交回来的顺序。 */
    urls: string[];
    index: number;
    itemId: string;
    source: 'tool-result';
    /** 被点的那张缩略图:看图器从它放大进入。 */
    thumb?: HTMLElement;
  }) => void;

  /**
   * Resolve an attachment id to a displayable data URL. Used for committed
   * messages whose transcript stores attachment metadata but not bytes.
   */
  resolveAttachment?: (attachment: { id: string; name: string }) => Promise<string | null>;

  /**
   * Called when the user clicks the stop button on the current user message
   * while the agent is generating.
   *
   * ⚠️ 这个回调**同时是那个按钮的开关**：`UserMessageCard` 只在宿主注入了它的时候才渲染
   * 停止按钮。以前不是这样 —— 按钮只看 `turnStatus === 'generating'`，而唯一的产品宿主
   * （`acp-chat-panel.tsx` 的 `transcriptCommands`）从来没有注入过 `onStop`，
   * 于是 `commands().onStop?.(...)` 整条短路：**按下去什么都不会发生**，
   * 与 #3500 是同一个形状（`?.` 被当成了语法级 fallback）。
   * ⇒ 现在「没接回调」在结构上等于「不渲染控件」，符合本仓「要么真生效，要么不渲染」。
   */
  onStop?: (arg: { itemId: string }) => void;

  /**
   * Called when the user clicks the "取回指令 / Restore prompt" action on a settled
   * turn-outcome row (`error` / `cancelled`). `text` is that turn's original user
   * prompt; the host is expected to put it back into the composer **unsent**.
   *
   * # ⚠️ 这**不是** retry，也**不是** continue —— 名字必须说实话
   *
   * 上游 `elements-error-state` 的 retry 在本仓后端**不存在**（协议里没有 rewind / truncate，
   * 证据链见 `turn-outcome.def.tsx` 顶部）。所以这个回调的语义被刻意收窄成一件**能被证实**的事：
   * **把那条指令还给输入框**。要不要真的再跑一次，由用户看过之后自己按发送 ——
   * 副作用的风险归判断得了它的那个人。
   *
   * ⚠️ 上游 stopped-run 的 continue 则是**另一回事，且它是能做的** —— 见下面的 `onContinueTurn`。
   * 本注释此前把 retry 与 continue 并列说成「都不存在」，那句话是**错的**：它把「原样续写被切断的
   * 那半句」（= rewind，确实没有）与「在同一个活着的会话里接着往下跑」（= 再发一条指令，一直都有）
   * 混成了一件事。两者的区别在下面那条回调里逐句写明。
   *
   * ⇒ 宿主实现里 ❌ 不许把它接成 `sendPrompt`。接成发送就是把「取回」偷换成「重发」，
   * 那正是这张票拒绝交付的那个会骗人的按钮。
   *
   * 与 `onStop` 一样，这个回调是控件的开关：宿主不注入 ⇒ 那一行不渲染任何按钮。
   */
  onRestorePrompt?: (arg: { itemId: string; text: string; source: 'turn-outcome' }) => void;

  /**
   * 用户在**被停止**的收尾行上按了「继续」（上游 `elements-stopped-run` 的 Continue）。
   * 宿主应当**向同一个还活着的会话再发一条指令**，让 agent 接着往下跑。
   *
   * # 为什么这个能接，而 `onRestorePrompt` 明令不许接成发送
   *
   * 两件事的差别不在「发不发」，在**发的是哪一条、发进哪个上下文**：
   * - `onRestorePrompt` 是把**出错那一轮的原指令**重新发一遍。那一轮抛出来之前 agent 可能
   *   已经写过文件、调过工具，而协议里没有 rewind ⇒ 再发一次是在一段**已经含着那次失败与
   *   它的副作用**的上下文后面追加第二条同样的指令。**重发不是重试**，所以那条至今不许接。
   * - 这个回调发的是一条**新的、意思是「接着往下」的指令**，而 `cancel` 之后会话是活的、
   *   上下文里带着刚才那半截输出 ⇒ agent 读到的是「你写到一半被打断了，继续」。
   *   它不假装能原样续写那半句话（那是 rewind，协议里依然没有），它做的就是它说的那件事。
   *
   * ⚠️ 参照上游：`aui.message.reload()` 同样**不恢复**被切断的文本，官方文档原话是
   * “Restarts generation; it does not resume the cut-off text.” ⇒ 「继续 = 在同一轮上重新起跑」
   * 是上游自己的语义，不是本仓的降级。本仓这条因为发进活会话，实际比 reload 更接近字面的「继续」。
   *
   * 与 `onStop` / `onRestorePrompt` 一样，这个回调**同时是控件的开关**：宿主不注入就不渲染按钮。
   * 只有 `cancelled` 那一支会渲染它 —— 失败 / 中断没有「接着往下」这回事。
   */
  onContinueTurn?: (arg: { itemId: string; source: 'turn-outcome' }) => void;

  /**
   * 计划审批卡（#7139）上点了一个选项：宿主用会话自己的 `requestId` / `optionId` 答那条待批请求
   * —— 与输入框上那条审批答的是同一个请求、同一个动作。宿主不注入 ⇒ 卡上的选项置灰（卡照画，答不了）。
   */
  onResolvePermission?: (arg: { requestId: string; optionId: string; source: 'plan-review' }) => void;

  /**
   * #7103 这一轮是咕咕拒的(`outcome.guguReason`,取票没签出来):宿主按它自己的原因表说那一句、给那一个按钮
   * (与起任务那一页同一张表),❌ 在这个包里另抄一份。给了按钮就不再摆「取回指令」—— 一句话一个按钮。
   * 宿主不注入 ⇒ 那一行照常说「回合未能完成」。
   */
  describeRefusal?: (guguReason: string) => { text: string; action?: { label: string; run: () => void } };

  /**
   * Synchronously classify an `href` from a rendered markdown link.
   * Returns `{ kind: 'workspace-file'; path: string; at? }` for workspace files (`at` the place its `#…` names),
   * `{ kind: 'group-file'; itemId, at? }` for a file of a group (`gugu-file://…`, opened by `onOpenGroupFile`; `at` the place a pill points at),
   * or `{ kind: 'external' }` to keep the default external-link behavior.
   */
  classifyLink?: (
    href: string,
  ) => { kind: 'workspace-file'; path: string; at?: Record<string, string> } | { kind: 'group-file'; itemId: string; at?: Record<string, string> } | { kind: 'conversation'; href: string } | { kind: 'external' };

  onOpenConversationLink?: (href: string) => void;

  /**
   * User clicked a link to a file of a group (`gugu-file://<itemId>`), or a pill pointing at one: the host opens it in
   * the group it is in, at the place the pill points at (`at`).
   */
  onOpenGroupFile?: (arg: { itemId: string; at?: Record<string, string> }) => void;

  /**
   * 点了一张附件卡(#7193):agent 用 `session_open_in_tab` 打开过的那份文件 / 网页。宿主重新打开它 ——
   * 桌面与对话顶部「输出」里点那一条同一个动作。不接 = 卡片只看不点。
   */
  onOpenOutput?: (arg: { output: OpenedOutput; itemId: string }) => void;

  /**
   * 这一份在这一端打不开时,卡上说为什么(手机上那台电脑的 localhost 网页:手机够不着)。
   * 返回 null = 打得开。不接 = 都打得开。打不开的卡只看不点,❌ 摆一枚点了没反应的「打开」。
   */
  outputUnavailable?: (output: OpenedOutput) => string | null;

  /**
   * 附件卡右边「打开方式」那枚(「Open in ▾」):`label` 是点整行时的打开方式(桌面「侧边栏」、
   * 手机「预览」),写在下拉钮上;点它宿主在 `anchor` 旁边弹出全部打开方式(owner 10-15:「应该是以什么方式打开,
   * 默认是打开在侧边栏」)。不接 = 没有这枚下拉。
   */
  outputOpenMode?: (output: OpenedOutput) => string | null;
  onOutputMenu?: (arg: { output: OpenedOutput; itemId: string; anchor: HTMLElement }) => void;

  /**
   * Called when the user clicks a Mermaid diagram block preview.
   */
  onViewMermaid?: (arg: { chart: string; blockId: string; source: 'mermaid-block' }) => void;

  /**
   * Called when the user clicks a resolved @-mention chip in the transcript.
   * `id` is the stable identifier (e.g. a file path); `label` is the raw @-token text.
   */
  onClickMention?: (arg: {
    id: string;
    label: string;
    kind: 'file' | 'issue' | 'symbol' | 'custom';
    itemId: string;
    source: 'prose-mention';
  }) => void;
};

export type ScrollToItemOptions = {
  /** Where to align the row within the viewport. Default: 'start'. */
  align?: 'start' | 'center' | 'end';
  /** Additional pixel offset applied after alignment. Default: 0. */
  offset?: number;
  /** Native scroll behavior. Default: 'auto'. */
  behavior?: ScrollBehavior;
};
