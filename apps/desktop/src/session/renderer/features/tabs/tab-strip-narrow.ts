import { useEffect, useState, type RefObject } from 'react';

/**
 * 这个元素所在的页签条窄不窄(TabStripShell 的 `data-strip-narrow`,TAB_STRIP_NARROW_PX),给右端那组控制自己让位用。
 * 群头那排钮是 portal 进块顶那一格的(ChatBlockHead),React context 传不过去,所以照 DOM 读、跟着属性变。
 * 换了块 = portal 换了宿主 = 重新挂载,会重新找一次页签条。不在页签条里时是 false。
 */
export function useStripNarrow(ref: RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const bar = ref.current?.closest('.session-tab-bar');
    if (!bar) return;
    const read = () => setNarrow(bar.hasAttribute('data-strip-narrow'));
    read();
    const observer = new MutationObserver(read);
    observer.observe(bar, { attributes: true, attributeFilter: ['data-strip-narrow'] });
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
}
