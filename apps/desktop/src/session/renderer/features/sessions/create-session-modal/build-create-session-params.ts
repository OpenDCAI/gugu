import type { InitialSessionState } from '@renderer/features/sessions/session-config/initial-session-section';
import { buildInitialSessionDocument } from '@shared/core/sessions/initial-session-document';
import type { NewSessionConfig } from '@shared/core/sessions/new-session-config';

// The composer's selected permission mode is what gets persisted: ❌ 这里不覆盖 —— 覆盖过的那一版让草稿显示只读、
// 会话开成最松档且不报错(#5597)(@@@5597-draft-decides)。
export function buildInitialSession(
  state: InitialSessionState,
  /** `id`:这条会话的 id(新建会话的 id 就是它)。附件在点「创建」之前就按它落盘,所以由调用方预留。 */
  options: { startupOrigin?: 'session-page'; id?: string } = {},
): NonNullable<NewSessionConfig['initialSession']> | undefined {
  const { provider } = state;
  if (!provider) return undefined;
  // 翻译(展示 → 运行时、首轮内容、标题、三态平台模型)全在共享的 buildInitialSessionDocument 里 ——
  // 手机新建页走的是同一个函数,两个入口对同一份输入必然得到同一份文档。这里只做 composer 状态 → 输入的映射。
  return buildInitialSessionDocument({
    ...(options.id ? { id: options.id } : {}),
    provider,
    sessionView: state.sessionView,
    prompt: state.prompt,
    attachmentNames: state.attachments.map((attachment) => attachment.name),
    permissionMode: state.permissionMode,
    model: state.model,
    effort: state.effort,
    // composer 就是这条会话的平台决策点:选 harness 也显式写 null(三态口径见 SessionPlatformModel)。
    platformModel: state.platformModel ? { modelId: state.platformModel } : null,
    ...(options.startupOrigin ? { startupOrigin: options.startupOrigin } : {}),
  });
}
