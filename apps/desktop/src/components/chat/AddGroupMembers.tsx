import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { chatService } from '../../lib/chat'
import { type AgentJoinRequestStatus } from '../../lib/groupAgentJoin'
import { MEMBER_PICKER_SHEET, MemberPicker } from '../member-picker/MemberPicker'
import { Sheet } from '../ui/Sheet'

const reasonOf = (error: unknown) => String((error as Error)?.message ?? error)

// 群里「添加成员」= 与新建群聊同一个选择器;已在群里的勾着、不能取消。人与 Agent 走同一个 inviteGroupMember:
// 关系内的直接加入,其余发邀请,需审批的群里 Agent 落一条待审请求。成功的从候选里变成「已在群里」,失败的留在已选里重试。
export function AddGroupMembers({ chatId, snapshot, canInviteHumans, humanDeniedHint, onClose, onReload }: {
  chatId: string
  snapshot: GroupCollabSnapshot
  canInviteHumans: boolean
  /** 不能邀请人类时那一页说的话;不给 = 权限不够那一句(项目群有自己的原因)。 */
  humanDeniedHint?: string
  onClose: () => void
  onReload: () => Promise<void>
}) {
  const { t } = useTranslation('messaging')
  const members = useMemo(() => new Set([...snapshot.humans.map((h) => h.id), ...snapshot.agents.map((a) => a.id)]), [snapshot.agents, snapshot.humans])
  const [requests, setRequests] = useState<Map<string, AgentJoinRequestStatus>>(new Map())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const reloadRequests = useCallback(async () => { setRequests(await chatService.listMyAgentJoinRequests(chatId)) }, [chatId])
  useEffect(() => { reloadRequests().catch((err: unknown) => setError(reasonOf(err))) }, [reloadRequests])

  const add = async (ids: string[]): Promise<string[] | void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const results = await Promise.allSettled(ids.map((id) => chatService.inviteGroupMember(chatId, id)))
      await onReload()
      const failed = ids.filter((_, i) => results[i].status === 'rejected')
      const pendingApproval = results.filter((r) => r.status === 'fulfilled' && r.value.status === 'pending_approval').length
      const invited = results.filter((r) => r.status === 'fulfilled' && r.value.status === 'pending').length
      if (pendingApproval > 0) await reloadRequests().catch(() => undefined)
      setNotice([
        pendingApproval > 0 ? t('group.picker.pendingApproval', { count: pendingApproval }) : '',
        invited > 0 ? t('group.picker.invitationSent', { count: invited }) : '',
      ].filter(Boolean).join(' ') || null)
      if (failed.length === 0) {
        if (pendingApproval === 0 && invited === 0) onClose()
        return []
      }
      const reason = reasonOf((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)
      const succeeded = ids.length - failed.length
      setError(succeeded > 0
        ? t('group.picker.partialFailure', { succeeded, failed: failed.length, reason })
        : t('group.picker.allFailed', { failed: failed.length, reason }))
      return failed
    } catch (err) {
      setError(reasonOf(err))
    } finally {
      setBusy(false)
    }
  }

  const agentNote = (id: string) => requests.get(id) === 'pending' ? t('group.picker.agentRequestPending')
    : requests.get(id) === 'rejected' ? t('group.picker.agentRequestRejected') : undefined

  return (
    <Sheet onClose={onClose} {...MEMBER_PICKER_SHEET} ariaLabel={t('group.picker.title')}>
      <MemberPicker
        title={t('group.picker.title')}
        confirmLabel={(count) => (count > 0 ? t('group.picker.addWithCount', { count }) : t('group.picker.add'))}
        busy={busy}
        busyLabel={t('group.picker.adding')}
        lockedIds={members}
        peopleDenied={canInviteHumans ? undefined : humanDeniedHint ?? t('group.picker.humanPermissionHint')}
        agentNote={agentNote}
        footer={error || notice ? (
          <p role={error ? 'alert' : 'status'} className={error ? '!m-0 !px-5 !py-2 text-[length:var(--font-caption)] text-[var(--danger)]' : '!m-0 !px-5 !py-2 text-[length:var(--font-caption)] text-[var(--text-secondary)]'}>{error ?? notice}</p>
        ) : null}
        onConfirm={add}
        onClose={onClose}
      />
    </Sheet>
  )
}
