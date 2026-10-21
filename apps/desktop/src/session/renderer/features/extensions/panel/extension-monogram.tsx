import { cn } from '@renderer/utils/utils';
import { extensionMonogram } from '@shared/extensions/catalog';

/**
 * The one glyph a card or row draws for an App: its icon when there is one, else a letter.
 *
 * The icon is never the bundle's own bytes: the privileged renderer only paints
 * what main re-encoded (`appIcons`, like the rail's and the tab's — see
 * extension-icon.ts) or the market's public icon. Without one, a letter is
 * enough to tell rows apart, and it costs nothing to trust. Refs #5265.
 */
export function ExtensionMonogram({
  name,
  iconDataUrl,
  size = 'md',
  broken = false,
  className,
}: {
  name: string;
  iconDataUrl?: string | null;
  size?: 'sm' | 'md' | 'lg';
  broken?: boolean;
  className?: string;
}) {
  const sized = [size === 'sm' && 'is-small', size === 'lg' && 'is-large', className];
  if (iconDataUrl && !broken) {
    return (
      <img src={iconDataUrl} alt="" aria-hidden loading="lazy" decoding="async" className={cn('xp-glyph-img', ...sized)} />
    );
  }
  return (
    <span aria-hidden className={cn('xp-glyph', ...sized, broken && 'is-broken')}>
      {broken ? '?' : extensionMonogram(name)}
    </span>
  );
}
