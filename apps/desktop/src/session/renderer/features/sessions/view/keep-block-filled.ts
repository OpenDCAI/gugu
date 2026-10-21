import { reaction } from 'mobx';

/**
 * spec session-page「一屏几块」:屏上不止一块时,一块 ❌ 空着 —— 空格子不画页签条,⋮⋮ 和关掉这一块的 × 都长在页签条上,
 * 空着就关不掉(owner 2026-10-10:「触发了这个界面,关也没法关」)。
 * - 在屏上有过页签、现在空了(最后一格关掉;或屏上原来只有它一块、关空了又拼进来别的)→ `close`,这一块跟着关掉;
 * - 摆上来就一枚页签都没有(拖进来没开、重启照原样摆回一块空的)→ `fill`:会话那块第一枚页签就是会话本身,开它的对话。
 * 屏上只剩它一块时空着照旧,留着「+」那一列。
 */
export function keepBlockFilled({
  empty,
  alone,
  close,
  fill,
}: {
  empty: () => boolean;
  alone: () => boolean;
  close: () => void;
  /** 开它的对话;返回撤销(还没开成就不开了)。 */
  fill: () => () => void;
}): () => void {
  let hadTab = false;
  let filling: (() => void) | null = null;
  const dispose = reaction(
    () => (!empty() ? 'tabs' : alone() ? 'alone' : 'bare'),
    (state) => {
      if (state === 'tabs') hadTab = true;
      else if (state === 'bare') {
        if (hadTab) close();
        else filling ??= fill();
      }
    },
    { fireImmediately: true }
  );
  return () => {
    dispose();
    filling?.();
  };
}
