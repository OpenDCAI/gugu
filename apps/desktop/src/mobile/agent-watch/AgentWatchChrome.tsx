import type { ReactNode, Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft } from '@/lib/icons'
import { IconButton } from '@/components/ui/IconButton'
import { PaneHeader } from '@/components/ui/Pane'

/**
 * 三张页共用的页壳:固定页头(左上返回箭头 + 标题)+ 一个滚动体。
 *
 * 出口只有左上那个箭头 —— @@@1787 owner 定的手机导航规范。三张页各写一个页头的话,
 * 返回按钮的可访问名、触控尺寸、标题基线会各漂一次(这正是 ui-ruler 要消灭的东西)。
 *
 * 没有 `onBack` = 这一页就是「项目」tab 的根:它无处可回,页头与另外几个 tab 的根同形 ——
 * 大标题、没有箭头、没有分隔线。根页挂一个箭头,点下去只会跳到别的 tab,那不是「返回」。
 * 页头就是共用的 PaneHeader(mobile):高度、字阶、左右边距与「对话 / 联系人 / 我的」同一份 token;
 * 页头里的图标钮也与它们同一档(md,触控 44),❌ 这里再抬一档。
 */
export function AgentWatchScreen({
  title,
  onBack,
  testId,
  children,
  footer,
  actions,
  subtitle,
  titleLeading,
  headerTestId,
  bodyFill,
  bodyRef,
  headerAfter,
}: {
  title: ReactNode
  onBack?: () => void
  testId: string
  children: ReactNode
  footer?: ReactNode
  /** 页头右侧（放次要动作，如「载入更早的」）。 */
  actions?: ReactNode
  /** Actual state or location belongs to the shared header subtitle. */
  subtitle?: ReactNode
  titleLeading?: ReactNode
  headerTestId?: string
  /**
   * body 交给内容自己铺满、自己滚（时间线页用）。
   *
   * ❌ 不能让 body 和线程视口**同时**滚：外层滚起来时内层拿不到确定高度，于是输入框
   * 不再钉在屏幕底部、而是跟在最后一条消息后面浮着（实测截图就是这个样子）。
   */
  bodyFill?: boolean
  /** 滚动体的节点:列表页要读 / 还原滚动位置、滚到某一行。 */
  bodyRef?: Ref<HTMLDivElement>
  /** Root navigation shared with the workspace group list. */
  headerAfter?: ReactNode
}) {
  const { t } = useTranslation('main')
  return (
    <div className="gg-aw" data-testid={testId}>
      <PaneHeader
        mobile
        divider={Boolean(onBack)}
        title={title}
        subtitle={subtitle}
        titleLeading={titleLeading}
        titleLevel={onBack ? 'panel' : 'page'}
        data-testid={headerTestId}
        actions={actions}
        leading={onBack ? (
          <IconButton
            size="md"
            aria-label={t('settings.back')}
            onClick={onBack}
          >
            <ChevronLeft />
          </IconButton>
        ) : undefined}
      />
      {headerAfter}
      <div ref={bodyRef} className="gg-aw-body" data-fill={bodyFill ? 'true' : undefined}>{children}</div>
      {footer}
    </div>
  )
}

/** 说明块:离线 / 暂不支持 / 打不开。产品要求「说明原因」,所以原因是正文,不是灰字提示。 */
export function AgentWatchNote({
  title,
  detail,
  tone,
  testId,
  children,
}: {
  title: string
  detail?: string | null
  tone?: 'danger'
  testId?: string
  children?: ReactNode
}) {
  return (
    <div className="gg-aw-note" data-tone={tone} data-testid={testId}>
      <div className="gg-aw-note-title">{title}</div>
      {detail ? <div className="gg-aw-note-detail">{detail}</div> : null}
      {children}
    </div>
  )
}
