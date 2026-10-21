import type { GuguPermissionMode } from '@gugu/session-core/acp/client';
import type { AgentProviderId } from '@gugu/session-plugins/agents';
import type { NewSessionConfig } from './new-session-config';
import { sessionTitleFromPrompt, nextDefaultSessionTitle } from './session-title';
import { sessionRuntimeOfView, type SessionView } from './sessions';

export type InitialSessionDocument = NonNullable<NewSessionConfig['initialSession']>;

/**
 * 「新建一条会话」的**输入维度** —— 桌面新建面(composer)与手机新建页交的是同一份。
 *
 * 这份类型就是「一次创建有哪几维」的唯一清单:展示(编程/通用)、权限档、模型(harness 自家或咕咕平台)、
 * 推理档、第一句话。加一维 = 在这里加一格,两个入口同时拿到;❌ 别在某一端单独加。
 */
export type InitialSessionInput = {
  /** 会话 id;不给就现生成。 */
  id?: string;
  provider: AgentProviderId;
  sessionView: SessionView;
  prompt: string;
  /** 只带附件、没打字时用文件名当首轮内容(#4325)。 */
  attachmentNames?: readonly string[];
  permissionMode: GuguPermissionMode;
  /** harness 自家模型 id;选了平台模型时必须为 null(模型由网关 token 钉死)。 */
  model: string | null;
  effort: string | null;
  /**
   * 三态(口径见 SessionPlatformModel):`undefined` = 这条路径没有 composer 决策(回落 agent 级);
   * `null` = 明确选了 harness 自家;对象 = 咕咕平台模型。
   */
  platformModel?: { modelId: string } | null;
  startupOrigin?: 'chat-page' | 'session-page';
  /** 已有会话的标题,给默认标题计数用;没有就当空。 */
  existingTitles?: ReadonlyArray<{ providerId: AgentProviderId; title: string }>;
};

/**
 * 把输入维度翻成落库的 `initialSession` 文档(`NewSessionConfig` 的那一格),桌面与手机同一个翻译点。
 *
 * ⚠️ 这里是**产品词 → 运行时词**的翻译点:调用方全程说「哪种展示」(SessionView),落库那一格叫 `type`,
 * 存的是 `pty`/`acp`。翻译只在这一行,❌ 别把 pty/acp 拎回调用方。
 */
export function buildInitialSessionDocument(
  input: InitialSessionInput,
): InitialSessionDocument {
  const typedUtterance = input.prompt.trim();
  // 首轮内容不一定是文字:只带附件也是一条真首轮。`firstUtterance` 是「这一轮有什么内容」的事实,
  // 文字为空时由这一轮的附件据实说出(文件名)——❌ 不留空(主进程 session-resume 的闸会当场抛)。
  const firstUtterance = typedUtterance || (input.attachmentNames ?? []).join(' ');
  return {
    id: input.id ?? crypto.randomUUID(),
    provider: input.provider,
    // spec session-resume:新建 = 带着第一句话开一件活。
    origin: { kind: 'create' as const, firstUtterance },
    ...(input.startupOrigin ? { startupOrigin: input.startupOrigin } : {}),
    // 侧栏那一行就是会话标题,所以由第一句话起名,❌ 不用 provider 计数(spec flows 链1)。
    title:
      sessionTitleFromPrompt(firstUtterance)
      ?? nextDefaultSessionTitle(input.provider, [...(input.existingTitles ?? [])]),
    permissionMode: input.permissionMode,
    // 平台模型由网关签发的 token 钉死,所以只省略 harness 的 model id;effort 仍随同一份
    // conversation config 记录并由共享注入边界读取,创建页与会话内不能各自推导。
    model: input.model ?? undefined,
    effort: input.effort ?? undefined,
    // 三态:决策过就**一定**带上字段 —— 选 harness 也要显式 null。少了这个 null,主进程分不清
    // 「明确要 BYOK」和「这条路径根本没有 composer」。
    ...(input.platformModel !== undefined ? { platformModel: input.platformModel } : {}),
    type: sessionRuntimeOfView(input.sessionView),
  };
}
