/**
 * ExplorePage — 发现页
 *
 * 壳只做两件事：切标签、把 pane 摆上去。数据、拉取、错误、搜索词、向导状态各归各的 pane
 * （原来这些连同一段 800 行的 CSS 字符串全堆在这一个 1000 行的组件里）。
 *
 *   - 工作台 (wb)：预设团队画廊 + 搜索命中的公开 Agent → WorkbenchPane
 *   - 广场 (pz)：好友动态 → PlazaMomentsPane / 找群 → DiscoverGroupsPane
 *
 * ⚠️ 2026-09-05 起本页**没有入口、也不再被挂载** —— owner:「发现页离完善还有距离,先不展示」。
 * 源码原样保留是为了随时能装回去(下架的是入口不是功能)。原路由是
 * MainLayout sidebarTab='explore' → <ExplorePage />;恢复需要三处一起加回:
 * SidebarTab 联合类型的 'explore'、Sidebar 的 RailItem、MainLayout 的挂载块。
 *
 * 找群(DiscoverGroupsPane)一度搬去了通讯录,但同日 owner 追加:「现在没有公开群的概念,
 * 别有公开群」—— 于是它与群设置里的「公开到广场」开关一起撤回,整条公开群链路都没有入口了。
 * 本页三块(工作台 / 广场 / 找群)现在是同进同出的一整块。
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pane, PaneHeader } from '../components/ui/Pane'
import { SegmentedTabs } from '../components/ui/SegmentedTabs'
import { useMobileShell } from '../hooks/useMobileShell'
import { DiscoverGroupsPane } from './explore/DiscoverGroupsPane'
import { PlazaMomentsPane } from './explore/PlazaMomentsPane'
import { discoverPaneClass } from './explore/paneClass'
import { WorkbenchPane, type PublicAgent } from './explore/WorkbenchPane'
import './ExplorePage.css'

export type { PublicAgent }

const WB_PANEL_ID = 'gg-disc-panel-wb'
const PZ_PANEL_ID = 'gg-disc-panel-pz'

const MO_PANEL_ID = 'gg-disc-panel-moments'
const GP_PANEL_ID = 'gg-disc-panel-groups'

export interface ExplorePageProps {
  /** 点击 agent 开聊的回调（父组件决定打开 DM）。#1735 传整个 agent（父组件需要
      display_name/avatar/owner_user_id 构造 DM target），不再只传 id。 */
  onSelectAgent?: (agent: PublicAgent) => void
  /** 从模板组建群聊后跳转到该会话（父组件切到聊天 tab + 选中会话） */
  onNavigateToChat?: (chatId: string) => void
}

export function ExplorePage({ onSelectAgent, onNavigateToChat }: ExplorePageProps) {
  const { t } = useTranslation('discover')
  const mobile = useMobileShell()
  const [activeTab, setActiveTab] = useState<'wb' | 'pz'>('wb')
  // @@@1175 (owner override #4) — 找群挂进「广场」面、与 moments 并列 sub-tab（不替换 moments）。
  const [pzSub, setPzSub] = useState<'moments' | 'groups'>('moments')
  // 工作台「刷新」钮的落点在页头动作车道，但它的状态（disabled / data-refreshing）由
  // WorkbenchPane 的 react-query 拥有——这里只搬 DOM 位置（portal），不搬状态所有权，
  // 保持 WorkbenchPane 自己的文档注释里那条「谁用谁拥有」的所有权原则。
  const [wbHeaderActionsHost, setWbHeaderActionsHost] = useState<HTMLDivElement | null>(null)
  const topTabs = [
    { value: 'wb', label: t('page.workbench'), testId: 'discover-workbench-subtab', panelId: WB_PANEL_ID },
    { value: 'pz', label: t('page.plaza'), testId: 'discover-plaza-subtab', panelId: PZ_PANEL_ID },
  ] as const
  const plazaSubtabs = [
    { value: 'moments', label: t('page.moments'), testId: 'plaza-moments-subtab', panelId: MO_PANEL_ID },
    { value: 'groups', label: t('page.groups'), testId: 'plaza-groups-subtab', panelId: GP_PANEL_ID },
  ] as const

  return (
    <Pane paneRole="detail" mobile={mobile} className="gg-disc">
      {/* 标题基线与其它面板对齐（52px 头，触屏 56px）；工作台「刷新」钮 portal 进这条动作车道
          （见下方 WorkbenchPane 的 headerActionsHost），发现页没有左列，不需要 leading。 */}
      <PaneHeader
        title={t('page.title')}
        mobile={mobile}
        actions={<div ref={setWbHeaderActionsHost} className="gg-disc-header-actions" />}
      />

      <div className="gg-disc-body">
        {/* 一个内容宽度容器：标签、搜索框、下面所有 pane 共用同一条右边线。 */}
        <div className="gg-disc-inner">
          <div className="gg-dtabs">
            <SegmentedTabs
              items={topTabs}
              value={activeTab}
              onChange={setActiveTab}
              variant="pill"
              ariaLabel={t('page.sectionsLabel')}
            />
          </div>

          <WorkbenchPane
            active={activeTab === 'wb'}
            panelId={WB_PANEL_ID}
            onSelectAgent={onSelectAgent}
            onNavigateToChat={onNavigateToChat}
            headerActionsHost={wbHeaderActionsHost}
          />

          <div
            className={discoverPaneClass(activeTab === 'pz')}
            id={PZ_PANEL_ID}
            role="tabpanel"
            tabIndex={-1}
            data-dpane="pz"
          >
            {/* 子标签紧跟主标签，不被任何条件渲染的控件顶开 —— 搜索框已下沉到
                「找群」自己那块里，来回切子标签时这一行不再上下跳。 */}
            <div className="gg-subtabs">
              <SegmentedTabs
                items={plazaSubtabs}
                value={pzSub}
                onChange={setPzSub}
                variant="underline"
                ariaLabel={t('page.plazaSectionsLabel')}
              />
            </div>

            {/* 两个子面板都常驻挂载、靠 CSS 显隐 —— 与工作台同一个模式。
                原来是条件渲染：切去「找群」再切回来，PlazaMomentsPane 整个卸载，
                写了一半的草稿就没了，动态也要重拉一次。 */}
            <PlazaMomentsPane active={pzSub === 'moments'} panelId={MO_PANEL_ID} />
            <DiscoverGroupsPane active={activeTab === 'pz' && pzSub === 'groups'} panelId={GP_PANEL_ID} />
          </div>
        </div>
      </div>
    </Pane>
  )
}
