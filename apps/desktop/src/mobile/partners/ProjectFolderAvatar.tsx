import { useId } from 'react'
import { ProjectCover } from '@/session/renderer/features/projects/components/main-panel/project-folder-cover'

/** Keep the desktop folder silhouette, with a lower front lip at avatar sizes. */
const W = 44, H = 36, BACK = 36, TH = 4, TW = 15, FRONT = 12, LW = 17, S = 3, R = 4
const TOP = H - FRONT
const BACK_D = `M0 ${TH + R} Q0 ${TH} ${R} ${TH} L${W - TW - 4} ${TH} C${W - TW - 1} ${TH} ${W - TW} 0 ${W - TW + 3} 0 L${W - R} 0 Q${W} 0 ${W} ${R} L${W} ${BACK - R} Q${W} ${BACK} ${W - R} ${BACK} L${R} ${BACK} Q0 ${BACK} 0 ${BACK - R} Z`
const FRONT_D = `M0 ${TOP + R} Q0 ${TOP} ${R} ${TOP} L${LW - 3} ${TOP} C${LW} ${TOP} ${LW} ${TOP + S} ${LW + 3} ${TOP + S} L${W - R} ${TOP + S} Q${W} ${TOP + S} ${W} ${TOP + S + R} L${W} ${H - R} Q${W} ${H} ${W - R} ${H} L${R} ${H} Q0 ${H} 0 ${H - R} Z`

/**
 * 项目头像沿用电脑的封面与耳朵形状。只画一份封面,前唇轻覆底色,小尺寸不再叠两次模糊色团。
 * 有 agent 在跑越多越鲜,没人在跑褪成灰。❌ 占位的灰底文件夹图标(owner 10-26:「占位符只能起负向作用」)。
 */
export function ProjectFolderAvatar({ coverId, running = 0, size = 40 }: { coverId: string; running?: number; size?: number }) {
  const uid = `pfa${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <svg className="gg-project-avatar" width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <defs>
        <clipPath id={`${uid}-back`}><path d={BACK_D} /></clipPath>
      </defs>
      <g transform="translate(2 6)">
        <g clipPath={`url(#${uid}-back)`} className="gg-project-avatar-cover">
          <ProjectCover projectId={coverId} running={running} width={W} height={BACK} uid={`${uid}-b`} />
        </g>
        <path d={BACK_D} fill="none" stroke="var(--gg-project-avatar-edge)" strokeWidth={0.6} />
        <path d={FRONT_D} fill="var(--bg)" fillOpacity={0.28} stroke="var(--gg-project-avatar-edge)" strokeWidth={0.8} />
        <path d={`M${R} ${TOP + 0.6} L${LW - 3} ${TOP + 0.6}`} stroke="var(--gg-project-avatar-hi)" strokeWidth={1} />
      </g>
    </svg>
  )
}
