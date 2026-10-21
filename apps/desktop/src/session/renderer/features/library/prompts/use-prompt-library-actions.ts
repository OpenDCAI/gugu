// 提示词的新建 / 编辑 / 删除:一份实现,两处入口共用。
//
// 为什么要抽出来:增删改本来只长在「资源库 → 提示词」那一页上,而那一页在会话页没有任何可见入口
// (只有命令面板进得去)。于是用户在「添加上下文」弹层里看得见提示词、却找不到地方增删改
// (owner 2026-09-10 实机反馈:「找不到地方增删改,按理说如果在这里直接增删改也行啊」)。
// ⇒ 弹层里直接就地增删改,复用的就是这一份;❌ 别在弹层里再写一套写库逻辑,那是同一份数据两个写者。
import { toast } from '@renderer/lib/hooks/use-toast';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { PromptLibraryPrompt } from '@shared/prompt-library';
import type { PromptFormResult } from './prompt-modal';
import { usePromptLibrary } from './use-prompt-library';

function createPromptId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `prompt-${Date.now()}`;
}

export interface PromptLibraryActions {
  prompts: PromptLibraryPrompt[];
  /** 第一次读、还没读到。 */
  isLoading: boolean;
  /** 读写任一在途 → 入口置灰,避免同一份列表被两次乐观更新叠写。 */
  isBusy: boolean;
  /** 读这一份的错误(资源库看别的机器时,页面据此说那台机器怎么了)。 */
  error: unknown;
  hasData: boolean;
  reload(): void;
  createPrompt(): void;
  /**
   * 不走弹窗、当场建一条并把它交回来 ——「添加上下文」那个框里敲 `标题: 正文` 回车就是这条路。
   * 返回建出来的那条,好让调用方拿它的正文接着往输入框里塞(写库是乐观更新,不必等落库)。
   */
  createPromptFromDraft(draft: PromptFormResult): PromptLibraryPrompt;
  editPrompt(prompt: PromptLibraryPrompt): void;
  deletePrompt(prompt: PromptLibraryPrompt): void;
}

export function usePromptLibraryActions(): PromptLibraryActions {
  const { value, update, isLoading, isSaving, error, hasData, reload } = usePromptLibrary();
  const showPromptModal = useShowModal('promptModal');
  const showConfirm = useShowModal('confirmActionModal');
  const { translate } = useSessionMessages();

  const prompts = value ?? [];

  const upsertPrompt = (prompt: PromptLibraryPrompt, successTitle: string) => {
    const exists = prompts.some((item) => item.id === prompt.id);
    const nextPrompts = exists
      ? prompts.map((item) => (item.id === prompt.id ? prompt : item))
      : [...prompts, prompt];
    update(nextPrompts, { onSuccess: () => toast({ title: successTitle }) });
  };

  return {
    prompts,
    isLoading,
    isBusy: isLoading || isSaving,
    error,
    hasData,
    reload,
    createPromptFromDraft: (draft) => {
      const created: PromptLibraryPrompt = { id: createPromptId(), ...draft };
      upsertPrompt(created, translate('prompts.added'));
      return created;
    },
    createPrompt: () => {
      showPromptModal({
        onSuccess: (result: PromptFormResult) => {
          upsertPrompt({ id: createPromptId(), ...result }, translate('prompts.added'));
        },
      });
    },
    editPrompt: (prompt) => {
      showPromptModal({
        initialPrompt: prompt,
        onSuccess: (result: PromptFormResult) =>
          upsertPrompt({ ...prompt, ...result }, translate('prompts.updated')),
      });
    },
    deletePrompt: (prompt) => {
      showConfirm({
        // @@@raw prompt title — 提示词标题是用户内容,只做插值。
        title: translate('prompts.deleteTitle'),
        description: translate('prompts.deleteDescription', { title: prompt.title }),
        confirmLabel: translate('prompts.delete'),
        onSuccess: () =>
          update(
            prompts.filter((item) => item.id !== prompt.id),
            { onSuccess: () => toast({ title: translate('prompts.deleted') }) }
          ),
      });
    },
  };
}
