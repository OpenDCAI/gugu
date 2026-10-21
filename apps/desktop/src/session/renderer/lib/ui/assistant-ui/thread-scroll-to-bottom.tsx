/**
 * Vendored from assistant-ui Elements（`thread.tsx` 的 `ThreadScrollToBottom`）。
 *
 * ⛔ 上游把它包在 `<ThreadPrimitive.ScrollToBottom asChild>` 里,由 `ThreadPrimitive.Viewport`
 * 推导贴底状态。**这里不引入 Viewport**(理由见本目录 README):`atBottom` 由宿主既有的
 * `onAtBottomChange` 单向喂进来,点击也只回调出去,这个组件自己不读也不写 scrollTop。
 *
 * 保留上游的 `disabled` + `disabled:invisible`(而不是条件挂载):按钮常驻 DOM,
 * 贴底时只是不可见不可点。这样 a11y 名字稳定,也不会在贴底边界上反复 mount/unmount。
 */
import { ArrowDownIcon } from '@/lib/icons'
import type { FC } from 'react';
import { cn } from '@renderer/utils/utils';
import { TooltipIconButton } from './tooltip-icon-button';

export type ThreadScrollToBottomProps = {
  /** 视口是否已在末尾。true ⇒ 按钮 disabled 且不可见。 */
  atBottom: boolean;
  onScrollToBottom: () => void;
  /** tooltip 与 sr-only 名字(宿主提供已翻译文案)。 */
  label: string;
  className?: string;
};

export const ThreadScrollToBottom: FC<ThreadScrollToBottomProps> = ({
  atBottom,
  onScrollToBottom,
  label,
  className,
}) => (
  <div
    data-slot="aui-thread-scroll-to-bottom"
    className={cn(
      // 骑在输入框上沿:露在外面的半截落在那道渐隐里,压着的是已经淡出的字,不是正读着的那一行。
      'pointer-events-none absolute inset-x-0 bottom-full -mb-4 flex justify-center',
      className
    )}
  >
    <TooltipIconButton
      tooltip={label}
      side="top"
      variant="outline"
      size="icon-md"
      disabled={atBottom}
      onClick={onScrollToBottom}
      className="aui-thread-scroll-to-bottom pointer-events-auto shadow-lift disabled:invisible"
    >
      <ArrowDownIcon />
    </TooltipIconButton>
  </div>
);
