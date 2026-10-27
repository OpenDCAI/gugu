import { rendererLogger } from '@/lib/log'
import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'
/**
 * AgentSharePane — "分享" pane (data-aset="share-act")
 *
 * Per design (share-act).
 * The design clicks "share-act" tab to open the standalone #share-scrim modal.
 * In the gugu pane architecture this content is embedded inside the modal body.
 *
 * Backend wired:
 *   - shareAgentWithFriends           ← 给好友发入群邀请(#6524,与 MCP contact_friend 同一条链)
 *   - useContactsStore().contacts       ← real contacts list, wired
 *   - useAuth().user                    ← real current user, wired
 *
 * 对外分享 tab (external public link / QR) — wired (#1078, #1085):
 *   - 真链接 buildAgentShareUrl(/join/agent/<id>) + 真 QR；未配置公开基址 → fail-loud（不出死链接）。
 *   - 「开启对外分享」→ contactsService.setAgentPublic (RLS select_public 放行外部读取)。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import QRCode from 'qrcode'
import type { AgentSettingsPaneProps } from './types'
import { useContactsStore } from '../../store/contactsContext'
import { useAuth } from '../../store/auth'
import { describeAgentShare, shareAgentWithFriends } from '../../lib/agentShare'
import { contactsService } from '../../lib/contacts'
import { externalShareBaseUrl, buildAgentShareUrl } from './agentShareUrl'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { asClass, cx, shareSegmentButtonClass } from './agentSettingsStyles'
import { Avatar } from '../Avatar'
import { SearchField } from '../ui/SearchField'

// ─── helpers ─────────────────────────────────────────────────────────────────

function resolvedName(c: ContactUser): string {
  return c.alias?.trim() || c.display_name
}

// ─── sub-components ──────────────────────────────────────────────────────────

/** 转发给联系人 tab content */
function FwdPanel({
  contacts,
  agent,
  ownerName
}: {
  contacts: ContactUser[]
  agent: ContactUser
  ownerName: string
}) {
  const { t } = useTranslation('agents')
  const { t: ct, i18n } = useTranslation('contacts')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const normalizedQuery = query.trim().toLowerCase()
  const visible = useMemo(() => {
    if (!normalizedQuery) return contacts
    return contacts.filter((c) =>
      [resolvedName(c), c.display_name, c.alias ?? '', c.email ?? '']
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery)
    )
  }, [contacts, normalizedQuery])

  const handleRowClick = useCallback(
    async (contact: ContactUser) => {
      if (busy) return
      setError(null)
      setDone(null)
      setBusy(true)
      try {
        const outcomes = await shareAgentWithFriends(
          agent.id,
          [contact.id],
          ct('inviteAgent.invitationNote', { owner: ownerName, agent: agent.display_name })
        )
        const report = describeAgentShare(outcomes, () => resolvedName(contact), ct, i18n.language)
        setDone(report.done.join(' ') || null)
        setError(report.problem)
      } finally {
        setBusy(false)
      }
    },
    [agent.display_name, agent.id, busy, ct, i18n.language, ownerName]
  )

  return (
    <div className={asClass.shareFwd}>
      {/* search: .search style="margin:0 0 6px;background:var(--muted)" */}
      <SearchField
        className={asClass.shareSearch}
        placeholder={t('settings.share.search')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {/* list: max-height:260px overflow:auto */}
      <div className={asClass.shareList}>
        {visible.length === 0 && (
          <div className={asClass.shareEmpty}>{t('settings.share.noContacts')}</div>
        )}
        {visible.map((contact) => (
          <div
            key={contact.id}
            className={asClass.shareRow}
            onClick={() => { void handleRowClick(contact) }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') void handleRowClick(contact) }}
          >
            <Avatar name={resolvedName(contact)} avatarUrl={contact.avatar} seed={contact.id} size="sm" />
            <span className={asClass.shareRowName}>{resolvedName(contact)}</span>
          </div>
        ))}
      </div>

      {error && <div role="alert" className={asClass.shareError}>{error}</div>}
      {done && !busy && <div role="status" className={asClass.shareBusy}>{done}</div>}
      {busy && <div className={asClass.shareBusy}>{t('settings.share.forwarding')}</div>}
    </div>
  )
}

/** 对外分享 tab content — 设计稿 lines 1084-1088。
 *  真链接(指向现有 /join/agent 公开路由)+ 真 QR + 开启时 setAgentPublic(真使 agent 公开,RLS select_public
 *  据此放行外部读取)。未配置公开基址时不提供对外分享入口。 */
export function ExtPanel({ agent }: { agent: ContactUser }) {
  const { t } = useTranslation('agents')
  const shareUrl = buildAgentShareUrl(externalShareBaseUrl(), agent.id)
  const [qr, setQr] = useState<string | null>(null)
  const [isPublic, setIsPublic] = useState(agent.agent_public === true)
  const [enabling, setEnabling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!shareUrl) { setQr(null); return }
    let cancelled = false
    QRCode.toDataURL(shareUrl, { width: 132, margin: 1, color: { dark: '#1f2933', light: '#ffffff' } })
      .then((url) => { if (!cancelled) setQr(url) })
      .catch(() => { if (!cancelled) setQr(null) })
    return () => { cancelled = true }
  }, [shareUrl])

  const handleEnable = useCallback(async () => {
    if (enabling) return
    setEnabling(true)
    setError(null)
    try {
      // 真动作:使 agent 公开 → 公开链接据 RLS select_public 可被外部读取。
      await contactsService.setAgentPublic(agent.id, true)
      setIsPublic(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.share.enableFailed'))
    } finally {
      setEnabling(false)
    }
  }, [agent.id, enabling, t])

  const handleCopy = useCallback(async () => {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setError(null)
      setTimeout(() => setCopied(false), 1800)
    } catch (error) {
      const reason = String((error as Error)?.message ?? error)
      rendererLogger('clipboard').error({ error: reason }, 'copy agent link failed')
      setError(safeFailureLine(reason))
    }
  }, [shareUrl])

  if (!shareUrl) return null

  const qrElement = qr
    ? <img className={cx(asClass.shareQr, asClass.shareQrImage)} src={qr} alt={t('settings.share.qrAlt')} />
    : <div className={asClass.shareQr} />

  return (
    <div className={asClass.shareExt}>
      {/* .se-card — 设计稿 line 367;占位 QR 换成真二维码 */}
      <div className={asClass.shareExtCard}>
        {qrElement}
        <div style={{ fontSize: 'var(--font-body)', fontWeight: 600 }}>{t('settings.share.open')}</div>
        <div style={{ fontSize: 'var(--font-body)', color: 'var(--faint-fg)', marginTop: 3 }}>
          {t('settings.share.openHint')}
        </div>
      </div>
      {/* .se-link — 设计稿 line 369;真链接指向 /join/agent 公开路由。
          明文链接 user-select:text — 复制失败时(#1124)用户可手动选中复制（fail-loud 回退）。 */}
      <div className={asClass.shareLink}>
        <span data-testid="agent-share-link" style={{ userSelect: 'text' }}>{shareUrl}</span>
        <button
          type="button"
          className={asClass.shareCopy}
          onClick={() => { void handleCopy() }}
        >
          {copied ? t('settings.share.copied') : t('settings.share.copy')}
        </button>
      </div>
      {!isPublic && (
        <button
          type="button"
          className={asClass.shareEnable}
          onClick={() => { void handleEnable() }}
          disabled={enabling}
        >
          {enabling ? t('settings.share.enabling') : t('settings.share.enable')}
        </button>
      )}
      {error && <div className={asClass.shareError}>{error}</div>}
    </div>
  )
}

