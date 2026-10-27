import { RadioGroup, RadioGroupItem } from '@renderer/lib/ui/radio-group';
import type { ExtensionVariant } from '@shared/extensions/variants';
import type { SessionTranslate } from '../extension-consent';
import { useTranslation } from 'react-i18next';
import { Copy, Bot, MessageSquare, CheckCircle } from '@/lib/icons';
import { ResourceHelp } from '@/components/ResourceHelp';
import { ResourceMenu } from '@/components/ResourceMenu';
import type { ResourceContext } from '@shared/resource-actions';
import { compareExtensionVersions } from '@shared/extensions/manifest';

/** The fields this list displays; the host remains the owner of variant state. */
export type AppVariantRow = Pick<ExtensionVariant, 'name' | 'base' | 'dir'>;

export function AppVariantList({
  active,
  variants,
  disabled,
  translate,
  onSwitch,
  resource,
}: {
  active: string;
  variants: readonly AppVariantRow[];
  disabled: boolean;
  translate: SessionTranslate;
  onSwitch: (name: string) => void;
  resource?: ResourceContext;
}) {
  const { t } = useTranslation('messaging');
  if (variants.length < 2) return null;
  return (
    <section className="mk-dsec" data-testid="app-variants">
      <h3 className="flex items-center gap-1">{translate('extensions.variants')}<ResourceHelp title={t('resources.helpTitle')} description={t('resources.helpDescription')} frames={[
        { label: t('resources.helpCopy'), picture: <Copy /> }, { label: t('resources.helpSend'), picture: <Bot /> },
        { label: t('resources.helpAsk'), picture: <MessageSquare /> }, { label: t('resources.helpConfirm'), picture: <CheckCircle /> },
      ]} /></h3>
      <RadioGroup
        value={active}
        disabled={disabled}
        aria-label={translate('extensions.variants')}
        onValueChange={(value) => { if (typeof value === 'string' && value !== active) onSwitch(value); }}
        className="gap-0"
      >
        {variants.map((variant) => {
          const row = <div className="flex items-center gap-3 border-b border-border py-2 last:border-0">
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-1">
              <RadioGroupItem value={variant.name} data-testid={`app-variant-${variant.name}`} />
              <span className="min-w-0 break-words">
                {variant.name === 'upstream' ? translate('extensions.variantOriginal', { version: variant.base }) : variant.name}
                {variant.name !== 'upstream' && (
                  <span className="text-foreground-secondary"> · {translate('extensions.variantBase', { version: variant.base })}</span>
                )}
              </span>
            </label>
          </div>;
          return resource?.target.kind === 'app-detail' && resource.target.deviceId
            ? <ResourceMenu key={variant.name} resource={{ kind: 'app-variant', target: { ...resource.target, variant: variant.name }, facts: variant.name === 'upstream' ? [] : ['fork', ...(resource.facts ?? []), ...(compareExtensionVersions(variants.find(row => row.name === 'upstream')?.base ?? variant.base, variant.base) > 0 ? ['behind' as const] : [])] }}>{row}</ResourceMenu>
            : <div key={variant.name}>{row}</div>;
        })}
      </RadioGroup>
    </section>
  );
}
