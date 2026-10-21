import { useTranslation } from 'react-i18next'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { Zap } from '@/lib/icons'

/**
 * 通讯录 Agent 分区表头的 ⚡「新建 Agent」。
 *
 * 它打开的是共享 Session Composer 的创建草稿(#2549/#2558/#2775)——那个 composer **本身就是**
 * 创建 Agent,旧式 CreateAgentModal 是本该被它替换掉的入口,其创建入口已随 #2874 的裁决全部删除。
 *
 * `onCreate` 缺省 = 当前形态根本拿不到 composer(web/Capacitor 没挂会话页帧)→ 整个按钮
 * **不渲染**。❌ 别在这里回退到旧弹窗、也别渲染一个禁用态占位:一个点了没反应的按钮比没有按钮更糟,
 * 而旧弹窗只能填「类型 + 运行设备」,选不了模型也不能组合创建后的普通发送。
 *
 * ⚠️ 调用方还欠一件事:草稿面只在消息 tab 渲染,从通讯录点必须先把 activeTab 切回 'chats'
 * (见 MainLayout 的 openAgentCreateDraftFromContacts),否则 effect 会当场把它复位 = 假按钮。
 */
export function ContactsCreateAgentButton({ className, onCreate }: {
  className?: string
  onCreate?: () => void
}) {
  const { t } = useTranslation('contacts')
  if (!onCreate) return null
  return (
    <button
      type="button"
      className={className}
      data-testid={AUTOMATION_TEST_IDS.contactsCreateAgentDraftAction}
      title={t('panel.createAgent')}
      onClick={(e) => { e.stopPropagation(); onCreate() }}
    >
      <Zap size={14} />
    </button>
  )
}
