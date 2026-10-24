import { useTranslation } from 'react-i18next'
import type { AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation'
import { displayStatusOf } from '@gugu/core/shared/ui/agentConversationStatusModels'
import { Button } from '../ui/Button'
import { useIsAssistantAvatar } from '../../lib/avatarIdentity'
import { Avatar } from '../Avatar'
import { AgentHarnessIcon } from '../AgentHarnessIdentity'
import { AgentHeaderStatusLine } from './AgentHeaderStatusLine'
import { agentHeaderStatusText, isAgentHeroBird, type AgentHeaderStatus } from './chatPresentation'

// 画布边长;身体只占其中约 82% 高(上边留白 12%、下边 5%)。上边那 12% 就是引擎给蹦跳留的余量(实测 done 状态每 3.4s
// 一蹦约 9px、拍一拍的反应能顶到画布上沿),所以画布上沿必须落在窗格顶边以内,蹦起来才不会被窗格裁掉头。
// 桌面 80 ⇒ 身体约 66px,比 52px 的头栏高,画布上沿贴窗格顶边、向下探出约 24px(tokens.css .gg-agent-header);
// 手机 56 = 头栏高 ⇒ 身体约 46px,整只在头栏里、上下都有余量。
const HERO_SIZE = 80
const HERO_SIZE_MOBILE = 56
// 传了照片的 agent:一张圆图,保持放大之前的尺寸、在头栏里居中,不上移不探出(见 isAgentHeroBird)。
const PHOTO_SIZE = 56
const PHOTO_SIZE_MOBILE = 40

/**
 * 与 agent 的单聊头栏:没有实线 —— 头像独自居中在标准高度的头栏里(像 Dots),名字(+ 一枚引擎字形)靠左、
 * 落在普通头栏标题的位置,动作图标留在右角;列表顶边不做渐隐遮罩,头栏下沿就是裁切线。
 *
 * 不再有「状态 · 位置 · 引擎」那一行字:状态靠头像身体自己的样子说(读的是同一个 presentation,所以不会与别处不一致),
 * 引擎是名字旁一枚小品牌字形;完整的那句话留在名字的悬停提示里,读屏仍能读到(那一句以 sr-only 挂在头栏内)。
 * 上传了头像的 agent 仍是那张图,状态走头像右上角的角标。点头像或名字 = 打开它的资料 / 设置;
 * 鼠标移到小鸟上它有反应(拍一拍:蹦一下、晃、眨眼、随机一个小表情)—— 悬停算跟它互动,点击才是开资料。
 */
export function AgentChatHero({
  agentId,
  name,
  avatarUrl,
  presentation,
  mobile,
  status,
  onOpen
}: {
  agentId: string
  name: string
  avatarUrl: string | null
  presentation: AgentStatusPresentation | null
  mobile: boolean
  /** 「状态 · 位置 · 引擎」那一句的输入:视觉上不显示成字,只给读屏、测试面(`data-agent-status-surface`)与名字的悬停提示。 */
  status: AgentHeaderStatus | null
  onOpen: () => void
}) {
  const { t } = useTranslation('messaging')
  const statusText = status ? agentHeaderStatusText(status, t) : null
  const assistant = useIsAssistantAvatar(agentId)
  const bird = isAgentHeroBird(avatarUrl, assistant)
  const size = bird ? (mobile ? HERO_SIZE_MOBILE : HERO_SIZE) : mobile ? PHOTO_SIZE_MOBILE : PHOTO_SIZE
  return (
    <div className="gg-agent-hero" data-testid="agent-chat-hero">
      <Button
        variant="ghost"
        size="sm"
        onClick={onOpen}
        title={statusText ?? undefined}
        className="gg-agent-hero-name window-no-drag-region h-auto min-h-0 min-w-0 px-1 py-0 max-[719px]:min-h-0"
      >
        <span className="truncate">{name}</span>
        <AgentHarnessIcon agentId={agentId} size={14} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onOpen}
        aria-label={t('chatArea.agentSettings')}
        title={t('chatArea.agentSettings')}
        data-hero-bird={bird ? '' : undefined}
        className="gg-agent-hero-avatar window-no-drag-region h-auto min-h-0 w-auto rounded-full p-0 max-[719px]:min-h-0"
      >
        <Avatar
          name={name}
          avatarUrl={avatarUrl}
          seed={agentId}
          size={size}
          isAgent
          harnessBadge={false}
          hoverPoke={bird}
          statusLabel={presentation?.label}
          agentStatus={presentation ? displayStatusOf(presentation.tone) : undefined}
        />
      </Button>
      {status ? <span className="sr-only"><AgentHeaderStatusLine {...status} /></span> : null}
    </div>
  )
}
