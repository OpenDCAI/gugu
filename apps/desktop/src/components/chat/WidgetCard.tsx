import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { COLOR_MUTED } from './chatPresentation'

// 安全审计修正：sandbox 值**不含 allow-same-origin**（那会让 iframe 内脚本
// 访问宿主 origin 的 DOM/cookie/localStorage = XSS 升权面）。postMessage bridge 不需要 same-origin。
const WIDGET_SANDBOX = 'allow-scripts allow-forms allow-modals allow-downloads allow-pointer-lock allow-presentation allow-orientation-lock allow-popups allow-popups-to-escape-sandbox'
const WIDGET_ALLOW = 'clipboard-read; clipboard-write; fullscreen; autoplay; picture-in-picture; web-share'

export interface Widget {
  id: string
  title: string
  /** Inline HTML source (takes priority over url when both provided). */
  html?: string
  /** External URL to load in the iframe. */
  url?: string
  state?: Record<string, unknown>
  pinned?: boolean
}

export interface WidgetCardProps {
  widget: Widget
}

function Spinner() {
  const { t } = useTranslation('messaging')
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-secondary)',
      }}
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        aria-label={t('message.widgetCard.loading')}
        style={{ animation: 'wc-spin 0.9s linear infinite' }}
      >
        <title>{t('message.widgetCard.loading')}</title>
        <circle cx="12" cy="12" r="9" stroke={COLOR_MUTED} strokeWidth="2" strokeOpacity="0.3" />
        <path
          d="M12 3a9 9 0 0 1 9 9"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      <style>{`@keyframes wc-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

export function WidgetCard({ widget }: WidgetCardProps) {
  const { t } = useTranslation('messaging')
  const [loading, setLoading] = useState(true)

  const src: string | undefined = widget.html
    ? `data:text/html;charset=utf-8,${encodeURIComponent(widget.html)}`
    : widget.url

  return (
    <div
      style={{
        borderRadius: 'var(--radius-surface)',
        overflow: 'hidden',
        border: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        width: '100%',
        maxWidth: '560px',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 10px',
          borderBottom: '1px solid var(--border)',
          gap: '8px',
        }}
      >
        <span
          style={{
            fontSize: 'var(--font-body)',
            fontWeight: 500,
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {widget.title}
        </span>
      </div>

      {/* iframe area — 16:9 */}
      <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9' }}>
        {loading && <Spinner />}
        {src ? (
          <iframe
            src={src}
            sandbox={WIDGET_SANDBOX}
            allow={WIDGET_ALLOW}
            title={widget.title}
            onLoad={() => setLoading(false)}
            style={{
              border: 'none',
              width: '100%',
              height: '100%',
              display: 'block',
              background: 'transparent',
            }}
          />
        ) : (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: COLOR_MUTED,
              fontSize: 'var(--font-body)',
            }}
          >
            {t('message.widgetCard.empty')}
          </div>
        )}
      </div>
    </div>
  )
}
