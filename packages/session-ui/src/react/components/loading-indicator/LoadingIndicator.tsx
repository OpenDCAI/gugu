import { useLayoutEffect, useRef, type CSSProperties, type Ref } from 'react'
// 轻量版（SVG-only，168KB vs 完整版 305KB）。完整版在**模块加载时**就去建 canvas 取 2D
// 上下文 —— 那不只是 jsdom 里会抛：加载态是全 app 最早跑到的一段代码，
// 不该在它的导入路径上挂一个我们根本不用的渲染器。
import lottie, { type AnimationItem } from 'lottie-web/build/player/lottie_light'
import { loadingAnimationData } from './loading-animation.data'
import './LoadingIndicator.css'

/**
 * 咕咕唯一的加载态。冷启动、会话页骨架、TUI 起会话、ACP 拉历史、开工作区 —— 全都用这一个。
 *
 * 主壳和会话页各自打包这一份共享源码，
 * 但共享得了**源码**：两边各自打包一份，渲染进同一个 document，外观由同一份 CSS 决定。
 *
 * ❌ 别在调用处自己画：动效是设计师的成品，我们只负责摆位、配色接线和无障碍标签。
 */

/** 一整轮里所有点的外接框相对画布的占比。实测得来，见 LoadingIndicator.css 的注释。 */
const INK_WIDTH_RATIO = 120 / 800
const INK_HEIGHT_RATIO = 80.4 / 600

/**
 * 墨迹宽度（px）。三档，都是同一份素材、同一个动效，只差尺度：
 * - `page` 整屏那一屏（冷启动）——尺度大，周围没有别的东西陪衬。
 * - `panel` 面板内（会话页各处）——要和面板里的正文共处，不能喧宾夺主。
 * - `inline` 行内（按钮里、列表行尾、状态行前）——和一行 13px 的字并排，高度不超过一行。
 *   20 是实测挑的：真 Chromium 逐帧截 12/14/16/20/24 五档，16 以下点簇糊成一团看不出在动，
 *   20 时 8 个点都分得清、高 13px 塞得进 16px 的行高。
 *   这一档存在是因为 owner 2026-09-24 点名「加载中应该是我们的加载中，而不是一个 icon 手动旋转」——
 *   行内那些「在等」原来全是一枚 Loader2 图标手动转圈，没有这一档它们就只能继续各画各的。
 * ❌ 别再加第四档:每多一个尺寸就是多一种「差不多但不一样」。
 */
const INK_WIDTH: Record<LoadingIndicatorSize, number> = {
  page: 84,
  panel: 48,
  inline: 20,
}

export type LoadingIndicatorSize = 'page' | 'panel' | 'inline'

interface LoadingIndicatorBaseProps {
  className?: string
  /** 透传给根节点，方便各处保留自己原有的定位/测试钩子。 */
  'data-testid'?: string
}

export type LoadingIndicatorProps = LoadingIndicatorBaseProps &
  (
    | {
        size?: 'page' | 'panel'
        /** 说清「在等什么」。给读屏软件用；传了 `label` 时也画在动画下面。 */
        ariaLabel: string
        /** 画在动画下面的一行字。不传就只有动画 —— 骨架屏那种场合不需要文案。 */
        label?: string
      }
    | {
        /** 行内一档：渲染成 `<span>`，能放进按钮与一行文字里；没有 label —— 旁边那行字由调用处自己写。 */
        size: 'inline'
        /** 旁边的文字已经说清在等什么时不传，整个动画对读屏软件隐藏。 */
        ariaLabel?: string
        label?: never
      }
  )

export function LoadingIndicator(props: LoadingIndicatorProps) {
  const { ariaLabel, label, className, 'data-testid': testId = 'loading-indicator' } = props
  const size: LoadingIndicatorSize = props.size ?? 'panel'
  const hostRef = useRef<HTMLElement | null>(null)

  // ⚠️ 必须是 layout effect，❌ 不能用 useEffect。
  // 被动 effect 要等 React 有空才 flush，而冷启动那一段主线程正被整个 app 的启动挤满 ——
  // 实测（真 app、CPU 降频 20x）：加载页存续 1.4s，容器 children 全程为 0，动画一次都没画进去。
  // 也就是说它恰好在**最需要它的时候（启动慢）**是一块空白。
  // layout effect 随 commit 同步跑，浏览器画出这一屏时里面必然已经有内容。
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return

    // 系统减弱动态：停在第 0 帧那个完整的点簇，而不是留空 ——
    // 「不要动效」不等于「不要加载态」。
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // ❌ 别在这里包 try/catch 兜底：播放器起不来就是真失败，该由错误边界响亮地报出来。
    // 之前那个静默 catch 什么也没救到，只会把下一次真故障变成一块无人知晓的空白。
    const animation: AnimationItem = lottie.loadAnimation({
      container: host,
      renderer: 'svg',
      loop: !reduced,
      autoplay: false,
      // lottie 会就地改写传进去的数据；共享的原件必须留干净。
      animationData: structuredClone(loadingAnimationData),
    })

    // 看不见就不转(#6629)。常驻但隐藏的面(`content-visibility:hidden`,见 lib/retainedSurface.ts)
    // 里的加载态照样逐帧改 SVG,渲染进程就按刷新率把样式/布局/绘制整条管线空跑,实测吃掉一个核的一半。
    // 以 checkVisibility 为准(它认 display / visibility / content-visibility 整条祖先链);
    // 祖先的属性变化(切面板)与自己进出文档/显示(IntersectionObserver)都触发重判。
    // 没有 checkVisibility 的 WebView(旧 iOS)照旧一直转。
    const observers: Array<MutationObserver | IntersectionObserver> = []
    if (reduced) {
      animation.goToAndStop(0, true)
    } else if (typeof host.checkVisibility !== 'function') {
      animation.play()
    } else {
      const sync = () => {
        if (host.checkVisibility({ visibilityProperty: true })) animation.play()
        else animation.pause()
      }
      sync()
      const ancestors = new MutationObserver(sync)
      for (let el = host.parentElement; el; el = el.parentElement) {
        ancestors.observe(el, { attributes: true, attributeFilter: ['style', 'class', 'hidden', 'inert'] })
      }
      const presence = new IntersectionObserver(sync)
      presence.observe(host)
      observers.push(ancestors, presence)
    }

    return () => {
      for (const observer of observers) observer.disconnect()
      animation.destroy()
    }
  }, [])

  const ink = INK_WIDTH[size]
  // 行内那一档要能放进按钮与一行文字里，那里只许短语内容 —— 所以换成 span，外观由同一份 CSS 给。
  const Tag = size === 'inline' ? 'span' : 'div'
  const announced = ariaLabel !== undefined

  return (
    <Tag
      role={announced ? 'status' : undefined}
      aria-label={ariaLabel}
      aria-hidden={announced ? undefined : true}
      data-testid={testId}
      data-gg-loading={size}
      className={className ? `gg-loading ${className}` : 'gg-loading'}
    >
      <Tag
        className="gg-loading-stage"
        style={{ width: ink, height: Math.round((ink / INK_WIDTH_RATIO) * INK_HEIGHT_RATIO) }}
      >
        <Tag
          ref={hostRef as Ref<HTMLDivElement & HTMLSpanElement>}
          aria-hidden="true"
          data-testid="loading-indicator-canvas"
          className="gg-loading-canvas"
          style={{ '--gg-loading-canvas-width': `${Math.round(ink / INK_WIDTH_RATIO)}px` } as CSSProperties}
        />
      </Tag>
      {label ? <Tag className="gg-loading-label">{label}</Tag> : null}
    </Tag>
  )
}
