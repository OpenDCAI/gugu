import { RadioGroup, RadioGroupItem } from '@renderer/lib/ui/radio-group';
import type { SessionTranslate } from '../extension-consent';

/** The fields this list displays; the host remains the owner of variant state. */
export type AppVariantRow = { name: string; base: string; dir: string | null };

export function appForkPrompt(
  app: { id: string; name: string },
  variant: AppVariantRow,
  update?: { upstream: string; behind: number; commit: string },
): string {
  const source = variant.dir ? ` Source directory: ${JSON.stringify(variant.dir)}.` : '';
  const subject = `${app.name} (${app.id}), fork ${JSON.stringify(variant.name)}.${source}`;
  return update
    ? `${subject} It is ${update.behind} releases behind upstream ${update.upstream}. Read guide apps-fork, merge upstream commit ${update.commit}, install and check it, preserving the custom changes and existing data.`
    : `${subject} Read guide apps-fork and continue changing this variant, preserving its identity and existing data. My request: `;
}

export function AppVariantList({
  active,
  variants,
  disabled,
  translate,
  onSwitch,
  onCopy,
}: {
  active: string;
  variants: readonly AppVariantRow[];
  disabled: boolean;
  translate: SessionTranslate;
  onSwitch: (name: string) => void;
  onCopy: (variant: AppVariantRow) => void;
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
            {variant.name !== 'upstream' && (
              <button type="button" className="xp-link shrink-0 py-2" onClick={() => onCopy(variant)}>
                {translate('extensions.copyPrompt')}
              </button>
            )}
          </div>
        ))}
      </RadioGroup>
    </section>
  );
}
