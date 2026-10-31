// 项目封面:按项目 id 固定的两三团柔色(电脑项目首页的文件夹卡、手机「伙伴」里的项目头像共用这一张,#446)。
import { useMemo } from 'react';
import { cssColorToHex, cssVar } from '@renderer/utils/cssVars';

/** 封面:按项目 id 固定的两三团柔色(同头像规矩:同一个项目永远同一张)。 */
// 六组柔色的取值在 tokens.css(--fc-cover-<组>-<a|b|base>,两套主题同值:封面是项目的身份色)。
// 下面的 saturated() 要按十六进制算饱和度,所以渲染时读出实际色值,❌ 把 var() 字符串交给它。
const HUES = [1, 2, 3, 4, 5, 6].map((n) => (['a', 'b', 'base'] as const).map((part) => `--fc-cover-${n}-${part}`));
// 没有样式环境(服务端 / node 里渲染的测试)时什么也画不出来,给空串。
const tokenHex = (name: string) => (typeof getComputedStyle === 'function' ? cssColorToHex(cssVar(name)) : '');
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function seeded(seed: string) {
  let x = hash32(seed) || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}
export function ProjectCover({ projectId, running, width, height, uid, saturationBoost = 1 }: { projectId: string; running: number; width: number; height: number; uid: string; saturationBoost?: number }) {
  const [a, b, base] = HUES[hash32(`cover:${projectId}`) % HUES.length].map(tokenHex);
  const blobs = useMemo(() => {
    const r = seeded(`svg:${projectId}`);
    return [a, b, a, b, tokenHex('--color-white')].map((fill, i) => ({
      fill,
      cx: Math.round(r() * width),
      cy: Math.round(r() * height * 0.9),
      rx: Math.round(width * (0.3 + r() * 0.3)),
      ry: Math.round(height * (0.35 + r() * 0.3)),
      opacity: i === 4 ? 0.55 : 0.95,
    }));
  }, [projectId, a, b, width, height]);
  // 在跑的越多越鲜,没人在跑褪成灰:扫一眼就知道哪个项目在动。
  const saturation = (running ? 1.15 + Math.min(running, 8) * 0.08 : 0.25) * saturationBoost;
  const saturated = (hex: string) => {
    const rgb = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
    const luma = rgb[0] * 0.213 + rgb[1] * 0.715 + rgb[2] * 0.072;
    return `rgb(${rgb.map((value) => Math.round(Math.max(0, Math.min(255, luma + saturation * (value - luma))))).join(' ')})`;
  };
  // Soft gradients paint the same seeded palette without allocating SVG blur surfaces.
  const feather = width / 9 * 2;
  return <>
    <defs>{blobs.map((blob, i) => <radialGradient key={i} id={`fc-cloud-${uid}-${i}`}>
      <stop offset="0" stopColor={saturated(blob.fill)} />
      <stop offset="45%" stopColor={saturated(blob.fill)} stopOpacity={0.85} />
      <stop offset="70%" stopColor={saturated(blob.fill)} stopOpacity={0.4} />
      <stop offset="100%" stopColor={saturated(blob.fill)} stopOpacity={0} />
    </radialGradient>)}</defs>
    <rect width={width} height={height} fill={base} />
    {blobs.map((blob, i) => <ellipse key={i} cx={blob.cx} cy={blob.cy} rx={blob.rx + feather} ry={blob.ry + feather} opacity={blob.opacity} fill={`url(#fc-cloud-${uid}-${i})`} />)}
  </>;

}
