import { Progress as Primitive } from '@base-ui/react/progress'

/** Base UI owns the progress semantics. A null value never implies a percentage. */
export function Progress({ value, label }: { value: number | null; label: string }) {
  return <Primitive.Root value={value} aria-label={label} className="w-full">
    <Primitive.Track className="h-1 w-full overflow-hidden rounded-full bg-[var(--muted)]">
      <Primitive.Indicator className="h-full rounded-full bg-[var(--accent)] data-indeterminate:w-1/3 data-indeterminate:opacity-50" />
    </Primitive.Track>
  </Primitive.Root>
}
