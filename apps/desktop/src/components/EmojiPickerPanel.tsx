/**
 * EmojiPickerPanel — 完整 emoji-mart 选择器叶子组件（#899）
 *
 * 用法示例：
 *   <EmojiPickerPanel onSelect={(e) => insertEmoji(e)} onClose={() => setOpen(false)} />
 *
 * TODO (trunk): 替换 ChatAreaPanel.tsx 里硬编码 50 个 emoji 的简陋 grid，
 *               以及消息气泡右键菜单"更多 emoji"入口，统一指向此组件。
 */

import { useEffect, useRef } from 'react'
import EmojiPicker from '@emoji-mart/react'
import data from '@emoji-mart/data'
import { useTheme } from '../store/theme'

/** emoji-mart onEmojiSelect 回调参数（简化类型） */
interface EmojiData {
  id: string
  name: string
  native: string
  unified: string
  shortcodes: string
}

export interface EmojiPickerPanelProps {
  /** 选中 emoji 后的回调，传 native 字符串（如 "😀"） */
  onSelect: (emoji: string) => void
  /** 点击 picker 外部时调用（可选；调用者自行用 onClickOutside 或 Portal 处理） */
  onClose?: () => void
  /** 强制指定 theme；未传则跟随 gugu 全局主题 */
  theme?: 'light' | 'dark' | 'auto'
}

/**
 * 中文 i18n 配置（emoji-mart locale="zh" 内置，但 Picker props 接受 i18n 覆盖）
 * emoji-mart v5 支持 locale prop 直接传 "zh"，内置翻译即生效。
 */

export function EmojiPickerPanel({ onSelect, onClose, theme: themeProp }: EmojiPickerPanelProps) {
  const { theme: guguTheme } = useTheme()
  const resolvedTheme = themeProp ?? guguTheme

  const containerRef = useRef<HTMLDivElement>(null)

  // 点击 picker 外部时触发 onClose
  useEffect(() => {
    if (!onClose) return
    function handlePointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose?.()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown, { capture: true })
    return () => document.removeEventListener('pointerdown', handlePointerDown, { capture: true })
  }, [onClose])

  function handleEmojiSelect(emoji: EmojiData) {
    onSelect(emoji.native)
    // 单选即关闭（反应场景）；输入插入场景不关闭由调用者决定
    // TODO (trunk): 输入框插入模式下 onClose 可不传，让 picker 保持展开
  }

  return (
    <div
      ref={containerRef}
      style={{
        // 弹层容器：跟随 gugu 弹层规范，背景/圆角/阴影用 CSS 变量
        borderRadius: 'var(--radius-xl)',
        overflow: 'hidden',
        boxShadow: 'var(--shadow-lift)',
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-elevated)',
        // emoji-mart 内部会自撑宽度，容器不设固定宽避免裁切
        display: 'inline-block',
      }}
    >
      <EmojiPicker
        data={data}
        onEmojiSelect={handleEmojiSelect}
        theme={resolvedTheme}
        locale="zh"
        // 减法：去掉 skin tone 面板（参见 gap 分析减法决策）
        skinTonePosition="none"
        // 去掉预览栏，节省高度
        previewPosition="none"
        // 导航条放顶部
        navPosition="top"
        // 搜索栏置顶
        searchPosition="sticky"
        // 每行 9 个 emoji
        perLine={9}
        // 最多 2 行"常用"，减少视觉噪音
        maxFrequentRows={2}
        // 点击 picker 外部时 emoji-mart 自带的 onClickOutside（传给 onClose 兜底）
        onClickOutside={onClose}
        // emoji-mart 默认用 Apple 图集（native 模式），set="native" 跨平台回退最优
        set="native"
      />
    </div>
  )
}
