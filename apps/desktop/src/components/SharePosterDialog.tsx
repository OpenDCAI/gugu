import { messageForUser } from '@/lib/userFacingError';
import { useEffect, useRef, useState, useCallback } from 'react'
import QRCode from 'qrcode'
import { createSharePosterCanvas, copyPosterToClipboard, downloadPoster } from './sharePosterCanvas'
import { Sheet } from './ui/Sheet'
import { useTranslation } from 'react-i18next'
import { rendererLogger } from '@/lib/log'
import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'
import { qrColors } from '../lib/qrColors'

// @@@share-poster (#903) - Share poster dialog: canvas-composed image with QR + branding.
// Supports copy-to-clipboard and download. No new dependencies (reuses `qrcode` already
// imported by ContactQrShare). Pure canvas logic lives in sharePosterCanvas.ts to satisfy
// react-refresh "only export components" constraint.

export interface SharePosterDialogProps {
  /** Primary heading drawn on the poster (e.g. group name or agent name) */
  title: string
  /** Secondary line below title (e.g. "agent · 咕咕") */
  subtitle: string
  /** Value encoded into the QR code (invite URL / gugu:// deep link) */
  qrValue: string
  // @@@445 群分享:成员头像(已解析 URL/dataURL 或显式 null 空槽)→ 走群布局;没有成员槽位才走名片布局。
  memberAvatarUrls?: Array<string | null>
  /** 群总成员数(「+N」溢出计数用;memberAvatarUrls 已截 ≤9)。 */
  totalMemberCount?: number
  /** QR 下方小字(群分享传「扫码加入群聊」)。 */
  qrCaption?: string
  /** 底部邀请 CTA 文案。 */
  ctaText?: string
  onClose: () => void
}

