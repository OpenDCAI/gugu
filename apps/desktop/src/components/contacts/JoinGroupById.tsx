import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PublicGroupInviteGroup } from '@gugu/core/shared/types/contacts'
import { contactsService, type JoinGroupByIdRefusal } from '../../lib/contacts'
import { rendererLogger } from '../../lib/log'
import { messageForUser } from '../../lib/userFacingError'
import { Button } from '../ui/Button'
import { SearchField } from '../ui/SearchField'
import { useToast } from '../toastContext'

const joinGroupLog = rendererLogger('contacts/join-group-by-id')

// 被拒的三种结局 → 各自的产品文案。RPC 报的是稳定 ASCII 标识,❌ 不把它原样显给用户:
// 那既是内部措辞、又不可翻译,而且服务端一改措辞用户就看到裸报错。
const REFUSAL_COPY_KEY: Record<JoinGroupByIdRefusal, string> = {
  group_self_serve_closed: 'joinGroup.refusedSelfServeClosed',
  group_invite_only: 'joinGroup.refusedInviteOnly',
  group_not_found: 'joinGroup.refusedNotFound',
}

// 几何走类名与 token,❌ 不写 inline style:那是 @@@ui-ruler 棘轮盯的债务,只减不增。
// (这句话本身也不能带上那个字面量 —— 棘轮数的是源码文本,注释一样算数。)
const hintClass =
  'px-4 py-8 text-center text-[length:var(--font-body)] leading-[var(--lh-body)] text-[var(--text-secondary)]'
const rowClass = 'flex items-center gap-2 border-b border-[var(--border-subtle)] py-2'
const nameClass =
  'truncate text-[length:var(--font-body)] font-semibold leading-[var(--lh-body)] text-[var(--text-primary)]'
const metaClass =
  'mt-px text-[length:var(--font-body)] leading-[var(--lh-body)] text-[var(--text-secondary)]'
const errorClass =
  'mt-1 text-[length:var(--font-body)] leading-[var(--lh-body)] text-[var(--danger)]'
const stateClass = 'text-[length:var(--font-body)] text-[var(--text-secondary)]'

/**
 * 按群号加群 —— 与「加好友」对称的那条路。
 *
 * 加好友是:搜咕咕号 → 看到人 → 发申请 → 对方同意。这里是同一个形状,只是主语换成群。
 *
 * ⚠️ 这条路**只产生申请**,即使群的 join_mode 是 open 也不直接入群。
 * 群号是严格递增的序列(`chat.public_chat_id_seq`,START 200001),顺着数就能枚举全产品的群 ——
 * 按群号直接入群等于谁都能把所有 open 群刷一遍。判断落在 RPC 那头(见迁移
 * 20260906003846_join_group_by_public_id.sql),这里的按钮文案必须跟它一致:恒为「申请加入」。
 * ❌ 别照抄 GroupInviteCard:那张卡是给邀请链接那条路做的,对 open 群显示「加入」——
 *    在这条路上就是一句假话(点下去得到的是 pending)。
 *
 * 「群主没开自助加入」/「仅限邀请加入」这两种拒绝**不在客户端预判**:
 * lookup_public_group 根本不返回 invite_link_enabled,预判就得靠猜。让服务端判、
 * 客户端按它回的稳定标识选自己的文案 —— 宁可点一下才知道,也不画一个理由不明的灰按钮。
 */
