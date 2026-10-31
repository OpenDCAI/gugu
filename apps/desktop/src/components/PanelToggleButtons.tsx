import { PanelLeftClose, PanelLeftOpen } from '@/lib/icons'
import { useEffect, useRef, useState } from 'react'
import { readPanelToggle, usePanelToggle, type PanelSlot } from '../lib/panelToggles'
import { IconButton } from './ui/IconButton'

function withShortcut(label: string, shortcut: string | undefined): string {
  return shortcut ? `${label} (${shortcut})` : label
}

/**
 * @@@panel-toggles (#6753) 左那颗:收放一个列表栏。**只此一个组件**,挂载点各管各的定位 ——
 * 工作区页头、对话页(壳)。文案与状态全从控制器那一格读,所以会话页那份模块也能直接挂它。
 * slot 为空(这一页没有列表栏)时仍画成禁用占位,保持调用方的其它控件位置稳定。
 */
export function ListColumnToggle({ slot, disabledLabel = '' }: { slot: PanelSlot | null; disabledLabel?: string }) {
  const panel = usePanelToggle(slot)
  // 刚点完、预览浮着时都不弹提示:点完指针还压在按钮上,提示会糊住刚收起的那一下;预览浮着时,这次悬停的回答就是预览。
  const [justClicked, setJustClicked] = useState(false)
  const hoveredRef = useRef(false)
  // 悬停中换页签 / 卸载:pointerleave 不会来,得替它把悬停撤掉,否则那一栏的预览以为指针还在按钮上。
  useEffect(() => () => {
    if (!hoveredRef.current) return
    hoveredRef.current = false
    readPanelToggle(slot)?.setTriggerHovered?.(false)
  }, [slot])

  const open = panel?.open ?? false
  const label = panel?.label ?? disabledLabel
  return (
    <IconButton
      size="sm"
      // Keep the existing sidebar-control tone.
      tone="strong"
      data-titlebar-sidebar-toggle=""
      aria-label={label}
      aria-expanded={panel ? open : undefined}
      title={justClicked || panel?.peeking ? undefined : withShortcut(label, panel?.shortcut)}
      disabled={!panel}
      onClick={() => {
        setJustClicked(true)
        panel?.toggle()
      }}
      onPointerEnter={() => {
        hoveredRef.current = true
        panel?.setTriggerHovered?.(true)
      }}
      onPointerLeave={() => {
        hoveredRef.current = false
        panel?.setTriggerHovered?.(false)
        setJustClicked(false)
      }}
    >
      {/* 图标随状态换形:一眼读出这一下是收起还是展开(Close/Open 是本仓库既有的面板开关词汇)。 */}
      {open ? <PanelLeftClose /> : <PanelLeftOpen />}
    </IconButton>
  )
}
