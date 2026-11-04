import { Info } from '@/lib/icons'
import { cn } from '@renderer/utils/utils'

/** Neutral identity for content whose sender no longer exists. */
export function IdentityPlaceholder({ size, className }: { size?: number; className?: string }) {
  return (
    <span aria-hidden="true" className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full bg-foreground/[0.07] text-[length:var(--font-caption)] font-medium text-foreground/55', className)}
      style={size === undefined ? undefined : { width: size, height: size }}>
      <Info size={size === undefined ? 11 : Math.round(size * 11 / 20)} />
    </span>
  )
}
