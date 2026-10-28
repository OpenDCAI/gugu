import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  isSendableText,
  modifierBits,
  type CloudBrowserClientMessage,
  type CloudBrowserMouseButton,
} from '@/session/shared/cloud-browser'
import { chunkText, nextTextId, remotePoint } from './screenMath'
import './cloudBrowser.css'
import type { CloudBrowserFrame } from './useCloudBrowser'

/**
 * 远程浏览器画面(canvas 查看器):一帧画完才回 ack(pacing:ack);接管中把这块上的鼠标、
 * 滚轮、键盘、输入法 / 粘贴的文字换算成远端页面坐标交过去。没接管时只看。
 *
 * 坐标:画面按 contain 缩放居中;本地点 → 图片里的点 → 远端 CSS 坐标(× viewportWidth / 图宽)。落在图片外的不发。
 * 文字走一个看不见的 textarea:输入法上屏、普通字符、粘贴都成 `input_text`;回车、退格、方向键和
 * 带 ⌘ / Ctrl 的组合键成 `input_keyboard`。Mac 上的 ⌘ 换成 Ctrl —— 远端是 Linux 上的 Chrome。
 */

const SPECIAL_KEYS = new Set([
  'Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
])
const MOVE_THROTTLE_MS = 32

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

function buttonOf(button: number): CloudBrowserMouseButton {
  if (button === 0) return 'left'
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return 'none'
}