export function SharePosterDialog({ title, subtitle, qrValue, memberAvatarUrls, totalMemberCount, qrCaption, ctaText, onClose }: SharePosterDialogProps) {
  const { t } = useTranslation('contacts')
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [posterDataUrl, setPosterDataUrl] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<string | null>(null)
  const [downloadDone, setDownloadDone] = useState(false)
  const posterCanvasRef = useRef<HTMLCanvasElement | null>(null)

  // Step 1: Generate QR data URL
  useEffect(() => {
    if (!qrValue) return
    let cancelled = false
    QRCode.toDataURL(qrValue, { width: 280, margin: 1, color: qrColors() })
      .then((url) => { if (!cancelled) setQrDataUrl(url) })
      .catch((err) => {
        console.error('[SharePosterDialog] QR gen error', err)
        if (!cancelled) setGenError(messageForUser(err))
      })
    return () => { cancelled = true }
  }, [qrValue])

  // @@@445 数组 prop 转稳定 key 当 effect 依赖,避免每次渲染新引用触发重画。
  // 用 JSON.stringify(非 join('|')):URL 含字面 '|' 时 split round-trip 会损坏。直接把数组传给 canvas。
  const memberKey = JSON.stringify(memberAvatarUrls ?? [])

  // Step 2: Composite poster once QR is ready
  useEffect(() => {
    if (!qrDataUrl) return
    let cancelled = false
    setGenerating(true)
    setGenError(null)
    // 从 memberKey(JSON) 反序列化,使 effect 只依赖 primitive memberKey、不依赖每渲染新引用的数组。
    const members = JSON.parse(memberKey) as Array<string | null>
    createSharePosterCanvas({
      title,
      subtitle,
      qrDataUrl,
      memberAvatarUrls: members.length ? members : undefined,
      totalMemberCount,
      qrCaption: qrCaption ?? t('sharing.scanToJoinGugu'),
      ctaText: ctaText ?? t('sharing.connectCta'),
    })
      .then((canvas) => {
        if (cancelled) return
        posterCanvasRef.current = canvas
        setPosterDataUrl(canvas.toDataURL('image/png'))
      })
      .catch((err) => {
        // @@@445 fail-loud:生成失败显式提示用户(别静默吞→空白海报让人以为成功)。
        console.error('[SharePosterDialog] poster gen error', err)
        if (!cancelled) setGenError(messageForUser(err))
      })
      .finally(() => { if (!cancelled) setGenerating(false) })
    return () => { cancelled = true }
  }, [qrDataUrl, title, subtitle, memberKey, totalMemberCount, qrCaption, ctaText, t])

  const handleCopy = useCallback(async () => {
    const canvas = posterCanvasRef.current
    if (!canvas) return
    setCopyState('copying')
    try {
      await copyPosterToClipboard(canvas)
      setCopyState('copied')
      setTimeout(() => setCopyState(null), 2000)
    } catch (error) {
      const reason = String((error as Error)?.message ?? error)
      rendererLogger('clipboard').error({ error: reason }, 'copy poster failed')
      setCopyState(safeFailureLine(reason))
    }
  }, [])

  const handleDownload = useCallback(() => {
    const canvas = posterCanvasRef.current
    if (!canvas) return
    downloadPoster(canvas, 'gugu-share.png')
    setDownloadDone(true)
    setTimeout(() => setDownloadDone(false), 2000)
  }, [])

  const copyLabel = copyState === 'copying' ? t('sharing.copying')
    : copyState === 'copied' ? t('sharing.copied')
    : copyState ?? t('sharing.copyImage')

  return (
    <Sheet
      onClose={onClose}
      desktopWidth="min(400px, 100%)"
      desktopMaxHeight="calc(100dvh - 32px)"
      ariaLabel={t('sharing.posterTitle')}
      // @@@1862 — 此对话框常从成员资料弹层(MemberProfilePopover, --z-popover)里打开。Sheet 默认
      // --z-modal < --z-popover,弹层会盖住对话框并拦截「下载图片」的点击。用 --z-modal-top 盖住残留弹层。
      zIndex="var(--z-modal-top)"
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          flex: 1,
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '14px 16px',
            borderBottom: '1px solid var(--border-color)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 'var(--font-title)', fontWeight: 600, color: 'var(--text-primary)' }}>
            {t('sharing.posterTitle')}
          </span>
          <button
            onClick={onClose}
            aria-label={t('sharing.closePoster')}
            // @@@2322 关闭钮走规范 gg-ghost(data-tone=strong):rest 色 --muted-fg ≡ 原 --text-secondary
            // (明暗两主题同值),补上缺失的 hover/press 反馈(spec:缺态=bug)。
            className="gg-ghost"
            data-tone="strong"
            style={{
              fontSize: 18,
              lineHeight: 1,
              padding: '0 4px',
            }}
          >
            ×
          </button>
        </div>

        {/* Poster preview */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            padding: '20px 20px 8px',
            gap: 12,
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 360,
              aspectRatio: '3 / 4',
              background: 'var(--bg-elevated)',
              borderRadius: 'var(--radius-xl)',
              border: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            {genError ? (
              <span style={{ fontSize: 'var(--font-body)', color: 'var(--danger-fg)', textAlign: 'center', padding: '0 16px' }}>
                {genError}
              </span>
            ) : generating || !posterDataUrl ? (
              <span style={{ fontSize: 'var(--font-body)', color: 'var(--text-tertiary)' }}>
                {generating ? t('sharing.generatingPoster') : t('sharing.generatingQr')}
              </span>
            ) : (
              <img
                src={posterDataUrl}
                alt={t('sharing.posterTitle')}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            )}
          </div>

        </div>

        {/* Footer actions */}
        <div
          style={{
            padding: '12px 16px 16px',
            borderTop: '1px solid var(--border-color)',
            display: 'flex',
            gap: 8,
            flexShrink: 0,
          }}
        >
          <button
            onClick={handleCopy}
            disabled={!posterDataUrl || copyState === 'copying'}
            style={{
              flex: 1,
              height: 36,
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-control)',
              background: copyState === 'copied' ? 'var(--bg-accent-soft)' : 'var(--bg-elevated)',
              color: copyState === 'copied' ? 'var(--accent)' : 'var(--text-primary)',
              fontSize: 'var(--font-body)',
              fontWeight: 500,
              cursor: posterDataUrl && copyState !== 'copying' ? 'pointer' : 'default',
              transition: 'background var(--transition-fast)',
            }}
          >
            {copyLabel}
          </button>
          <button
            onClick={handleDownload}
            disabled={!posterDataUrl}
            style={{
              flex: 1,
              height: 36,
              border: 'none',
              borderRadius: 'var(--radius-control)',
              // 2026-09-22 按 design.md 统一:「已下载」不是一个 live 态,而这抹硬编码橙
              // 与公开落地页那套是同一个第二 accent(A-06)。完成态改由 --ok 这个语义色承担,
              // 底色不再另起一个色系。
              background: downloadDone ? 'var(--ok)' : 'var(--accent)',
              color: downloadDone ? 'var(--color-white)' : 'var(--text-on-accent)',
              fontSize: 'var(--font-body)',
              fontWeight: 500,
              cursor: posterDataUrl ? 'pointer' : 'default',
              transition: 'background var(--transition-fast)',
            }}
          >
            {downloadDone ? t('sharing.downloaded') : t('sharing.downloadImage')}
          </button>
        </div>
      </div>
    </Sheet>
  )
}
