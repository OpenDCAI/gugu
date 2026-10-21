/**
 * ChatComposer 的**数据形状**——宿主传进来的那几张清单，以及内部派生出的条目类型。
 *
 * 从 `index.tsx` 拆出来的一刀（#4981 A1）。拆的理由不是「文件太长」这种审美：
 * `index.tsx` 在 `scripts/im-architecture-migration-gate.json` 的 `migrationProduction`
 * 逐文件名单里（**按精确路径**匹配），该类别有净增行数上限；本目录下的新文件不在名单、
 * 也不在 `imProductionPrefixes` 下，落进无上限的类别。⇒ 往 `index.tsx` 里继续堆代码会
 * 顶爆预算，把这些**本来就与渲染无关**的东西搬出来是唯一不撞闸的顺序。
 *
 * 只放类型：一行运行时代码都没有，所以谁 import 它都不会拖进 React 或样式。
 * 公开 API 仍由 `index.tsx` 统一 re-export —— 外部调用点一个都不用改。
 */
import type { ReactNode } from 'react';

// ── Notice ────────────────────────────────────────────────────────────────────

export type ComposerNoticeVariant = 'error' | 'warning' | 'info';

export interface ComposerNotice {
  variant: ComposerNoticeVariant;
  title?: string;
  message: string;
  /** When provided, renders a dismiss button. */
  onDismiss?: () => void;
}

// ── Attachment ────────────────────────────────────────────────────────────────

export interface ComposerAttachment {
  id: string;
  name: string;
  /** Absolute or relative path — populated by the host for file-kind attachments. */
  path?: string;
  kind: 'image' | 'file';
  /**
   * Image source for the preview `<img>`. A `data:` URL for dropped images
   * (so the bytes can be forwarded to the agent); needs no `revokeObjectURL`.
   */
  previewUrl?: string;
  /** MIME type of the image (e.g. `image/png`) — used when sending to the agent. */
  mimeType?: string;
  /**
   * 文本类附件的内容,宿主**入列时**读进来(见 `readAttachmentPreviewText`)。有它 chip 才点得开
   * ——预览要看的东西必须已经在手上,❌ 不要点开之后再去磁盘上找(那条路上有找不到的一格,
   * 而用户看到的会是一个空对话框)。
   */
  previewText?: string;
  /** `previewText` 只是文件的前一段。对话框据此挂一行说明。 */
  previewTruncated?: boolean;
  /**
   * chip 的三态(照 assistant-ui `ComposerAttachment.state`,#5269):`uploading` 转圈 + 底边进度条、
   * `done` 显 × / ✓、`error` 把 meta 变红。缺省按 `done` 算 —— 既有调用点都是上传完才入列。
   */
  state?: ComposerAttachmentState;
  /** 0–100,只在 `uploading` 时画进度条;宿主拿不到进度就别给,条不画。 */
  progress?: number;
  /** 名字下面那行:大小 / 百分比 / 错误原因。不给就只有一行名字。 */
  meta?: string;
  /**
   * `uploading` 时也给 ×(宿主接了移除):去掉它 = 取消这次传输并清掉已传的部分。
   * 缺省不给 —— 既有上传是整件一次性的,中途没有可取消的东西。
   */
  cancelable?: boolean;
  /** `error` 时 meta 后面跟一段「重试」(宿主接了 `onRetryAttachment`)。失败原因不会自己好的(如文件太大)就别给。 */
  retryable?: boolean;
}

export type ComposerAttachmentState = 'uploading' | 'done' | 'error';

// ── Model option types ────────────────────────────────────────────────────────

