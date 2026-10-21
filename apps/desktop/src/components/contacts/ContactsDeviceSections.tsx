import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import { Collapse } from '../ui/Collapse'
import { SectionLabel } from '../ui/SectionLabel'
import { ChevronDown } from '@/lib/icons'
import { useDevicesStore } from '../../store/devicesContext'
import { useDisplayDevices } from '@/hooks/useAssistantHomeLabel'
import { ContactsAgentSectionState, ContactsGroupSectionState } from './ContactsSectionState'
import { ContactsCreateAgentButton } from './ContactsCreateAgentButton'
import { partitionContactsByDevice, type ContactsDeviceSection } from './contactsByDevice'

// #5019 桌面三段侧栏的「设备段」:本机 → 其他设备(各成一段) → 咕咕云 → (设备表未到时的)Agent,
// 每段里先 agent 行再群行;之后是 personSection(个人),最后是「群组」= 没有我 agent 的群(云段)。
// 从 ContactsPanel(冻结 god 文件)抽出;行组件与右键菜单仍由面板渲染,这里只管分段与折叠。
//
// 折叠状态按段 key 记,设备增减不串;主段的空态是 Agent 分区那套(还没有 Agent + 新建),其余设备段空了
// 就整段不出现(一台什么都没跑的设备不是一个分区)。
// 默认只展开「群组」(个人在面板里,也默认展开);设备段默认折叠。搜索不走这里:有关键词时整块换成 ContactSearch 的结果表。

const GROUPS_KEY = '__groups'
const defaultOpen = (key: string) => key === GROUPS_KEY

const sectionLabelClass = 'gg-c-sec-h !mt-3'
const sectionAddClass =
  'gg-c-sec-add inline-grid h-[var(--control-h-sm)] w-[var(--control-h-sm)] cursor-pointer place-items-center rounded-[var(--radius-control)] border-0 bg-transparent text-[var(--muted-fg)] hover:bg-[var(--hover)] active:bg-[var(--press)] hover:text-[var(--fg)]'
const chevronClass = (collapsed: boolean) =>
  `gg-c-sec-chev flex shrink-0 transition-transform duration-[var(--dur-med)] [transition-timing-function:var(--ease)]${collapsed ? ' -rotate-90' : ''}`

export function ContactsDeviceSections({
  agents,
  groups,
  currentUserId,
  onCreateAgent,
  onCreateGroup,
  renderAgent,
  renderGroup,
  personSection,
}: {
  agents: ContactUser[]
  groups: ContactGroupChat[]
  currentUserId?: string | null
  onCreateAgent?: () => void
  onCreateGroup: () => void
  renderAgent: (contact: ContactUser) => ReactNode
  renderGroup: (group: ContactGroupChat) => ReactNode
  personSection: ReactNode
}) {
  const { t } = useTranslation('contacts')
  // #7199 个人助理住的那台那一段,段名是它的名字(用户看不到它住在哪)。
  const devices = useDisplayDevices(useDevicesStore().devices)
  const partition = useMemo(
    () => partitionContactsByDevice(agents, groups, devices, currentUserId),
    [agents, groups, devices, currentUserId],
  )
  const [openByKey, setOpenByKey] = useState<Record<string, boolean>>({})
  const isOpen = (key: string) => openByKey[key] ?? defaultOpen(key)
  const toggle = (key: string) => setOpenByKey((prev) => ({ ...prev, [key]: !(prev[key] ?? defaultOpen(key)) }))

  const titleOf = (section: ContactsDeviceSection): string => {
    if (section.scope === 'local') return t('panel.localDeviceSectionTitle')
    if (section.scope === 'cloud') return t('panel.cloudDeviceSectionTitle')
    if (section.scope === 'device') return section.displayLabel ?? section.key
    return t('panel.agentSectionTitle')
  }

  return (
    <>
      {partition.sections.map((section) => {
        const isPrimary = section.key === partition.primaryKey
        const open = isOpen(section.key)
        return (
          <div key={section.key} data-testid="contacts-device-section" data-device-scope={section.scope}>
            <SectionLabel
              interactive
              className={sectionLabelClass}
              leading={<span className={chevronClass(!open)}><ChevronDown size={16} /></span>}
              trailing={isPrimary ? <ContactsCreateAgentButton className={sectionAddClass} onCreate={onCreateAgent} /> : undefined}
              onClick={() => toggle(section.key)}
            >
              {titleOf(section)}
            </SectionLabel>
            <Collapse open={open} className="gg-c-sec-body">
              {section.agents.map(renderAgent)}
              {section.groups.map(renderGroup)}
              {isPrimary ? (
                <ContactsAgentSectionState isEmpty={section.agents.length === 0} onCreateAgent={onCreateAgent} />
              ) : null}
            </Collapse>
          </div>
        )
      })}

      {personSection}

      <SectionLabel
        interactive
        className={sectionLabelClass}
        leading={<span className={chevronClass(!isOpen(GROUPS_KEY))}><ChevronDown size={16} /></span>}
        onClick={() => toggle(GROUPS_KEY)}
      >
        {t('panel.groupSectionTitle')}
      </SectionLabel>
      <Collapse open={isOpen(GROUPS_KEY)} className="gg-c-sec-body">
        {partition.cloudGroups.map(renderGroup)}
        <ContactsGroupSectionState isEmpty={partition.cloudGroups.length === 0} onCreateGroup={onCreateGroup} />
      </Collapse>
    </>
  )
}
