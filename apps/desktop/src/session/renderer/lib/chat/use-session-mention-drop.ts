import { useCallback } from 'react';
import type { MentionItem, PromptEditorRef } from '@gugu/session-ui/react/components';
import { stringifyMention } from '@gugu/session-shared/markdown';
import { getDraggedSession, SESSION_DRAG_TYPE } from '@renderer/lib/drag-session';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { LocalSessionMentionProvider } from './local-session-mention-provider';

const SESSION_DROP_TYPES = [SESSION_DRAG_TYPE] as const;

/**
 * 把会话拖到**终端**上时写进去的那段字(编程形态的会话没有 composer,终端就是输入框)。
 *
 * 与聊天框写的是**同一种写法**:`@[Claude 1](aid:<Agent ID>)` —— 人读得出是谁,agent 拿得到
 * 可直接 `session_message` 的地址,不必先去通讯录查一次。两个落点写法不同曾是这个功能的
 * 一处不一致(owner 2026-09-16 拍板统一成这个形状)。
 *
 * 名册里没有它(还没身份)返回 null —— 终端上没有地方挂提示,所以这一步宁可什么都不写:
 * ❌ 退而写一个发不出去的名字,比不写更坏。
 */
export function terminalSessionMentionInput(
  mention: Pick<MentionItem, 'name' | 'label'> | null
): string | null {
  const name = mention?.name?.trim();
  const address = mention?.label?.trim();
  if (!name || !address) return null;
  return `${stringifyMention({ label: name, target: address, kind: 'custom' })} `;
}

/**
 * 把侧栏的一条会话行拖进 composer = 在这里插一枚 @ 提及。
 *
 * behavior session-page「把会话拖成 @」: 拖拽只是 @ 弹层的第二个入口,两条路给出**同一枚** pill ——
 * 所以身份解析走的是弹层那个 provider,而不是另拼一份。
 */
export function useSessionMentionDrop({
  provider,
  editorApiRef,
  selfSessionId,
  onMentionResolved,
}: {
  provider: LocalSessionMentionProvider | null;
  editorApiRef: { current: PromptEditorRef | null };
  /** 把一条会话拖到它自己的 composer 上不产生任何东西 —— @ 自己没有意义,也不值得报错。 */
  selfSessionId?: string;
  /** 解析成功、插入之前的记账口:隐藏上下文要按 token 查回这枚条目,靠它才有 `session_message` 的地址。 */
  onMentionResolved?: (item: MentionItem) => void;
}): {
  dataDropTypes: readonly string[];
  onDataDropped: (dataTransfer: DataTransfer) => void;
} {
  const { translate } = useSessionMessages();

  const onDataDropped = useCallback(
    (dataTransfer: DataTransfer) => {
      const dragged = getDraggedSession(dataTransfer);
      if (!dragged || !provider) return;
      if (dragged.sessionId === selfSessionId) return;
      const editor = editorApiRef.current;

      void (async () => {
        const item = await provider.resolveSession(dragged.sessionId);
        if (editorApiRef.current !== editor) return;
        if (!item) {
          // fail loud:名册里没有它就没有可投递的地址,❌ 不插一枚发不出去的 pill 让人以为成了。
          toast({
            title: translate('chat.mentionDropNoIdentity', { title: dragged.title }),
          });
          return;
        }
        onMentionResolved?.(item);
        editor?.insertMention(item);
      })();
    },
    [editorApiRef, onMentionResolved, provider, selfSessionId, translate],
  );

  return { dataDropTypes: SESSION_DROP_TYPES, onDataDropped };
}
