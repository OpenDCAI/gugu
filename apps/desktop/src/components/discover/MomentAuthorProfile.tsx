import { useMemo, useState, type MouseEvent } from 'react'
import type { MomentsAuthor } from '@gugu/core/shared/types/moments'
import { useMobileShell } from '../../hooks/useMobileShell'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { MemberProfileAvatarButton } from '../MemberProfileAvatarButton'
import type { MemberProfileCardModel } from '../MemberProfileCard'
import { MemberProfilePopover } from '../MemberProfilePopover'
import type { ActiveMemberProfile } from '../memberProfileModels'

export function MomentAuthorProfile({ author, compact = false }: { author: MomentsAuthor; compact?: boolean }) {
  const [activeProfile, setActiveProfile] = useState<ActiveMemberProfile | null>(null)
  const mobile = useMobileShell()
  const tight = compact && !mobile
  const member = useMemo<MemberProfileCardModel>(() => ({
    id: author.id,
    guguNumber: author.guguNumber,
    displayName: author.name,
    avatar: author.avatar,
    email: null,
    bio: author.bio,
    type: 'human',
    role: 'member',
    profileScope: 'direct',
  }), [author])

  const openProfile = (event: MouseEvent<HTMLButtonElement>) => {
    setActiveProfile({ member, anchor: event.currentTarget, preferredSide: 'right' })
  }

  return (
    <>
      {/* @@@one-source-shell-branch 紧致态只由 tight 这一个布尔决定,并且**同时**写进 buttonSize(内联 px)
          与 class(给 CSS)。❌ 不许一边读 useMobileShell、另一边读 CSS 宽度断点:useMobileShell 是
          「capacitor 或 <720」,媒体查询只有宽度,两者在 capacitor 且宽度 ≥720 的机器上(安卓平板、
          手机横屏)会分叉 —— 内联 44px 的按钮塞进 34px 的固定网格轨,同时 44px 触控目标也丢了。 */}
      <div className={`gg-moment-author${compact ? ' gg-moment-author-compact' : ''}${tight ? ' gg-moment-author-tight' : ''}`}>
        <MemberProfileAvatarButton
          member={member}
          testId={AUTOMATION_TEST_IDS.plazaAuthorProfileButton}
          avatarSize={compact ? 'sm' : 'md'}
          // 评论的作者位是注解，不是第二个正文头像：桌面收成 34（贴着 32 的头像本身），
          // 让评论行的左栏比正文窄一档。手机保持 44 —— 触控目标下限（#1787）与紧致无关。
          buttonSize={tight ? 34 : 44}
          active={activeProfile != null}
          onOpen={openProfile}
        />
        <button
          type="button"
          className="gg-moment-author-name gg-pressable"
          data-testid="plaza-author-name"
          aria-expanded={activeProfile != null}
          onClick={openProfile}
        >
          {author.name}
        </button>
      </div>
      {activeProfile ? (
        <MemberProfilePopover
          profile={activeProfile}
          onClose={() => setActiveProfile(null)}
          testId={AUTOMATION_TEST_IDS.plazaAuthorProfileMenu}
        />
      ) : null}
    </>
  )
}
