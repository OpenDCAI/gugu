import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MomentsPost } from '@gugu/core/shared/types/moments'
import { Markdown } from '../../components/markdown/Markdown'
import { MomentLinkContent } from '../../components/discover/MomentLinkContent'

// 折叠上限(px)：须与 ExplorePage.css 的 .gg-pbody-clamp max-height 同步。
export const PLAZA_BODY_CLAMP_PX = 260

/**
 * 好友动态卡正文。@@@1986：
 *  ① 官方「咕咕」广播(post.author.isOfficial) → 走聊天气泡同款 Markdown，把 `**加粗**`/`- 列表`
 *     渲成富文本，不再裸出星号。用户动态仍是纯文本(.gg-ptext，pre-wrap 保换行 #1524)——不拿
 *     markdown 管线去动用户手打文本(避免误把普通文本里的 * / - / # 吃成语法)。
 *  ② 超长卡(官方 changelog 常见)真实测量溢出(scrollHeight，故 useLayoutEffect；jsdom 无布局→
 *     测 0→不折叠，契约由 e2e/真渲染兜)→ 折叠到上限 + 展开全文/收起，别吃满 masonry 一整列。
 */
export function PlazaPostBody({ post }: { post: MomentsPost }) {
  const { t } = useTranslation('discover')
  const innerRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useLayoutEffect(() => {
    const el = innerRef.current
    if (!el) return
    // markdown(Streamdown/字体/图片)是**异步布局**：一次性 useLayoutEffect 测得 scrollHeight 偏小 → 漏
    // 折叠(#1986 macOS 实测 clientHeight=1170 却无 clamp)。用 ResizeObserver 盯内容最终高度/宽度变化重测。
    // 关键：测「未被 clamp 的内层」——外层折叠后 max-height 定死，ResizeObserver 不会因内容长高而触发。
    const measure = () => setOverflowing(el.scrollHeight > PLAZA_BODY_CLAMP_PX + 2)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [post.content])

  const clamped = overflowing && !expanded

  return (
    <div>
      <div className={`gg-pbody${clamped ? ' gg-pbody-clamp' : ''}`}>
        <div ref={innerRef}>
          <MomentLinkContent
            content={post.content ?? ''}
            className={post.author.isOfficial ? 'gg-pofficial-richtext' : 'gg-ptext'}
            renderText={post.author.isOfficial
              ? (text, key) => <Markdown key={key} trust="chat" content={text} hardBreaks />
              : undefined}
          />
        </div>
      </div>
      {overflowing && (
        <button
          type="button"
          className="gg-pmore gg-pressable"
          // 折叠区与开关的关联要说出来，否则读屏只听见一个孤零零的「展开全文」。
          aria-expanded={expanded}
          onClick={() => { setExpanded((v) => !v) }}
        >
          {expanded ? t('moments.collapse') : t('moments.expand')}
        </button>
      )}
    </div>
  )
}
