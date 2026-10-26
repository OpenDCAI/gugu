import { useTranslation } from 'react-i18next'
import { composerCardPreview } from '@gugu/core/shared/ui/taskCardModels'
import { isTopicNameCutFromSource } from './topicAnchorModels'

/**
 * @@@5856 话题分栏的标题块 —— 话题名 + 它引自哪一句(product spec 的「双向连接」上行那一半)。
 *
 * 曾经它是全宽话题页顶栏的面包屑「来源线名 › 话题名」。owner 2026-09-19 把「全宽打开话题」整个拿掉
 * (「怎么还有把一个 topic 当做群的形式表达」)之后,话题只在来源线旁边开分栏 ⇒ 来源线就在左边看得见,
 * 「来源线名 ›」那一截与一颗跳回来源的按钮双双成了废件,删掉。
 * 留下来的是**引自哪一句**:从会话列表点进来的人,光看话题名说不出它从哪条消息长出来的。
 * 与来源消息底下的 TopicAnchorCard 合起来,仍然是双向连接。
 *
 * ⚠️ 名字默认就是从来源消息首行截的 ⇒ 没改过名时这两行是**同一个字符串上下堆着**。
 * 那时只画标题一行,❌ 不把同一句话印两遍(与锚点那一处同因同治,共用 isTopicNameCutFromSource)。
 *
 * `sourceMessagePreview` 的**四**种值必须分开,合并任意两种都会让这条面包屑说假话:
 *   · `'pending'` —— 还**没读到**(打开的第一帧、以及读取失败)。这一行什么都不显示。
 *   · `'unreadable'` —— 读到了:来源消息还在,只是**这个人**读不到(群开了隐藏历史、悄悄话……)。
 *     这一行同样什么都不说 —— @@@5856 找茬第八轮:它此前被并进「已删除」,而那是一句假话
 *     (消息没被删,别人都看得见),用户会以为产品把数据搞丢了。
 *   · `null` —— 读到了、来源消息**确实**被硬删了。此时必须**说出来**,❌ 不许静默显示成正常,
 *     否则用户只会看到一条来路不明的线,以为产品串了数据。
 *   · 有字 —— 正常预览。
 * 曾经三种都用 null 表示,于是每次打开话题的首帧都闪一次「来源消息已删除」。
 */
// @@@ui-ruler 结构性 style 提到模块作用域(同 ChatListPanel 的 *_STYLE 常量):
// 既避免每次渲染重建对象,也让 JSX 里不再残留内联几何块这条债务痕迹。
const TOPIC_BREADCRUMB_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 auto' }
const TOPIC_BREADCRUMB_NAME_STYLE: React.CSSProperties = {
  minWidth: 0,
  fontSize: 'var(--font-title)',
  lineHeight: 'var(--lh-title)',
  fontWeight: 'var(--font-weight-semibold)',
  color: 'var(--text-primary)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}
const TOPIC_BREADCRUMB_SOURCE_DELETED_STYLE: React.CSSProperties = { fontSize: 'var(--font-caption)', color: 'var(--warn)' }
const TOPIC_BREADCRUMB_SOURCE_PREVIEW_STYLE: React.CSSProperties = {
  fontSize: 'var(--font-caption)',
  color: 'var(--text-tertiary)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

export type TopicBreadcrumbProps = {
  topicName: string
  /** 来源消息被硬删时为 null —— 要有一句可呈现的状态，❌ 不许静默显示成正常 */
  sourceMessagePreview: string | null | 'pending' | 'unreadable'
}

export function TopicBreadcrumb({
  topicName,
  sourceMessagePreview,
}: TopicBreadcrumbProps) {
  const { t } = useTranslation('messaging')
  const preview = sourceMessagePreview == null ? sourceMessagePreview : composerCardPreview(sourceMessagePreview)?.text ?? sourceMessagePreview
  return (
    <div
      data-testid="topic-breadcrumb"
      style={TOPIC_BREADCRUMB_STYLE}
    >
      <span
        data-testid="topic-breadcrumb-name"
        style={TOPIC_BREADCRUMB_NAME_STYLE}
      >
        {topicName}
      </span>
      {preview === 'pending' || preview === 'unreadable'
        || isTopicNameCutFromSource(topicName, preview) ? null : preview === null ? (
        <span
          data-testid="topic-breadcrumb-source-deleted"
          style={TOPIC_BREADCRUMB_SOURCE_DELETED_STYLE}
        >
          {t('topic.breadcrumb.sourceDeleted')}
        </span>
      ) : (
        <span
          data-testid="topic-breadcrumb-source-preview"
          style={TOPIC_BREADCRUMB_SOURCE_PREVIEW_STYLE}
        >
          {t('topic.breadcrumb.sourcePreview', { preview })}
        </span>
      )}
    </div>
  )
}
