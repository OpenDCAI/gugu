import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { PublicGroupInviteGroup, PublicGroupInviteLookupResult } from '@gugu/core/shared/types/contacts'
import { GroupInviteCard } from '../groups/GroupInviteCard'
import { contactsService } from '../../lib/contacts'
import { splitGuguLinkSegments } from '../../lib/guguLinkScan'
import { useGroupInviteJoin } from '../../lib/groupInviteJoin'

function MomentGroupInvite({ publicId, joinToken }: { publicId: number; joinToken?: string }) {
  const { t } = useTranslation('discover')
  const [lookup, setLookup] = useState<PublicGroupInviteLookupResult | null>(null)
  const [loading, setLoading] = useState(true)
  const { joining, joinError, join, reset } = useGroupInviteJoin()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLookup(null)
    reset()
    void contactsService.lookupPublicGroupInvite(publicId)
      .then((result) => { if (!cancelled) setLookup(result) })
      .catch(() => { if (!cancelled) setLookup({ status: 'lookup_error', group: null }) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [publicId, reset])

  const handleJoin = useCallback(async (group: PublicGroupInviteGroup) => {
    if (!joinToken || joining) return
    try {
      const result = await join(group, joinToken)
      setLookup({ status: result.status === 'joined' ? 'joined' : 'available', group: result.group })
    } catch {
      // The shared join hook owns localized failure state and logging.
    }
  }, [join, joining, joinToken])

  if (loading) {
    return <div className="gg-moment-link-state" role="status">{t('moments.groupLoading')}</div>
  }
  if (!lookup?.group) {
    return (
      <div className="gg-moment-link-state" role={lookup?.status === 'lookup_error' ? 'alert' : 'status'}>
        {lookup?.status === 'lookup_error' ? t('moments.groupLoadFailed') : t('moments.groupUnavailable')}
      </div>
    )
  }
  const group = lookup.group

  return (
    <GroupInviteCard
      group={group}
      density="inline"
      joinTokenAvailable={joinToken != null}
      joining={joining}
      joinError={joinError}
      onJoin={joinToken ? () => { void handleJoin(group) } : undefined}
      className="gg-moment-group-card"
    />
  )
}

export function MomentLinkContent({
  content,
  className = '',
  renderText,
}: {
  content: string
  className?: string
  renderText?: (text: string, key: string) => ReactNode
}) {
  const segments = splitGuguLinkSegments(content)
  return (
    <div className={`gg-moment-richtext ${className}`.trim()}>
      {segments.map((segment) => {
        if (segment.kind === 'text' || segment.route.nav !== 'group_join') {
          const text = segment.kind === 'text' ? segment.text : segment.raw
          const key = `${segment.start}:${segment.end}`
          return renderText
            ? renderText(text, key)
            : <span className="gg-moment-text-segment" key={key}>{text}</span>
        }
        return (
          <MomentGroupInvite
            key={`${segment.start}:${segment.end}`}
            publicId={segment.route.publicId}
            joinToken={segment.route.joinToken}
          />
        )
      })}
    </div>
  )
}
