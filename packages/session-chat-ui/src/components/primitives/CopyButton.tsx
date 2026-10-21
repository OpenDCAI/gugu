/** @jsxImportSource solid-js */
/**
 * CopyButton — shared copy-to-clipboard button.
 *
 * Two variants:
 *   'inline'  — used in the message footer: text label + icon, appears on group-hover.
 *   'overlay' — used in code blocks: icon-only, absolute positioned top-right.
 *
 * State is managed by createClipboard (Lane B — never touches measure).
 */

import { Show } from 'solid-js';
import { IconCheck, IconCopy } from './icons';
import { createClipboard } from './use-clipboard';
import { copyButtonInline, copyButtonOverlay } from './copy-button.css';
import { useChatTranslator, type ChatTranslationKey } from '@session-chat/localization';

export type CopyButtonProps = {
  text: string;
  variant: 'inline' | 'overlay';
  /**
   * 这颗按钮的文案键。默认 `'transcript.copy'`。
   *
   * ⚠️ 类型是**翻译键的联合**而不是 `string`，这是 #3482 的核心：旧版本是
   * `label?: string`，于是调用点传一个英文字面量（`label="Copy code"`）能通过类型、lint 与
   * 测试 —— 一个会变成用户可见文案的 `string` prop，按构造就是一条绕过 translator 的通道。
   * 收紧成键联合之后，那种写法在编译期就被拒收。
   */
  labelKey?: ChatTranslationKey;
};

export function CopyButton(props: CopyButtonProps) {
  const { copied, copy } = createClipboard();
  const translate = useChatTranslator();
  /**
   * 可访问名与可见标签的**单一来源**。
   *
   * ⚠️ 旧版本这里有两个来源：`aria-label` 走 `props.label`，而可见 `<span>` 写死
   * `translate('transcript.copy')` 完全无视它 ⇒ inline 变体上读屏念的和眼睛看到的不是一句话。
   * 中文界面下更明显：aria 念英文 "Copy message"，屏幕显示「复制」——语言与内容双重分叉。
   * 现在两处都从这里取值，那个分叉在结构上不可能再出现。
   */
  const label = () => translate(props.labelKey ?? 'transcript.copy');
  const ariaLabel = () => (copied() ? `${label()} - ${translate('transcript.copied')}` : label());

  if (props.variant === 'overlay') {
    return (
      <button
        type="button"
        class={copyButtonOverlay}
        aria-label={ariaLabel()}
        onClick={() => copy(props.text)}
      >
        <Show when={copied()} fallback={<IconCopy />}>
          <IconCheck />
        </Show>
      </button>
    );
  }

  return (
    <button
      type="button"
      class={copyButtonInline}
      aria-label={ariaLabel()}
      onClick={() => copy(props.text)}
    >
      <Show when={copied()} fallback={<IconCopy />}>
        <IconCheck />
      </Show>
      <span>{copied() ? translate('transcript.copied') : label()}</span>
    </button>
  );
}
