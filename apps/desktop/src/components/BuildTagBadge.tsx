import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { BUILD_TAG_WINDOW_NAME } from '../session/shared/aux-window'

declare const __GUGU_BUILD_TAG__: string
declare const __GUGU_TEST_NOTES__: string

/**
 * @@@red-on-purpose — 这个角标只在**带 build tag 的包**里渲染(`__GUGU_BUILD_TAG__` 为空就 return null),
 * 生产包里根本不出现。所以它可以、也应该刺眼:
 * mac1 上常年同时开着六七个窗口,标题**全都是**「咕咕 Desktop」——
 * 原来那版 10px 灰字角标在那种场景下等于没有,owner 两次都没找到自己那台试玩版。
 * ⇒ 它的职责不是"标注版本",是"**让人在一堆同名窗口里一眼认出这一台**"。
 *
 * @@@float-in-corner (#6044) — 它是悬浮层,❌ 从 app 里挖一条通道给它(那会在视口底部留一条空带)。
 * 位置是右下角,但收起态是贴角的一条矮条(≈19px 高、离边 2px):composer 的发送按钮下沿离窗口底
 * 还有 ~23px,矮条整个落在那段空里,不盖按钮、不截点击。❌ 把它加高/离边更远 —— 那就回到 #6044。
 * 展开的说明向上长、盖在 app 上。
 */
const badgeStyle: CSSProperties = {
  position: 'fixed',
  right: '2px',
  bottom: '2px',
  zIndex: 2147483647,
  maxWidth: 'min(45vw, 360px)',
  padding: '2px 8px',
  border: '1px solid #7f0e12',
  borderRadius: 'var(--radius-document)',
  background: '#d81f26',
  color: 'var(--color-white)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 'var(--font-caption)',
  fontWeight: 700,
  lineHeight: 1.2,
  letterSpacing: '.02em',
  boxShadow: '0 2px 10px rgba(216, 31, 38, .45)',
  userSelect: 'none',
}

const summaryStyle: CSSProperties = {
  cursor: 'pointer',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const notesStyle: CSSProperties = {
  marginTop: '6px',
  maxWidth: 'min(70vw, 520px)',
  maxHeight: '35vh',
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  userSelect: 'text',
  lineHeight: 1.45,
}

export function BuildTagBadge() {
  const { t } = useTranslation('main')
  const tag = __GUGU_BUILD_TAG__.trim()
  const native = typeof window.electronAPI !== 'undefined'
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const owned = useRef<{ popup: Window; mount: HTMLElement } | null>(null)
  const lease = useRef({ generation: 0 })
  useLayoutEffect(() => {
    if (!tag || !native) return
    const lifecycle = lease.current
    const generation = ++lifecycle.generation
    if (!owned.current || owned.current.popup.closed) {
      const popup = window.open('about:blank', BUILD_TAG_WINDOW_NAME)
      if (!popup) throw new Error('The native build tag window could not be opened')
      const mount = popup.document.createElement('div')
      popup.document.body.append(mount)
      owned.current = { popup, mount }
    }
    const { popup, mount } = owned.current
    const doc = popup.document
    doc.title = `Build ${tag}`
    doc.documentElement.style.cssText = 'background:transparent;overflow:hidden'
    doc.body.style.cssText = 'margin:0;width:max-content;background:transparent'
    const sync = () => {
      const style = getComputedStyle(document.documentElement)
      for (const name of ['--font-caption', '--radius-document', '--color-white']) {
        doc.documentElement.style.setProperty(name, style.getPropertyValue(name))
      }
      doc.documentElement.style.setProperty('--build-tag-max-width', `${Math.min(innerWidth * .45, 360)}px`)
      doc.documentElement.style.setProperty('--build-tag-notes-width', `${Math.min(innerWidth * .7, 520)}px`)
      doc.documentElement.style.setProperty('--build-tag-notes-height', `${innerHeight * .35}px`)
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
    // preferred size 会把旧视口高度当成下限。按内容写出文档大小,展开后才能真正收回矮条。
    const sizeObserver = new ResizeObserver(() => {
      const box = mount.getBoundingClientRect()
      if (box.width <= 0 || box.height <= 0) return
      doc.documentElement.style.width = `${Math.ceil(box.width)}px`
      doc.documentElement.style.height = `${Math.ceil(box.height)}px`
    })
    sizeObserver.observe(mount)
    window.addEventListener('resize', sync)
    setRoot(mount)
    return () => {
      observer.disconnect()
      sizeObserver.disconnect()
      window.removeEventListener('resize', sync)
      // StrictMode 会立即释放再认领同一组件。先交回这一轮同步任务,只关闭确实无人认领的窗口。
      queueMicrotask(() => {
        if (lifecycle.generation !== generation) return
        owned.current = null
        if (!popup.closed) popup.close()
      })
    }
  }, [tag, native])
  if (!tag) return null
  if (native && !root) return null
  const notes = __GUGU_TEST_NOTES__.trim() || t('buildArtifact.testNotesMissing')
  const badge = (
    <details aria-label={`Build ${tag}`} style={native ? { ...badgeStyle, position: 'relative', right: undefined, bottom: undefined, maxWidth: 'var(--build-tag-max-width)' } : badgeStyle}>
      <summary style={summaryStyle} title={t('buildArtifact.expand')}>{tag}</summary>
      <div style={native ? { ...notesStyle, maxWidth: 'var(--build-tag-notes-width)', maxHeight: 'var(--build-tag-notes-height)' } : notesStyle}>{notes}</div>
    </details>
  )
  return root ? createPortal(badge, root) : badge
}
