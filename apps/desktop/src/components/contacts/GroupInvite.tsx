/**
 * 群邀请一族 —— 从 ContactsPanel 抽出。
 *
 * 这五个组件（二维码分享 / 加群确认 / 公开群邀请行 / 群号搜索结果 / 加群弹层）
 * 共享同一件事：拿群号或邀请链接把人带进群。它们在 ContactsPanel 里分散在两处、
 * 相隔近两千行，中间隔着联系人详情、标签编辑、群聊详情等毫不相干的东西。
 * 放在一起既是内聚，也让 ContactsPanel 少背 500 行（该文件行数被 CI 冻结，只能减）。
 *
 * 视觉复用共享控件和字阶；二维码载荷、查询与入群流程留在原来的链路。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import * as QRCode from 'qrcode'
import { Copy, QrCode, X } from '@/lib/icons'
import type {
  ContactGroupChat,
  PublicGroupInviteGroup,
  PublicGroupInviteLookupResult,
} from '@gugu/core/shared/types/contacts'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { chatService } from '../../lib/chat'
import { contactsService } from '../../lib/contacts'
import { buildGroupInviteShareUrl } from '../../lib/groupInviteShareUrl'
import { useGroupInviteJoin } from '../../lib/groupInviteJoin'
import { canWriteImageToClipboard, writeImageBlobToClipboard } from '../../lib/imageClipboard'
import { GroupInviteCard } from '../groups/GroupInviteCard'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { useToast } from '../toastContext'
import { Sheet } from '../ui/Sheet'
import { downloadDataUrl } from './downloadDataUrl'
import { useTranslation } from 'react-i18next'

export function GroupInviteQrShare({ group }: { group: ContactGroupChat }) {
  const { t } = useTranslation('contacts')
  const { toast } = useToast()
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrError, setQrError] = useState<string | null>(null)
  const [joinToken, setJoinToken] = useState<string | null>(null)

  const publicId = group.public_id
  // Only groups with a 群号 can expose an invite QR (channels and number-less groups never do).
  const hasGroupNumber = group.kind === 'group' && typeof publicId === 'number' && Number.isInteger(publicId) && publicId > 0

  // @@@direct-join (#653) - the shareable QR must embed the group's invite token so a scan joins
  useEffect(() => {
    if (!hasGroupNumber) {
      setJoinToken(null)
      return
    }
    let cancelled = false
    chatService.getGroupChatSettings(group.id)
      .then((settings) => {
        if (!cancelled) setJoinToken(settings.join_token ?? null)
      })
      .catch((error) => {
        console.error('[ContactsPanel] group invite token fetch failed', error)
        if (!cancelled) {
          setJoinToken(null)
          setQrError(t('sharing.qrFailed'))
        }
      })
    return () => {
      cancelled = true
    }
  }, [group.id, hasGroupNumber, t])

  const payloadText = useMemo(() => {
    if (!hasGroupNumber || !joinToken) return null
    return buildGroupInviteShareUrl(publicId as number, joinToken)
  }, [hasGroupNumber, publicId, joinToken])

  useEffect(() => {
    if (!payloadText) {
      setQrDataUrl(null)
      setQrError(null)
      return
    }
    let cancelled = false
    QRCode.toDataURL(payloadText, {
      width: 132,
      margin: 1,
      color: {
        dark: '#1f2933',
        light: '#ffffff'
      }
    })
      .then((dataUrl) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl)
          setQrError(null)
        }
      })
      .catch((error) => {
        console.error('[ContactsPanel] group invite QR generation failed', error)
        if (!cancelled) {
          setQrDataUrl(null)
          setQrError(t('sharing.qrFailed'))
        }
      })
    return () => {
      cancelled = true
    }
  }, [payloadText, t])

  // @@@qr-share-as-image - "复制二维码内容" used to copy the QR payload as a TEXT LINK, which is
  const handleCopy = useCallback(async () => {
    if (!payloadText) return
    try {
      const dataUrl = await QRCode.toDataURL(payloadText, {
        width: 480,
        margin: 2,
        color: { dark: '#1f2933', light: '#ffffff' }
      })
      const blob = await (await fetch(dataUrl)).blob()
      const safeName = t('groupInvite.qrFileName', {
        name: (group.name || t('groupInvite.groupFallback')).replace(/[\\/:*?"<>|]+/g, '_'),
      })
      if (canWriteImageToClipboard()) {
        try {
          await writeImageBlobToClipboard(blob) // blob-first 约束(#1892)收口在 lib/imageClipboard
          toast(t('groupInvite.qrCopied'), 'success')
          return
        } catch { /* clipboard write rejected (permissions) → fall back to download below */ }
      }
      downloadDataUrl(dataUrl, safeName)
      toast(t('groupInvite.qrSaved'), 'success')
    } catch (error) {
      toast(t('groupInvite.qrExportFailed'), 'error')
      console.error('QR image export failed:', error)
    }
  }, [payloadText, group.name, t, toast])

  // Channels and number-less groups never expose a join QR; groups with a 群号 always render the
  // section (token loads async, and a fetch failure must surface as an error rather than silently
  // hiding the QR).
  if (!hasGroupNumber) return null

  return (
    <section style={{ padding: '16px 0 0' }}>
      <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', marginBottom: 8 }}>{t('groupInvite.qrTitle')}</div>
      <div
        style={{
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-surface)',
          background: 'var(--input-bg)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: 12,
          maxWidth: 420
        }}
      >
        <div
          style={{
            width: 132,
            height: 132,
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-control)',
            background: 'var(--color-white)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            overflow: 'hidden'
          }}
        >
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={t('groupInvite.qrAlt', { name: group.name })}
              style={{ width: 132, height: 132, display: 'block' }}
            />
          ) : (
            <QrCode size={42} color="var(--text-tertiary)" aria-hidden="true" />
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              color: 'var(--text-primary)',
              fontSize: 'var(--font-body)',
              fontWeight: 600,
              lineHeight: 'var(--lh-body)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {t('groupInvite.qrAlt', { name: group.name })}
          </div>
          <div
            style={{
              color: qrError ? 'var(--error)' : 'var(--text-secondary)',
              fontSize: qrError ? 'var(--font-body)' : 'var(--font-caption)',
              lineHeight: qrError ? 'var(--lh-body)' : 'var(--lh-caption)',
              marginTop: 4
            }}
          >
            {qrError ?? t('groupInvite.groupNumber', { number: group.public_id })}
          </div>
          <Button
            data-group-invite-qr-copy={group.id}
            data-qr-payload={payloadText ?? ''}
            onClick={handleCopy}
            disabled={!payloadText}
            className="mt-3"
          >
            <Copy size={12} />
            {t('groupInvite.copyQr')}
          </Button>
          {payloadText != null && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--radius-control)',
                padding: '8px 12px',
                marginTop: 8
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 'var(--font-body)',
                  lineHeight: 'var(--lh-body)',
                  color: 'var(--text-secondary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {payloadText}
              </span>
              <Button
                variant="primary"
                className="shrink-0"
                data-testid={AUTOMATION_TEST_IDS.groupInviteLinkCopyButton}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(payloadText)
                    toast(t('groupInvite.linkCopied'), 'success')
                  } catch {
                    toast(t('groupInvite.copyFailed'), 'error')
                  }
                }}
              >
                {t('groupInvite.copyLink')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

export function GroupJoinConfirmDialog({
  group,
  onConfirm,
  onCancel,
}: {
  group: Pick<PublicGroupInviteGroup, 'name' | 'public_id' | 'member_count' | 'join_mode'>
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation('contacts')
  // #855 — guard against a double-click double-join (the join RPC's `joining` guard reads a stale
  // closure on concurrent calls, so disable at the button on first confirm).
  const [submitting, setSubmitting] = useState(false)
  // @@@group-join-mode (#1018 step3 #858) — approval 群文案为「申请加入」+ 审批提示。
  const isApproval = group.join_mode === 'approval'
  return (
    <Sheet
      onClose={onCancel}
      desktopWidth="380px"
      testId={AUTOMATION_TEST_IDS.groupJoinConfirmDialog}
      ariaLabel={t('groupInvite.confirmTitle')}
    >
      <div
        style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, overflow: 'hidden' }}
      >
        <div style={{ padding: 20 }}>
          <div style={{ fontSize: 'var(--font-title)', lineHeight: 'var(--lh-title)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
            {isApproval ? t('groupInvite.requestTitle') : t('groupInvite.joinTitle')}
          </div>
          <div
            style={{
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-surface)',
              background: 'var(--bg-elevated)',
              padding: '12px 16px',
              display: 'flex',
              flexDirection: 'column',
              gap: 4
            }}
          >
            <div style={{ fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {group.name}
            </div>
            <div style={{ fontSize: 'var(--font-caption)', lineHeight: 'var(--lh-caption)', color: 'var(--text-secondary)' }}>
              {t('groupInvite.groupNumberHash', { number: group.public_id })}
            </div>
            <div style={{ fontSize: 'var(--font-caption)', lineHeight: 'var(--lh-caption)', color: 'var(--text-secondary)' }}>
              {t('groupInvite.memberCount', { count: group.member_count })}
            </div>
          </div>
          {isApproval ? (
            <div style={{ fontSize: 'var(--font-body)', color: 'var(--text-secondary)', marginTop: 8, lineHeight: 'var(--lh-body)' }}>
              {t('groupInvite.approvalHint')}
            </div>
          ) : null}
        </div>
        <div style={{ height: 56, borderTop: '1px solid var(--border-subtle)', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
          <Button
            onClick={onCancel}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            data-testid={AUTOMATION_TEST_IDS.groupJoinConfirmButton}
            disabled={submitting}
            onClick={() => { if (submitting) return; setSubmitting(true); onConfirm() }}
          >
            {isApproval ? t('groupInvite.requestJoin') : t('groupInvite.join')}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

function PublicGroupInviteRow({
  group,
  canJoin,
  joining,
  joinError,
  onJoin,
}: {
  group: PublicGroupInviteGroup
  canJoin: boolean
  joining: boolean
  joinError: string | null
  onJoin: () => void
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)

  return (
    <>
      <div style={{ padding: '0 10px' }}>
        <GroupInviteCard
          group={group}
          density="list"
          joinTokenAvailable={canJoin}
          joining={joining}
          joinError={joinError}
          onJoin={canJoin ? () => setConfirmOpen(true) : undefined}
        />
      </div>
      {confirmOpen && (
        <GroupJoinConfirmDialog
          group={group}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => { setConfirmOpen(false); onJoin() }}
        />
      )}
    </>
  )
}

function PublicGroupInviteSearchResult({
  lookup,
  canJoin,
  joining,
  joinError,
  onJoin,
}: {
  lookup: PublicGroupInviteLookupResult | null
  canJoin: boolean
  joining: boolean
  joinError: string | null
  onJoin: () => void
}) {
  const { t } = useTranslation('contacts')
  if (!lookup) return null
  if (lookup.status === 'lookup_error') {
    return <div style={{ padding: 16, color: 'var(--danger)', fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)' }}>{t('groupInvite.lookupFailed')}</div>
  }
  if (lookup.status === 'not_found' || !lookup.group) {
    return <div style={{ padding: 16, color: 'var(--text-secondary)', fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)' }}>{t('groupInvite.notFound')}</div>
  }
  return <PublicGroupInviteRow group={lookup.group} canJoin={canJoin} joining={joining} joinError={joinError} onJoin={onJoin} />
}

// @@@1169 (b) - token-gated group join via a scanned/pasted invite QR (a /join/:inviteCode route).
// This replaces the retired 数字群号 SEARCH entry: a foreign group is reachable only through its invite
// QR (which carries the unguessable join_token), driven by qrScanRoute's 'group_join' route — bypassing
// the (removed) 群号 search box, so sequential-号 enumeration is impossible.
export function GroupInviteJoinModal({
  publicId,
  joinToken,
  onClose,
}: {
  publicId: number
  joinToken?: string
  onClose: () => void
}) {
  const { t } = useTranslation('contacts')
  const [lookup, setLookup] = useState<PublicGroupInviteLookupResult | null>(null)
  const [loading, setLoading] = useState(true)
  const { joining, joinError, join, reset } = useGroupInviteJoin()

  useEffect(() => {
    let cancelled = false
    reset()
    setLoading(true)
    setLookup(null)
    contactsService.lookupPublicGroupInvite(publicId)
      .then((result) => { if (!cancelled) setLookup(result) })
      .catch((error) => {
        console.error('[ContactsPanel] public group lookup failed', error)
        if (!cancelled) setLookup({ status: 'lookup_error', group: null })
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [publicId, reset])

  const onJoin = useCallback(async () => {
    const group = lookup?.group
    if (!group || !joinToken || joining) return
    try {
      const result = await join(group, joinToken)
      setLookup({ status: result.status === 'joined' ? 'joined' : 'available', group: result.group })
      if (result.status === 'joined') onClose()
    } catch {
      // useGroupInviteJoin owns the localized error and logs the original failure.
    }
  }, [lookup?.group, joinToken, joining, join, onClose])

  return (
    <Sheet
      onClose={onClose}
      desktopWidth="380px"
      ariaLabel={t('groupInvite.joinTitle')}
    >
      <div
        style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, overflow: 'hidden' }}
      >
        <div style={{ padding: 16, borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 'var(--font-title)', lineHeight: 'var(--lh-title)', fontWeight: 600, color: 'var(--text-primary)' }}>{t('groupInvite.joinTitle')}</span>
          <IconButton aria-label={t('common.close')} onClick={onClose}><X size={16} /></IconButton>
        </div>
        {loading ? (
          <div style={{ padding: 16, color: 'var(--text-secondary)', fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)' }}>{t('groupInvite.lookingUp')}</div>
        ) : (
          <PublicGroupInviteSearchResult lookup={lookup} canJoin={joinToken != null} joining={joining} joinError={joinError} onJoin={onJoin} />
        )}
      </div>
    </Sheet>
  )
}
