import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';

/**
 * 图标上那圈进度环(#6157)。
 *
 * spec:「安装中 = 图标上的进度环」—— 状态画在图标上,不再用文字徽标。
 *
 * ⚠️ 有分母才画定长弧。拿不到分母时使用共用加载指示,❌ 不拿已下载量凑一个百分比:
 * 那是 product spec 明写的禁令,而且第一次装的人根本没有参照值去
 * 识破一个假的 87%。
 */
export function InstallProgressRing({ ratio }: { ratio: number | null }) {
  if (ratio === null) return <span data-testid="install-progress-ring" data-ratio="indeterminate"
    className="pointer-events-none absolute inset-0 flex items-center justify-center">
    <LoadingIndicator size="inline" />
  </span>;
  // viewBox 与外框同尺(48),半径留出线宽的一半,弧才不会被框裁掉。
  const circumference = 2 * Math.PI * 21.5;
  return (
    <svg
      viewBox="0 0 48 48"
      aria-hidden="true"
      data-testid="install-progress-ring"
      data-ratio={String(Math.round(ratio * 100))}
      className="pointer-events-none absolute inset-0 size-full -rotate-90"
    >
      <circle
        cx="24"
        cy="24"
        r="21.5"
        fill="none"
        strokeWidth="3"
        className="stroke-border-2"
      />
      <circle
        cx="24"
        cy="24"
        r="21.5"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        className="stroke-foreground transition-[stroke-dashoffset] duration-500"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - ratio)}
      />
    </svg>
  );
}