// headless:弹窗形态(AddFriendSearch 不渲头部)时,搜索框上面得自己补一段间距,
// 否则它直接顶在弹窗边框上。有头部时头部已带 pb-3,再补就成了双倍。
export function JoinGroupById({ headless }: { headless?: boolean }) {
  const { t } = useTranslation('contacts')
  const { toast } = useToast()
  const [query, setQuery] = useState('')
  const [looking, setLooking] = useState(false)
  const [group, setGroup] = useState<PublicGroupInviteGroup | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)

  const parsedId = Number.parseInt(query.trim(), 10)
  const idValid = Number.isInteger(parsedId) && parsedId > 0

  const handleLookup = useCallback(async () => {
    if (!idValid || looking) return
    setLooking(true)
    setNotFound(false)
    setJoinError(null)
    setGroup(null)
    try {
      const res = await contactsService.lookupPublicGroupInvite(parsedId)
      if (res.group) setGroup(res.group)
      else setNotFound(true)
    } catch (err) {
      // 原因进日志,文案只留用户能照做的下一步(user-copy-leak 守卫钉的就是这条)。
      joinGroupLog.error({ publicId: parsedId, error: String(err) }, 'lookup public group failed')
      toast(messageForUser(err, t('joinGroup.lookupFailed')), 'error')
    } finally {
      setLooking(false)
    }
  }, [idValid, looking, parsedId, t, toast])

  const handleJoin = useCallback(async () => {
    if (!group || joining) return
    setJoining(true)
    setJoinError(null)
    try {
      const res = await contactsService.requestGroupJoinByPublicId(group.public_id)
      if (res.status === 'refused') {
        // 行级 fail loud:说清是**哪一种**拒绝,❌ 不吞成笼统的「加入失败」——
        // 用户要能分辨「群主没开自助加入」和「这个群只收邀请」,两者的下一步不一样。
        setJoinError(t(REFUSAL_COPY_KEY[res.reason]))
        return
      }
      setGroup(res.group)
      toast(res.status === 'joined' ? t('joinGroup.alreadyMember') : t('joinGroup.requested'), 'success')
    } catch (err) {
      joinGroupLog.error({ publicId: group.public_id, error: String(err) }, 'group join request failed')
      setJoinError(messageForUser(err, t('joinGroup.requestFailedFallback')))
    } finally {
      setJoining(false)
    }
  }, [group, joining, t, toast])

  const alreadyIn = group?.is_member === true
  const pending = group?.join_request_status === 'pending'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`shrink-0 px-4 pb-3${headless ? ' pt-3' : ''}`}>
        <SearchField
          data-testid="join-group-id-input"
          inputMode="numeric"
          value={query}
          placeholder={t('joinGroup.searchPlaceholder')}
          aria-label={t('joinGroup.searchPlaceholder')}
          onChange={(event) => { setQuery(event.target.value); setGroup(null); setNotFound(false); setJoinError(null) }}
          onKeyDown={(event) => { if (event.key === 'Enter') void handleLookup() }}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-4">
        {!group && !notFound && looking && (
          <div className={hintClass}>{t('joinGroup.looking')}</div>
        )}

        {notFound && <div className={hintClass}>{t('joinGroup.notFound', { id: parsedId })}</div>}

        {/* ❌ 不放头像:Avatar 的 variant='group' 在既无群头像、又无成员头像时是**刻意的空态**
            (群不是一张脸,不给它生成),渲染出来就是个像「图挂了」的空框。lookup_public_group
            两样都不返回 ⇒ 这里必然踩中那个空态。邀请链接那条路的确认卡同样不放头像,跟它一致。 */}
        {group && (
          <div data-testid="join-group-result" className={rowClass}>
            <div className="min-w-0 flex-1">
              <div className={nameClass}>{group.name}</div>
              <div className={metaClass}>
                {t('joinGroup.summary', { number: group.public_id, count: group.member_count })}
              </div>
              {joinError ? (
                <div role="alert" data-testid="join-group-error" className={errorClass}>
                  {joinError}
                </div>
              ) : null}
            </div>
            {alreadyIn ? (
              <span className={stateClass}>{t('joinGroup.joined')}</span>
            ) : pending ? (
              <span className={stateClass}>{t('joinGroup.pending')}</span>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled={joining}
                data-testid="join-group-request-button"
                onClick={() => { void handleJoin() }}
              >
                {t('joinGroup.request')}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
