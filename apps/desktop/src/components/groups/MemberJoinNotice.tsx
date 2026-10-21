// @@@6386 「X 加入了群聊」—— 群聊时间线中间那行灰字,名字点一下就在输入框里 @ 他。
//
// 数据在服务端落(chat_members 触发器,见 @gugu/core/shared/ui/memberJoinNotice),这里只负责画:
//   · 版式与 MessageBubble 的 content_type==='system' 同一套(居中、裸文字、caption、faint 色);
//   · 名字按成员**当前**的资料渲染(改过名跟着变),比灰字深一档;还在群里、不是自己的,是一颗行内按钮,
//     点了走 #518 的 mentionToInsert 通道 —— 插进去的是真路由 @,不是一段纯文本;
//   · 有任何一个入群者的资料解析不出(退了群又从没说过话,名册与消息窗口都没有他),整行退回服务端写的
//     纯文本:宁可不给点,也不拼一个「未知用户」出来。
import { Fragment, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { MemberProfileCardModel } from '../MemberProfileCard'
import { useAuth } from '../../store/auth'
import { Button } from '../ui/Button'

// 与 AgentFloodSystemNotice 的「全部撤回」同一个做法:真按钮(键盘可达),外形压成行内文字。
const MENTION_NAME_CLASS = 'gg-member-join-name inline h-auto min-h-0 w-auto border-0 bg-transparent p-0 align-baseline'
const NOTICE_ROW_STYLE: CSSProperties = { display: 'flex', justifyContent: 'center', padding: '6px 12px' }
const NOTICE_BODY_STYLE: CSSProperties = {
  maxWidth: '70%',
  padding: '2px 13px',
  color: 'var(--faint-fg)',
  fontSize: 'var(--font-caption)',
  lineHeight: 1.35,
  textAlign: 'center',
}

export type MentionTarget = { id: string; name: string }

export type MemberJoinNoticeProps = {
  userIds: string[]
  /** 服务端写的纯文本,资料不全时整行照它显示 */
  content: string
  memberProfiles: Record<string, MemberProfileCardModel>
  /** 不传 = 这个表面没有输入框(搜索结果等),名字只读 */
  onMention?: (target: MentionTarget) => void
}

export function MemberJoinNotice({ userIds, content, memberProfiles, onMention }: MemberJoinNoticeProps) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const profiles = userIds.map((id) => memberProfiles[id])
  const resolved = profiles.every((profile): profile is MemberProfileCardModel => !!profile)

  return (
    <div data-testid="member-join-notice" style={NOTICE_ROW_STYLE}>
      <div style={NOTICE_BODY_STYLE}>
        {resolved ? (
          <>
            {profiles.map((profile, index) => {
              const mentionable = !!onMention && profile.membership !== 'former' && profile.id !== user?.id
              return (
                <Fragment key={profile.id}>
                  {index > 0 ? t('group.memberJoined.separator') : null}
                  {mentionable ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className={MENTION_NAME_CLASS}
                      data-testid="member-join-mention"
                      data-user-id={profile.id}
                      title={t('group.memberJoined.mentionHint', { name: profile.displayName })}
                      onClick={() => onMention({ id: profile.id, name: profile.displayName })}
                    >
                      {profile.displayName}
                    </Button>
                  ) : (
                    <span className="gg-member-join-name-static">{profile.displayName}</span>
                  )}
                </Fragment>
              )
            })}
            {t('group.memberJoined.joined')}
          </>
        ) : content}
      </div>
    </div>
  )
}
