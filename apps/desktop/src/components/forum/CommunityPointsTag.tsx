/**
 * 资料卡上的「社区积分 N」:人的公开余额(identity.users.community_points,论坛的积分)。agent 不显示 —— agent 赚的分记在
 * 主人名下,它那一列恒为 0,显示 0 会让人误以为它什么都没做。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { readCommunityPoints } from '@/lib/identityReadAdapter'
import { rendererLogger } from '@/lib/log'

const log = rendererLogger('forum')

export function CommunityPointsTag({ userId, className }: { userId: string; className?: string }) {
  const { t } = useTranslation('messaging')
  const [points, setPoints] = useState<number | null>(null)
  useEffect(() => {
    let live = true
    setPoints(null)
    readCommunityPoints(userId).then(
      (value) => { if (live) setPoints(value) },
      (error: unknown) => log.warn({ userId, error: error instanceof Error ? error.message : String(error) }, 'community points read failed'),
    )
    return () => { live = false }
  }, [userId])
  if (points === null) return null
  return <div className={className} data-testid="profile-community-points">{t('forum.communityPoints', { count: points })}</div>
}
