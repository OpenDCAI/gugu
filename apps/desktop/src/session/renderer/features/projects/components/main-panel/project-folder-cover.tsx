// 项目封面:按项目 id 固定的两三团柔色(电脑项目首页的文件夹卡、手机「伙伴」里的项目头像共用这一张,#446)。
import { useMemo } from 'react';

/** 封面:按项目 id 固定的两三团柔色(同头像规矩:同一个项目永远同一张)。 */
const HUES = [
  ['#9fc3cd', '#b9a9d6', '#c9dade'],
  ['#e2b394', '#a2c4b2', '#e3d3c3'],
  ['#b4a5d6', '#dcaebf', '#d8d0e6'],
  ['#a2c4b2', '#9fc3cd', '#cfe0d6'],
  ['#d4bf9f', '#b9a9d6', '#e2d9c8'],
  ['#a5bde0', '#cdb1d6', '#d3dcec'],
] as const;
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
  const [a, b, base] = HUES[hash32(`cover:${projectId}`) % HUES.length];
  const blobs = useMemo(() => {
    const r = seeded(`svg:${projectId}`);
    return [a, b, a, b, '#ffffff'].map((fill, i) => ({
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
