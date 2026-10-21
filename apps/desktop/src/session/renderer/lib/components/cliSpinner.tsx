import { useEffect, useState } from 'react';

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
 */
export function CLISpinner({
  variant = '1',
  animate = true,
}: {
  variant?: '1' | '2';
  /** `false` = 同一枚字形静止(不起计时器)。 */
  animate?: boolean;
}) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!animate) return;
    const interval = setInterval(() => {
      setIndex((index + 1) % (variant === '1' ? FRAMES_1.length : FRAMES_2.length));
    }, 80);
    return () => clearInterval(interval);
  }, [index, variant, animate]);

  return (
    <span className="text-foreground/60" data-animate={animate ? undefined : 'false'}>
      {!animate ? CLI_SPINNER_PAUSED_FRAME : variant === '1' ? FRAMES_1[index] : FRAMES_2[index]}
    </span>
  );
}
