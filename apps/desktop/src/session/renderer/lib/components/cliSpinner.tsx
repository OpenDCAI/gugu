import { useContext, useEffect, useRef, useState, type CSSProperties } from 'react';
import { observeAnimationViewport } from '@gugu/session-shared/animation-visibility';
import { PageShownContext } from '@renderer/app/recent-session-pages';
import './cliSpinner.css';

const FRAMES_1 = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAMES_2 = [
  '⠈',
  '⠉',
  '⠋',
  '⠓',
  '⠒',
  '⠐',
  '⠐',
  '⠒',
  '⠖',
  '⠦',
  '⠤',
  '⠠',
  '⠠',
  '⠤',
  '⠦',
  '⠖',
  '⠒',
  '⠐',
  '⠐',
  '⠒',
  '⠓',
  '⠋',
  '⠉',
  '⠈',
];

/**
 * 停下来时画的那一帧(后台运行中 = 同一枚字形、动画停)。取两套帧里共有的 ⠋:
 * ❌ 停在「当前帧」—— 第二套会停在单点 ⠈ 上,读起来像一颗状态点,而会话页没有「完成点」(#6209)。
 */
const CLI_SPINNER_PAUSED_FRAME = '⠋';

/**
 * agent 在跑的那枚字形。字形本身不上色(前景墨色):「在跑」由它在转说出来(owner 2026-09-26 试玩后定,#6448)。
 *
 * 转动全在 CSS 里(cliSpinner.css):整套字形竖排成一条,窗口只露一行,按 80ms 一格走
 * (steps)—— 合成器上的位移,主线程不逐帧换字、不重渲。从前是每 80ms 一次 setState,看得见就一直在主线程上跑。
 * 看不见就停:滚出视口、窗口不可见、所在页面没在显示时暂停(与 ShimmerText 同一道开关);页签上被 × 盖住的那个由
 * 页签自己暂停(tab-close-button)。
 */
export function CLISpinner({
  variant = '1',
  animate = true,
}: {
  variant?: '1' | '2';
  /** `false` = 同一枚字形静止(不转)。 */
  animate?: boolean;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const shown = useContext(PageShownContext);
  const [inView, setInView] = useState(true);

  useEffect(() => {
    const host = element.current;
    if (!animate || !host) return;
    return observeAnimationViewport(host, setInView);
  }, [animate]);

  if (!animate) {
    return <span className="text-foreground/60" data-animate="false">{CLI_SPINNER_PAUSED_FRAME}</span>;
  }
  const frames = variant === '1' ? FRAMES_1 : FRAMES_2;
  const style = { '--cli-spinner-frames': frames.length, ...(shown && inView ? {} : { '--chat-shimmer-viewport-paused': 'paused' }) } as CSSProperties;
  return (
    <span ref={element} className="cli-spinner text-foreground/60" style={style}>
      <span className="cli-spinner__strip" aria-hidden="true">
        {frames.map((frame, index) => <span key={index}>{frame}</span>)}
      </span>
    </span>
  );
}
