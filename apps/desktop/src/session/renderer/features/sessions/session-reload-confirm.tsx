import { ConfirmationDialog } from '@gugu/session-ui/react/components';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/**
 * 「这条会话要重开」的确认框 —— 换模型、切 MCP 开关、重启本会话、换一种展示重开共用。
 *
 * ## 为什么是一个组件而不是各写一个
 *
 * 用户被打断的**代价**在三处是同一件事:会话重开、正在跑的那一轮被打断。
 * 各写一份的话,措辞必然漂,而漂的方向不是文风问题 —— 是其中一处漏掉「正在跑的那一轮
 * 会被打断」,于是用户在一次长回合中途点了确认。⇒ 代价那句话只有一处定义。
 *
 * ## 形状:**理由用枚举,❌ 不收自由文本**
 *
 * `reason` 只决定标题(换成 X / 应用 Y / 重启本会话 / 切换为某种展示)。收 `note?: string` 会把措辞的
 * 所有权交回调用方 —— 那就等于没抽这个组件:两条车道又各写各的,而且下一个人无从知道该写什么。
 *
 * (曾经还有一个「额外后果」枚举,唯一的值是 claude 关一台 = 咕咕接管整份 MCP 清单。那条 strict 机制
 * 10-07 换成了 claude 自己的 `disallowedTools`,只摘被关的那台,这句后果连同枚举一起删了。)
 */
export type SessionReloadReason = 'model-switch' | 'mcp-toggle' | 'manual' | 'view-switch';

/**
 * @@@history-not-replayed 已撤(2026-09-07)—— 记着它为什么错,免得下一个人照原样加回来。
 *
 * 曾经在**跨计费路**换模型时事前断言「历史不会被重放」。那句话有读数支撑,但**读数的可见域被我放大了**:
 * 它测的是**隔离栈上的 codex**(那一家 rollout 落在 `CODEX_HOME`,换计费路确实换了家),
 * 而我把它写成了对**所有 provider** 成立。
 *
 * owner 2026-09-07 在产品里实测:换模型、换 provider 之后 **agent 照样记得这条会话** ——
 * rollout 是按 **agent home(按 provider 取)**落盘的,不按计费路取;claude 那家因此照样 load 得回来。
 *
 * ⇒ 事前把一个**只在某些家成立**的损失说成确定,会让用户躲开一个其实安全的动作 —— 比不提示更坏。
 * ⇒ 历史真的没能续上时，宿主会拒绝重启并保留原 conversation。
 *   那条是事后的,但**它只在真的发生时才出现**。⇒ 留准的,删不准的。
 * ⇒ 要把它加回来,先按 **provider 逐家**量一遍,并把可见域写进类型名或注释里。
 */

export interface SessionReloadConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reason: SessionReloadReason;
  /** 标题里那半句的宾语:换到哪个模型 / 改了哪几个开关(如「关掉 2 台」)。 */
  target: string;
  /** 重开进行中 —— 两个按钮都禁用,标题换成「正在重连…」。 */
  isReloading?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
}

/**
 * 确认钮说的是**用户这一下会发生什么**:打断正在跑的那一轮 + 他要的那个动作。
 * ⚠️ owner 2026-09-23:原来的「重开并继续」会被读成「要重开一个新会话吗」,于是不敢点 ——
 * 实际上对话是接着的。❌ 别在按钮和标题里再用「重开」这个词。
 */
const ACTION_KEYS = {
  'model-switch': 'chat.reloadConfirmActionSwitch',
  'view-switch': 'chat.reloadConfirmActionSwitch',
  'mcp-toggle': 'chat.reloadConfirmActionApply',
  manual: 'chat.reloadConfirmActionRestart',
} as const satisfies Record<SessionReloadReason, string>;

export function SessionReloadConfirm({
  open,
  onOpenChange,
  reason,
  target,
  isReloading = false,
  onConfirm,
  onCancel,
}: SessionReloadConfirmProps) {
  const { translate } = useSessionMessages();
  // `manual` 与 `view-switch` 的标题**就是那个动作自己的名字**(「重启本会话」/「切换为通用模式」),
  // 所以前者不看 target、后者直接用 target:菜单上写什么,确认框抬头就是什么,用户不必在两句
  // 不同措辞之间自己对上号。另外两种是「把 X 换成 Y」的半句,宾语才是 target。
  const title = isReloading
    ? translate('chat.reloadInProgress')
    : reason === 'manual'
      ? translate('task.manualReload')
      : reason === 'view-switch'
        ? target
        : translate(
            reason === 'mcp-toggle' ? 'chat.reloadConfirmTitleMcp' : 'chat.reloadConfirmTitleModel',
            { target },
          );
  const body = translate('chat.reloadConfirmBody');
  return (
    <ConfirmationDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={body}
      confirmLabel={translate(ACTION_KEYS[reason])}
      isConfirming={isReloading}
      onConfirm={onConfirm}
      {...(onCancel ? { onCancel } : {})}
    />
  );
}
