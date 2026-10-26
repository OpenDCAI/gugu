import { RadioGroup, RadioGroupItem } from '@renderer/lib/ui/radio-group';
import type { ExtensionVariant } from '@shared/extensions/variants';
import type { SessionTranslate } from '../extension-consent';

/** The fields this list displays; the host remains the owner of variant state. */
export type AppVariantRow = Pick<ExtensionVariant, 'name' | 'base' | 'dir'>;

export function AppVariantList({
  active,
  variants,
  disabled,
  translate,
  onSwitch,
}: {
  active: string;
  variants: readonly AppVariantRow[];
  disabled: boolean;
  translate: SessionTranslate;
  onSwitch: (name: string) => void;
}) {
  if (variants.length < 2) return null;
  return (
    <section className="mk-dsec" data-testid="app-variants">
      <h3>{translate('extensions.variants')}</h3>
      <RadioGroup
        value={active}
        disabled={disabled}
        aria-label={translate('extensions.variants')}
        onValueChange={(value) => { if (typeof value === 'string' && value !== active) onSwitch(value); }}
        className="gap-0"
      >
        {variants.map((variant) => (
          <div key={variant.name} className="flex items-center gap-3 border-b border-border py-2 last:border-0">
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-1">
              <RadioGroupItem value={variant.name} data-testid={`app-variant-${variant.name}`} />
              <span className="min-w-0 break-words">
                {variant.name === 'upstream' ? translate('extensions.variantOriginal', { version: variant.base }) : variant.name}
                {variant.name !== 'upstream' && (
                  <span className="text-foreground-secondary"> · {translate('extensions.variantBase', { version: variant.base })}</span>
                )}
              </span>
            </label>
          </div>
        ))}
      </RadioGroup>
    </section>
  );
}