/** Minimal model descriptor the composer needs to render the model selector. */
export interface ComposerModelOption {
  name: string;
  /**
   * Compact label for the trigger and the settings panel's 「模型」row, where the full name
   * would crowd out the effort level beside it. Falls back to `name` when absent — the host
   * declares it per model rather than the composer deriving it, since no prefix rule works
   * across every provider.
   */
  shortName?: string;
  /** 一句话说明。桌面清单的行里不画,进悬浮详情卡;手机清单(没有悬停)画在第二行。 */
  description?: string;
  /** 悬浮详情卡里的事实行(宿主翻好的「标签 → 值」,如 推理档 → 低 · 高),排在上下文窗口之后。 */
  facts?: readonly ComposerModelFact[];
  /** Optional capability metadata shown in the hover card detail. */
  modelFeatures?: {
    contextWindowSize?: number;
    speed?: number;
    intelligence?: number;
  };
  /**
   * 宿主渲染的**厂商图标**(上游 `ModelOption.icon` 的对位物)。
   * 这个包够不到 app 的图片资源,与 `ComposerAgentOption.icon` 同一条路:宿主给成品节点。
   */
  icon?: ReactNode;
  /**
   * **一级分类 = 这条是谁的**(「你的 Codex 模型」/「咕咕提供的模型 · 按积分计费」)。
   * 相邻且同名的条目归到一个小标题下。
   *
   * owner 2026-09-06 定的层次:一级是「谁的」,厂商是二级。理由在产品上:用户先要决定的是
   * **这次调用记在谁账上**(花不花积分、凭据归谁管),厂商是在那之后才挑的。
   * ⚠️ 第一版把两者做反了(厂商当组头、来源当副标题),owner 原话「你这个分类层次反了」。
   *
   * 不设 = 这条不属于任何分组,平铺在列表里。宿主自己决定怎么分组,composer 不从 id 猜。
   */
  groupLabel?: string;
  /**
   * **二级 = 厂商**(OpenAI / Anthropic / 智谱 …)。它**不做分组**,只做两件事:
   * 面板顶部那排**筛选**药丸,以及行内那枚 logo 的可读名。
   *
   * ⚠️ ❌ 别把它升成组头 —— 厂商横切在两档之上(同一家可以既有你自己的、又有咕咕代付的),
   * 把它做成分组会把「谁的」这条更要紧的界线切碎。
   */
  providerLabel?: string;
  /**
   * 这一条**看得见但选不了**,以及为什么。
   *
   * owner 2026-09-07 定的过渡态:「原则上讲,一个 session 的模型和思考强度都是应该可以改的,
   * 但当前的技术方案限制了这一点。我们后续会实现技术突破来支持它,只是突破没那么快,
   * 所以现阶段先用置灰方案来兼顾 UI 一致性」。
   *
   * ⚠️ `disabledReason` **不是可选的装饰**:owner 2026-08-21 定过「选不了的那一头要留在原地
   * 并说明原因」。只置灰不给原因 = 用户看见一块灰的、无处可问 —— 那才是仓规里说的假控件。
   * 判据钉在 `composer-disabled-options.test.tsx`:置灰的行必须带 title,且点它不发变更。
   * ❌ 别用 `disabled` 来表达「这一条不该出现」—— 那种情况是**不渲染**,不是置灰。
   */
  disabled?: boolean;
  disabledReason?: string;
}

/**
 * 模型清单**里**的一条「去登录」—— 渐进披露(owner 2026-08-28 定稿)。
 *
 * ## 它为什么长这样
 *
 * 用咕咕自己的模型**不需要**登录任何一家。所以「去登录」这件事在用户打开任务、
 * 在底排扫一眼的那一刻是**噪音**:它跟他当下要做的事无关。等他点开模型清单、
 * 正在挑模型时,「登录以使用 X 自家的模型」才第一次成为一条相关的信息 ——
 * 而且它就在他的视线里,不用回头去别处找。
 *
 * ## 与旧实现的两处不同(❌ 别照旧版推理)
 *
 *  · 旧版是「一个模型都拿不到时**顶掉**模型那一行」。它几乎**永远不出现** ——
 *    咕咕自家的模型一直在,清单从来不空。写的是空态,而空态不存在。
 *  · 旧版另有一条右下角 toast(「X 未登录」)。它离模型选择器隔了大半屏、会自己消失,
 *    消失之后那条登录的路就没了。已随本刀一并去掉。
 *
 * ⚠️ 它是清单里的一条,但**不是**一个可选取值:选它不会变成「当前模型」,
 *    所以渲染成 `Item` 而不是 `RadioItem`(见渲染处)。
 */
export interface ComposerModelUnlock {
  /** 这一组的组头,与「咕咕提供的模型」对仗 —— 如「Kimi 自家模型」。 */
  groupLabel: string;
  /** 那一条的文案,如「登录以使用 Kimi 模型」。 */
  label: string;
  /** 悬停提示 —— 说清点下去会发生什么,别让一条菜单项自己去猜。 */
  title?: string;
}

/** 悬浮详情卡里的一行事实。 */
export interface ComposerModelFact {
  label: string;
  value: string;
}

