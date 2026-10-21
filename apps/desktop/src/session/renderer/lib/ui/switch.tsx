import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { cn } from '@renderer/utils/utils';

function Switch({
  className,
  size = 'default',
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: 'sm' | 'default';
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        'peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-border-1 transition-all after:absolute after:-inset-x-3 after:-inset-y-2 aria-invalid:border-border-destructive data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] data-checked:bg-background-neutral data-unchecked:bg-background hover:opacity-[.88] active:opacity-[.78] data-disabled:cursor-not-allowed data-disabled:opacity-50 data-disabled:hover:opacity-50 data-disabled:active:opacity-50',
        className
      )}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey || e.altKey) && (e.key === 'Enter' || e.key === ' ')) {
          e.preventBaseUIHandler?.();
        }
      }}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-background-neutral/50 ring-0 transition-transform group-data-checked/switch:bg-background-3 group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-unchecked:translate-x-0"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
