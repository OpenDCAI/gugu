import { useEffect, type RefObject } from 'react';
import { focusSessionComposer } from '@renderer/features/sidebar/session-keyboard-nav';

/**
 * 项目块里浮着的文件夹卡(gugu-dev#181):按 Esc 或直接打字,卡就让开;打的字落进新任务的框(焦点在别处也一样)。
 *
 * 在 window 的捕获阶段接:输入框里的 Esc 是会话键盘导航的「离开输入框」,它挂在 document 上,处理完就停止冒泡,
 * window 冒泡阶段的监听永远等不到这一下。卡浮着时这一下 Esc 只收卡(最上面那一层)并消费掉,❌ 顺带把光标踢出输入框;
 * 卡没浮着时一个键都不碰,Esc 照旧归键盘导航。
 */
export function useFloatingCardKeys(cardShown: boolean, hideCard: () => void, dockRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!cardShown) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        hideCard();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
      hideCard();
      if (dockRef.current && !dockRef.current.contains(document.activeElement)) focusSessionComposer(dockRef.current);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [cardShown, hideCard, dockRef]);
}