/**
 * 清单底部那一条「升级解锁更多模型」(#7056,免费档才有)。
 * 这一档用不了的模型**不进清单**(列出来点了才说要会员「像是埋雷」,owner 2026-10-10);
 * 它们只在这里露一次面:悬停这一条看得到是哪几个,点它去开会员。
 */
export interface ComposerModelUpgrade {
  /** 那一条的文案,如「升级解锁更多模型」。 */
  label: string;
  /** 悬浮卡的标题,如「开通会员后可用」。 */
  title: string;
  /** 开会员后能用的模型名。 */
  models: readonly string[];
}

/** 内部条目：`modelOptions` 那张表摊平成数组后的一行。 */
export interface ComposerModelItem {
  id: string;
  name: string;
  shortName?: string;
  description?: string;
  facts?: readonly ComposerModelFact[];
  icon?: ReactNode;
  modelFeatures?: ComposerModelOption['modelFeatures'];
  groupLabel?: string;
  providerLabel?: string;
  /** 见 `ComposerModelOption` 上同名字段。 */
  disabled?: boolean;
  disabledReason?: string;
}

/**
 * 模型列表里的一段。`label` 是**一级分类**(这条是谁的),空串 = 不属于任何分组、平铺渲染。
 *
 * ⚠️ 厂商**不参与切段**:它横切在两档之上(同一家可以两档都有),做成分组会把「谁的」
 * 这条更要紧的界线切碎。厂商只出现在筛选药丸和行内 logo 上。
 */
export interface ComposerModelGroup {
  label: string;
  items: ComposerModelItem[];
}

// ── Effort option types ───────────────────────────────────────────────────────

/** Minimal effort/thought-level descriptor the composer needs to render the effort submenu. */
export interface ComposerEffortOption {
  name: string;
  description?: string;
  /** 见 `ComposerModelOption` 上同名字段。 */
  disabled?: boolean;
  disabledReason?: string;
}

/** 内部条目：`effortOptions` 那张表摊平成数组后的一行。 */
export interface ComposerEffortItem {
  id: string;
  name: string;
  description?: string;
  /** 见 `ComposerModelOption` 上同名字段。 */
  disabled?: boolean;
  disabledReason?: string;
}

// ── Permission mode option types ──────────────────────────────────────────────

/** Minimal mode descriptor the composer needs to render the permission-mode selector. */
export interface ComposerPermissionModeOption {
  name: string;
  description?: string;
  /**
   * Marks a mode that lets the agent act without asking (bypass / full-access / yolo).
   * The trigger then renders in warning color with an alert icon instead of the neutral
   * shield, so an armed high-risk mode is catchable in peripheral vision. Callers decide
   * which ids qualify — the composer does not guess from the id.
   */
  destructive?: boolean;
}

/** 内部条目：`permissionModeOptions` 那张表摊平成数组后的一行。 */
export interface ComposerPermissionModeItem {
  id: string;
  name: string;
  description?: string;
  destructive?: boolean;
}

// ── Agent option types ────────────────────────────────────────────────────────

/** Minimal agent descriptor the composer needs to render the agent selector. */
export interface ComposerAgentOption {
  id: string;
  name: string;
  /**
   * Host-rendered icon — the app's AgentIcon is theme/registry aware, which
   * this package can't reach. Shown in the trigger and each list row.
   */
  icon?: ReactNode;
  description?: string;
  /** 彻底不可用、连动作都没有的行。没装的 agent **不属于**这一类:它们有 `action`。 */
  disabled?: boolean;
  /**
   * 分组表头,如「已安装」/「尚未安装」。@@@task-fusion (#2802) — 按安装状态分组,由组头
   * 一次性说清,而不是给每一行挂重复的标签(34 个 agent 里 32 个没装,重复 32 遍是噪声)。
   */
  groupLabel?: string;
  /**
   * 名字后面常驻的发布阶段标(目前只有「Beta」,#6335)。宿主按 owner 的 Beta 名单填,
   * 本包只管画 —— ❌ 不在这里判断哪家是 Beta。省略 = 不画。
   */
  badge?: string;
  /**
   * 这一行的动作(目前只有「安装」)。有 action 的行点下去走 `onAgentAction`,**不**变成当前
   * 选中的 agent,弹层也不关 —— 没装的 agent 从前是个死行(点了什么都不发生,或者选中后在
   * 会话启动时才炸),owner 要的是「点它带我去装」。
   */
  action?: {
    label: string;
    busy?: boolean;
    busyLabel?: string;
  };
}
