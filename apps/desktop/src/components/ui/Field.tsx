/* eslint-disable react-refresh/only-export-components -- compound component namespace is intentional. */

import { Field as FieldPrimitive } from '@base-ui/react/field'
import { Input as InputPrimitive } from '@base-ui/react/input'
import { cn } from '@/lib/cn'

type ClassNameProp = { className?: string }

// @@@field-variants - 表单域样式的唯一真相。原来只有 focused/invalid 两态,
// 指针悬停在输入框上没有任何变化 —— 补 hover 边框,让可编辑区在指针到达时就自报身份。
const fieldRoot = 'flex min-w-0 flex-col gap-1.5'

// @@@type-12 标签是要读的内容 → 正文字号 + medium + 次级色；层级靠颜色与字重，不靠再小一档。
// 原来 12px semibold 主色，比输入值本身还重，视觉上标签压过内容。
const fieldLabel = cn(
  'text-[length:var(--font-body)] leading-[var(--lh-body)] font-[var(--font-weight-medium)] text-[var(--muted-fg)]',
  // Base UI 在需要时把 label 标成视觉隐藏;这条保证它仍留在无障碍树里。
  'data-[visually-hidden=true]:absolute data-[visually-hidden=true]:h-px data-[visually-hidden=true]:w-px',
  'data-[visually-hidden=true]:overflow-hidden data-[visually-hidden=true]:whitespace-nowrap',
  'data-[visually-hidden=true]:[clip-path:inset(50%)]',
)

const fieldControl = cn(
  // @@@ui-ruler 控件高 = --control-h-lg(36),与 SearchField 同高;py 由 min-h 撑,不再 34 与 36 错 2px。
  'box-border w-full min-h-[var(--control-h-lg)] px-2.5 py-[7px] max-[719px]:min-h-[var(--control-h-touch)]',
  'rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-transparent',
  'font-[inherit] text-[length:var(--font-body)] text-[var(--text-primary)]',
  'outline-none transition-[border-color,box-shadow] duration-[var(--dur-fast)] ease-out motion-reduce:transition-none',
  'hover:border-[color-mix(in_srgb,var(--primary)_45%,var(--border-strong))]',
  // @@@5111 只读态。原来调用点(设置→账户的邮箱)自己手写 background/color 去压灰,压不掉上面那条
  // hover 边框 —— 指针悬上去边框照样变主色,一个改不了的框自报「可编辑」。只读的外观归变体表出。
  'read-only:cursor-default read-only:border-[var(--border)] read-only:bg-[var(--muted)] read-only:text-[var(--faint-fg)]',
  'read-only:hover:border-[var(--border)]',
  // 焦点/非法态由 Field.Root 下发,所以选择器挂在祖先上而不是控件自己。
  'group-data-[focused]/field:border-[var(--primary)]',
  'group-data-[focused]/field:shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_18%,transparent)]',
  // 只读域仍可聚焦(要能选中复制),但不该亮起「正在编辑」的主色环 —— 写在焦点态之后压住它。
  'read-only:group-data-[focused]/field:border-[var(--border)] read-only:group-data-[focused]/field:shadow-none',
  'group-data-[invalid]/field:border-[var(--danger)]',
  'disabled:cursor-not-allowed disabled:opacity-[0.58]',
)

// @@@field-bare #6264 —— 输入框本身就是一整条带(命令面板的搜索行、浮在终端上的 SSH 提问):
// 那条带的上下 hairline 已经画出「这里可以打字」,再套一圈边框 + 主色焦点环就是框里套框。
// 光标就是焦点指示(见 variants.ts @@@no-focus-ring);❌ 调用处自己拼一个裸 <input>。
const fieldControlBare = cn(
  'box-border w-full min-w-0 border-0 bg-transparent p-0 outline-none',
  'font-[inherit] text-[length:var(--font-body)] leading-[1.5] text-[var(--text-primary)] placeholder:text-[var(--faint-fg)]',
  'disabled:cursor-not-allowed disabled:opacity-[0.58]',
)

const fieldDescription = 'text-[length:var(--font-caption)] text-[var(--faint-fg)]'
const fieldError = 'text-[length:var(--font-body)] text-[var(--danger)]'

function Root({ className, ...props }: Omit<FieldPrimitive.Root.Props, 'className'> & ClassNameProp) {
  return (
    <FieldPrimitive.Root
      {...props}
      data-slot="field"
      className={cn('group/field', fieldRoot, className)}
    />
  )
}

function Label({ className, ...props }: Omit<FieldPrimitive.Label.Props, 'className'> & ClassNameProp) {
  return (
    <FieldPrimitive.Label {...props} data-slot="field-label" className={cn(fieldLabel, className)} />
  )
}

function Input({
  className,
  variant = 'default',
  ...props
}: Omit<InputPrimitive.Props, 'className'> & ClassNameProp & { variant?: 'default' | 'bare' }) {
  return (
    <InputPrimitive
      {...props}
      data-slot="field-control"
      data-variant={variant}
      className={cn(variant === 'bare' ? fieldControlBare : fieldControl, className)}
    />
  )
}

function Description({
  className,
  ...props
}: Omit<FieldPrimitive.Description.Props, 'className'> & ClassNameProp) {
  return (
    <FieldPrimitive.Description
      {...props}
      data-slot="field-description"
      className={cn(fieldDescription, className)}
    />
  )
}

function ErrorMessage({
  className,
  ...props
}: Omit<FieldPrimitive.Error.Props, 'className'> & ClassNameProp) {
  return (
    <FieldPrimitive.Error {...props} data-slot="field-error" className={cn(fieldError, className)} />
  )
}

/** Base UI 出关联与校验语义,变体表出视觉。 */
export const Field = {
  Root,
  Label,
  Input,
  Description,
  Error: ErrorMessage,
}
