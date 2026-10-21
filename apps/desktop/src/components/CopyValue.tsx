import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy } from '@/lib/icons'
import { useToast } from './toastContext'

interface CopyValueProps {
  value: string
  short?: boolean
  /**
   * 链接类值用它:单行、末尾省略,像 Drive/飞书的分享输入框那样先露出协议+域名。
   * ❌ 别对 URL 用 short(首 8 尾 6 的中间省略)—— 会得到 `https://...140%7D` 这种既不像链接、
   * 也认不出是谁的字符串(实机截图照出来的)。ID 才适合中间省略:头尾就是人肉比对的锚点。
   */
  ellipsis?: boolean
  message: string
  /**
   * 反馈落在哪:默认 'toast'(全局右上角)。浮层/弹层里的复制要用 'inline' —— 确认应该长在**被点的
   * 那个东西**上,而不是飞到屏幕角上跟别的浮层抢位置(实机:右上 toast 盖住会话页顶栏的动作按钮)。
   */
  feedback?: 'toast' | 'inline'
}

export function CopyValue({
  value,
  short = false,
  ellipsis = false,
  message,
  feedback = 'toast'
}: CopyValueProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flash = useCallback((state: 'ok' | 'fail') => {
    setCopied(state)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(null), 1600)
  }, [])
  const visible = short && value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value)
      if (feedback === 'inline') flash('ok')
      else toast(message, 'success')
    } catch (error) {
      if (feedback === 'inline') flash('fail')
      else toast(t('actions.copyFailed'), 'error')
      console.error('Clipboard copy failed:', error)
    }
  }, [value, message, toast, feedback, flash, t])

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
        // 省略模式下外层也必须可收缩:只给内层 flex:1 没用 —— 外层 inline-flex 仍按内容撑开,
        // 于是长链接把复制按钮顶出容器、被 overflow:hidden 裁掉(实机截图照出来的)。
        ...(ellipsis ? { flex: 1, maxWidth: '100%' } : null)
      }}
    >
      <span
        title={ellipsis ? value : undefined}
        style={
          ellipsis
            ? {
                flex: 1,
                minWidth: 0,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }
            : { overflowWrap: 'anywhere' }
        }
      >
        {visible}
      </span>
      <button
        type="button"
        // 触控下限 44px 给的是**点按区**,不是这个框:原先窄屏把可见的方框本身放大成 44px,
        // 于是「咕咕号 108852」旁边立着一块比文字还高的空盒子,把整行撑歪(手机端走查实拍)。
        // 现在框保持 22px,伪元素向四周各伸 11px 补足点按区。
        className="gg-pressable relative before:absolute before:-inset-[11px] before:content-['']"
        title={t('actions.copy')}
        aria-label={t('actions.copy')}
        onClick={handleCopy}
        style={{
          width: 22,
          height: 22,
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-document)',
          background: 'var(--input-bg)',
          color: 'var(--text-secondary)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          flexShrink: 0
        }}
      >
        <Copy size={12} />
      </button>
      {feedback === 'inline' && copied ? (
        <span
          aria-live="polite"
          style={{
            fontSize: 'var(--font-body)',
            whiteSpace: 'nowrap',
            color: copied === 'ok' ? 'var(--ok)' : 'var(--danger)'
          }}
        >
          {copied === 'ok' ? message : t('actions.copyFailed')}
        </span>
      ) : null}
    </span>
  )
}
