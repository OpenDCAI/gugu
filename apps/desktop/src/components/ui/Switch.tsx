import { Switch as SwitchPrimitive } from '@base-ui/react/switch'
import type { CSSProperties } from 'react'
import { cn } from '@/lib/cn'
import { disabledState } from './variants'

// @@@switch-variants - 32×20 的紧致开关(#7333 视觉规范:关=填充面 + 细边、灰旋钮;开=墨色轨道、表面色旋钮)。
// 原来只有 checked/disabled/focus 三态,悬停/按下毫无反馈 —— 见下面 @@@state-ladder-mix。
const switchRoot = cn(
  'group/switch relative inline-flex h-5 w-8 flex-[0_0_32px] items-center justify-center cursor-pointer',
  'max-[719px]:h-11 max-[719px]:w-11 max-[719px]:flex-[0_0_44px]',
  'rounded-[var(--radius-capsule)] bg-transparent',
  // 状态切换归「快」档(spec §动效三档),曲线走 token。原来是 dur-med + 裸 ease-out。
  '!transition-[background-color,opacity] !duration-[var(--dur-fast)] ease-[var(--ease)] motion-reduce:!transition-none',
  // @@@state-ladder-mix 轨道是实色填充,反馈走透明度阶梯(悬浮 .88 / 按下 .78),与 .gg-fill、
  // 会话页 primary、发送圆钮同一配方。❌ 别退回 brightness:开着时轨道 = --primary,浅色下是纯黑,
  // 黑乘任何系数还是黑 —— 那等于开着的开关既没有悬浮也没有按下反馈(旧疾,一并修掉)。
  // 画在根上而不是轨道上:opacity 会连同轨道与滑块一起淡,整颗开关一起响应,不会只淡一半。
  '[&:hover:not([data-disabled])]:opacity-[0.88]',
  '[&:active:not([data-disabled])]:opacity-[0.78]',
  disabledState,
  'data-[disabled]:cursor-default data-[disabled]:opacity-50',
)

const switchTrack = cn(
  'relative block h-5 w-8 flex-none rounded-[var(--radius-capsule)]',
  'bg-[var(--switch-track-off)] group-data-[checked]/switch:bg-[var(--switch-track-on)]',
  // 关着时轨道是一块填充面,补一圈细边免得在同色卡片上消失;开着是墨色实底,不需要。
  'shadow-[inset_0_0_0_1px_var(--border)] group-data-[checked]/switch:shadow-none',
)

const switchThumb = cn(
  'absolute start-[3px] top-[3px] block h-3.5 w-3.5 rounded-full',
  // @@@shadow-lift (Refs #6105) —— 旋钮不是浮层,不给阴影。
  'bg-[var(--switch-thumb)]',
  'translate-x-0 data-[checked]:translate-x-3 data-[checked]:bg-[var(--primary-fg)]',
  '!transition-transform !duration-[var(--dur-med)] ease-out motion-reduce:!transition-none',
)

export interface SwitchProps
  extends Omit<
    SwitchPrimitive.Root.Props,
    'className' | 'style' | 'checked' | 'onCheckedChange' | 'render' | 'nativeButton'
  > {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  className?: string
  style?: CSSProperties
}

/** Base UI 出行为；32×20 是视觉轨道，移动语义命中根统一为 44×44。 */
export function Switch({ checked, onCheckedChange, className, style, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(switchRoot, className)}
      checked={checked}
      onCheckedChange={onCheckedChange}
      render={<button type="button" />}
      nativeButton
      style={style}
      {...props}
    >
      <span data-slot="switch-track" className={switchTrack} aria-hidden="true">
        <SwitchPrimitive.Thumb data-slot="switch-thumb" className={switchThumb} />
      </span>
    </SwitchPrimitive.Root>
  )
}
