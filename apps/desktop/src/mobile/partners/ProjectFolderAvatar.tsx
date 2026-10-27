import { useId } from 'react'
import { ProjectCover } from '@/session/renderer/features/projects/components/main-panel/project-folder-cover'

/** 文件夹的几何(viewBox 48×48 里):后片 44×30 右上耳朵,前片左边高一截、压住下 18(缩到头像大小时多露封面,颜色认得出)。 */
const W = 44, H = 36, BACK = 30, TH = 4, TW = 15, FRONT = 18, LW = 17, S = 3, R = 4
const TOP = H - FRONT
const BACK_D = `M0 ${TH + R} Q0 ${TH} ${R} ${TH} L${W - TW - 4} ${TH} C${W - TW - 1} ${TH} ${W - TW} 0 ${W - TW + 3} 0 L${W - R} 0 Q${W} 0 ${W} ${R} L${W} ${BACK - R} Q${W} ${BACK} ${W - R} ${BACK} L${R} ${BACK} Q0 ${BACK} 0 ${BACK - R} Z`
const FRONT_D = `M0 ${TOP + R} Q0 ${TOP} ${R} ${TOP} L${LW - 3} ${TOP} C${LW} ${TOP} ${LW} ${TOP + S} ${LW + 3} ${TOP + S} L${W - R} ${TOP + S} Q${W} ${TOP + S} ${W} ${TOP + S + R} L${W} ${H - R} Q${W} ${H} ${W - R} ${H} L${R} ${H} Q0 ${H} 0 ${H - R} Z`

/**
 * 项目头像 = 电脑项目首页那张文件夹卡缩小(同一张封面 ProjectCover):后片带耳朵,前片半透明压在下半截。
 * 有 agent 在跑越多越鲜,没人在跑褪成灰。❌ 占位的灰底文件夹图标(owner 10-26:「占位符只能起负向作用」)。
 */
export function ProjectFolderAvatar({ coverId, running = 0, size = 40 }: { coverId: string; running?: number; size?: number }) {
  const uid = `pfa${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <svg className="gg-project-avatar" width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <defs>
        <clipPath id={`${uid}-back`}><path d={BACK_D} /></clipPath>
        <clipPath id={`${uid}-front`}><path d={FRONT_D} /></clipPath>
      </defs>
      <g transform="translate(2 6)">
        <g clipPath={`url(#${uid}-back)`} className="gg-project-avatar-cover">
          <ProjectCover projectId={coverId} running={running} width={W} height={BACK} uid={`${uid}-b`} />
        </g>
        <path d={BACK_D} fill="none" stroke="var(--gg-project-avatar-edge)" strokeWidth={0.6} />
        <g clipPath={`url(#${uid}-front)`}>
          <rect y={TOP} width={W} height={FRONT} fill="var(--bg)" />
          {/* 前片透出封面的下半截(电脑端同一张封面、饱和 ×1.5;头像小,透得比电脑端多) */}
          <g opacity={0.5} transform={`translate(0 ${H - BACK})`}>
            <ProjectCover projectId={coverId} running={running} width={W} height={BACK} uid={`${uid}-f`} saturationBoost={1.5} />
          </g>
        </g>
        <path d={FRONT_D} fill="none" stroke="var(--gg-project-avatar-edge)" strokeWidth={0.8} />
        <path d={`M${R} ${TOP + 0.6} L${LW - 3} ${TOP + 0.6}`} stroke="var(--gg-project-avatar-hi)" strokeWidth={1} />
      </g>
    </svg>
  )
}