export function CloudBrowserScreen({
  frame,
  interactive,
  onAck,
  send,
  onInvalidText,
}: {
  frame: CloudBrowserFrame | null
  interactive: boolean
  onAck?: (seq: number) => void
  send: (message: CloudBrowserClientMessage) => boolean
  onInvalidText?: () => void
}) {
  const { t } = useTranslation('cloudBrowser')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const frameRef = useRef<CloudBrowserFrame | null>(frame)
  frameRef.current = frame
  const lastMoveAt = useRef(0)
  const composing = useRef(false)
  const pressed = useRef<CloudBrowserMouseButton | null>(null)
  /** 最后一次落在画面上的位置:拖到画面外松手时,抬起照样发在这里(❌ 远端一直按着)。 */
  const lastAt = useRef<{ x: number; y: number } | null>(null)

  // 画:解码完画上去,画完回 ack。新帧到得比解码快就跳过旧的。
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !frame) return
    let cancelled = false
    const bytes = Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0))
    void createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
      .then((bitmap) => {
        if (cancelled) {
          bitmap.close()
          return
        }
        if (canvas.width !== bitmap.width) canvas.width = bitmap.width
        if (canvas.height !== bitmap.height) canvas.height = bitmap.height
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
        bitmap.close()
        if (frame.seq !== null) onAck?.(frame.seq)
      })
      .catch(() => {
        if (!cancelled && frame.seq !== null) onAck?.(frame.seq)
      })
    return () => {
      cancelled = true
    }
  }, [frame, onAck])

  useEffect(() => {
    if (interactive) inputRef.current?.focus({ preventScroll: true })
  }, [interactive])

  // 交还 / 卸载时还按着的那一下补一个抬起,❌ 让远端以为鼠标一直按着。
  useEffect(() => {
    if (interactive) return
    const button = pressed.current
    const current = frameRef.current
    if (button && current) send({ type: 'input_mouse', eventType: 'mouseReleased', x: 0, y: 0, button, buttons: 0, clickCount: 1, modifiers: 0 })
    pressed.current = null
  }, [interactive, send])

  const point = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current
    const current = frameRef.current
    if (!canvas || !current) return null
    return remotePoint({ x: event.clientX, y: event.clientY }, canvas.getBoundingClientRect(), current)
  }

  const mods = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    const bits = modifierBits(event)
    // Mac 的 ⌘ = 远端的 Ctrl。
    return isMac && event.metaKey ? (bits & ~4) | 2 : bits
  }

  const sendText = (text: string) => {
    if (!text) return
    if (!isSendableText(text)) {
      onInvalidText?.()
      return
    }
    for (const chunk of chunkText(text)) send({ type: 'input_text', id: nextTextId(), text: chunk })
  }

  return (
    <div className="cb-screen">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={t('viewer.screen')}
        className="cb-canvas"
        data-mode={interactive ? 'control' : undefined}
        onContextMenu={(event) => {
          if (interactive) event.preventDefault()
        }}
        onPointerDown={(event) => {
          if (!interactive) return
          inputRef.current?.focus({ preventScroll: true })
          const at = point(event)
          if (!at) return
          event.currentTarget.setPointerCapture(event.pointerId)
          lastAt.current = at
          const button = buttonOf(event.button)
          pressed.current = button
          send({ type: 'input_mouse', eventType: 'mousePressed', ...at, button, buttons: event.buttons, clickCount: Math.min(3, Math.max(1, event.detail)), modifiers: mods(event) })
          event.preventDefault()
        }}
        onPointerUp={(event) => {
          if (!interactive) return
          const held = pressed.current
          pressed.current = null
          const at = point(event) ?? (held ? lastAt.current : null)
          if (!at) return
          const button = held ?? buttonOf(event.button)
          send({ type: 'input_mouse', eventType: 'mouseReleased', ...at, button, buttons: event.buttons, clickCount: Math.min(3, Math.max(1, event.detail)), modifiers: mods(event) })
        }}
        onPointerMove={(event) => {
          if (!interactive) return
          const now = Date.now()
          if (now - lastMoveAt.current < MOVE_THROTTLE_MS) return
          lastMoveAt.current = now
          const at = point(event)
          if (!at) return
          lastAt.current = at
          send({ type: 'input_mouse', eventType: 'mouseMoved', ...at, button: pressed.current ?? 'none', buttons: event.buttons, clickCount: 0, modifiers: mods(event) })
        }}
        onLostPointerCapture={(event) => {
          const button = pressed.current
          if (!interactive || !button) return
          pressed.current = null
          const at = point(event) ?? lastAt.current ?? { x: 0, y: 0 }
          send({ type: 'input_mouse', eventType: 'mouseReleased', ...at, button, buttons: 0, clickCount: 1, modifiers: 0 })
        }}
        onWheel={(event) => {
          if (!interactive || event.ctrlKey) return
          const at = point(event)
          const current = frameRef.current
          if (!at || !current) return
          const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? current.viewportHeight : 1
          send({ type: 'input_mouse', eventType: 'mouseWheel', ...at, button: 'none', buttons: 0, clickCount: 0, modifiers: mods(event), deltaX: event.deltaX * unit, deltaY: event.deltaY * unit })
        }}
      />
      {interactive ? (
        <textarea
          ref={inputRef}
          aria-label={t('viewer.keyboard')}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="cb-keys"
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={(event) => {
            composing.current = false
            sendText(event.currentTarget.value)
            event.currentTarget.value = ''
          }}
          onInput={(event) => {
            if (composing.current) return
            sendText(event.currentTarget.value)
            event.currentTarget.value = ''
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.key === 'Process') return
            const withCommand = event.ctrlKey || event.metaKey
            // ⌘V / Ctrl+V 交给 textarea 自己的粘贴(走 input_text);别的组合键和功能键成按键。
            if (withCommand && event.key.toLowerCase() === 'v') return
            if (!SPECIAL_KEYS.has(event.key) && !withCommand) return
            event.preventDefault()
            const base = { key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode & 0xff, modifiers: mods(event) }
            send({ type: 'input_keyboard', eventType: 'keyDown', ...base, ...(event.key === 'Enter' && !withCommand ? { text: '\r' } : {}) })
            send({ type: 'input_keyboard', eventType: 'keyUp', ...base })
          }}
        />
      ) : null}
    </div>
  )
}
