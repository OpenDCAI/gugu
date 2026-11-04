import { projectFolderAvatarColors } from '@/session/renderer/features/projects/components/main-panel/project-folder-cover'

/**
 * 选定的平面文件夹 A：项目身份色不变，运行中的项目更鲜明，空闲时降低饱和度。
 * 图形留在 48×48 画布内；消息列表和其他项目入口按各自头像位缩放。
 */
export function ProjectFolderAvatar({ coverId, running = 0, size = 40 }: { coverId: string; running?: number; size?: number }) {
  const { back, face } = projectFolderAvatarColors(coverId, running)
  return (
    <svg className="gg-project-avatar" width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <g className="gg-project-avatar-cover">
        <path d="M5 13a4 4 0 0 1 4-4h10l5 5h15a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z" fill={back} />
        <path d="M5 20h38v16a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z" fill={face} />
      </g>
      <path d="M9 20h30" stroke="var(--gg-project-avatar-hi)" strokeWidth={1.3} strokeLinecap="round" />
    </svg>
  )
}
