import { Input as InputPrimitive } from '@base-ui/react/input'
import { Search, X } from '@/lib/icons'
import type { Ref } from 'react'
import { cn } from '@/lib/cn'
import { Button } from './Button'
import { controlTransition } from './variants'

type ClearAction =
  | { clearLabel: string; onClear: () => void }
  | { clearLabel?: never; onClear?: never }

export type SearchFieldProps = Omit<InputPrimitive.Props, 'className' | 'type'> &
  ClearAction & {
    className?: string
    ref?: Ref<HTMLInputElement>
  }

/** Search input chrome shared by the main renderer's product surfaces. */
export function SearchField({
  className,
  clearLabel,
  disabled,
  onClear,
  placeholder,
  ref,
  value,
  ...props
}: SearchFieldProps) {
  const hasClearAction = onClear && typeof value === 'string' && value.length > 0

  return (
    <div
      data-slot="search-field"
      data-disabled={disabled || undefined}
      className={cn(
        'group/search-field window-no-drag-region box-border flex h-9 w-full min-w-0 items-center gap-2',
        'rounded-[var(--radius-control)] border border-[var(--border-color)] bg-[var(--input-bg)] px-2.5',
        'text-[var(--text-tertiary)]',
        controlTransition,
        'hover:border-[var(--border-strong)] focus-within:border-[var(--border-strong)]',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-[0.58] data-[disabled]:hover:border-[var(--border-color)]',
        'max-[719px]:h-11',
        className,
      )}
    >
      <Search aria-hidden="true" className="size-[15px] shrink-0" strokeWidth={1.5} />
      <InputPrimitive
        {...props}
        ref={ref}
        type="search"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={props['aria-label'] ?? (typeof placeholder === 'string' ? placeholder : undefined)}
        data-slot="search-field-input"
        className={cn(
          'h-full min-w-0 flex-1 border-0 bg-transparent p-0 font-[inherit]',
          'text-[length:var(--font-body)] text-[var(--text-primary)] outline-none',
          'placeholder:text-[var(--text-tertiary)]',
          'disabled:cursor-not-allowed [&::-webkit-search-cancel-button]:hidden',
        )}
      />
      {hasClearAction ? (
        <Button
          aria-label={clearLabel}
          title={clearLabel}
          variant="ghost"
          size="icon"
          className="-my-px -mr-2 shrink-0"
          onClick={onClear}
        >
          <X aria-hidden="true" className="size-3.5" />
        </Button>
      ) : null}
    </div>
  )
}
