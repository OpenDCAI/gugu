import { cn } from '@renderer/utils/utils';
import { useAgentIcon } from '../stores/use-agents';
import { PluginIcon } from './plugin-icon';

/** Plate for a vendor that has not declared one: a dark plate with the mark knocked out to white. */
const FALLBACK_PLATE = { color: '#2B2A28', mark: 'white' as const };

/**
 * An agent drawn as an app icon (#6157): the vendor's colour fills a rounded square, the mark
 * sits on it.
 *
 * owner 2026-09-22: 图标「不是空空的空白加一个居中图标」,参考 macOS 的 App 图标做成**填充**的。
 * The plate colour comes from the plugin (`icon.plate`), because an app icon is a brand mark
 * being quoted: ❌ no gradient, gloss or shadow of our own, and ❌ no pale tint behind a small
 * logo, which is the empty look this replaced.
 *
 * `dimmed` is "not installed": the whole plate goes grey and recedes, so installed and
 * not-installed separate at a glance even before reading a word.
 */
export function AppIcon({
  id,
  size = 56,
  dimmed = false,
  className,
}: {
  id: string;
  size?: number;
  dimmed?: boolean;
  className?: string;
}) {
  const icon = useAgentIcon(id);
  const plate = icon?.plate ?? FALLBACK_PLATE;
  // The mark takes a little over half the plate, the proportion of a macOS app icon glyph.
  const markSize = Math.round(size * 0.58);
  return (
    <span
      data-testid="app-icon"
      data-plate={plate.color}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden',
        // One hairline so a black plate still has an edge on the dark theme.
        'ring-1 ring-inset ring-foreground/10',
        dimmed && 'opacity-40 grayscale',
        className,
      )}
      // A macOS icon's corner is about 22.5% of its side.
      style={{ width: size, height: size, borderRadius: size * 0.225, background: plate.color }}
    >
      {icon && (
        <PluginIcon
          id={id}
          icon={icon}
          size={markSize}
          theme="light"
          className={plate.mark === 'white' ? 'brightness-0 invert' : undefined}
        />
      )}
    </span>
  );
}
