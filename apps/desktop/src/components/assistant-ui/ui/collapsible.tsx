import type { ComponentProps } from 'react'
import { Collapsible as BaseCollapsible } from '@base-ui/react/collapsible'

/**
 * shadcn 形状的 Collapsible（Radix 命名）→ 咕咕底座 Base UI 的同名原语。
 *
 * 官方 assistant-ui 的工具卡用 `Collapsible / CollapsibleTrigger / CollapsibleContent` 三件套折叠输出。
 * 咕咕不装 Radix（底座是 Base UI），但 Base UI 有一模一样的东西，只是叫 Root / Trigger / Panel。
 * 这一层只是改个名字，动效与无障碍都是 Base UI 自己的。
 *
 * ❌ 不用仓里的 `Collapse`：那个是受控的（要自己拿着 open 状态），而官方源码用的是
 * 自持状态的 trigger 模式，换过去就得改官方源码。
 */
export function Collapsible(props: ComponentProps<typeof BaseCollapsible.Root>) {
  return <BaseCollapsible.Root {...props} />
}

export function CollapsibleTrigger(props: ComponentProps<typeof BaseCollapsible.Trigger>) {
  return <BaseCollapsible.Trigger {...props} />
}

export function CollapsibleContent(props: ComponentProps<typeof BaseCollapsible.Panel>) {
  return <BaseCollapsible.Panel {...props} />
}