// ─── main pane ───────────────────────────────────────────────────────────────

export function AgentSharePane({ agent, onClose: _onClose }: AgentSettingsPaneProps) {
  const { t } = useTranslation('agents')
  const { contacts } = useContactsStore()
  const { user } = useAuth()

  // Tab state: 'fwd' | 'ext'
  const [tab, setTab] = useState<'fwd' | 'ext'>('fwd')
  const canShareExternally = !!buildAgentShareUrl(externalShareBaseUrl(), agent.id)

  // Only show human contacts (not agents) for forwarding — filter same as ContactsPanel
  const humanContacts = useMemo(
    () => contacts.filter((c) => c.id !== agent.id && c.type !== 'agent'),
    [contacts, agent.id]
  )

  return (
    <div className={asClass.shareRoot}>
      {/* h3: "分享 Agent" */}
      <h3 className={asClass.shareTitle}>{t('settings.share.title')}</h3>

      {/* .share-seg */}
      <div className={asClass.shareSegment}>
        <button
          type="button"
          className={shareSegmentButtonClass(tab === 'fwd')}
          onClick={() => setTab('fwd')}
        >
          {t('settings.share.forward')}
        </button>
        {canShareExternally && (        <button
          type="button"
          className={shareSegmentButtonClass(tab === 'ext')}
          onClick={() => setTab('ext')}
        >
          {t('settings.share.external')}
        </button>
        )}
      </div>

      {/* panels */}
      {tab === 'fwd' && user && (
        <FwdPanel
          contacts={humanContacts}
          agent={agent}
          ownerName={user.nickname}
        />
      )}
      {canShareExternally && tab === 'ext' && (
        <ExtPanel agent={agent} />
      )}
    </div>
  )
}
