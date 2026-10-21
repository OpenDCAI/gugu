import z from 'zod';
import { definePluginAsset, type InferPluginAssetType } from './asset';

/**
 * Plugin icon asset.
 *
 * Icons are pure data so they can be validated, sent over IPC, and rendered
 * by a single app-owned component. The plugin's responsibility is to provide
 * artwork that looks good for every mode/size combination it declares:
 *
 * - Square viewBox with padding baked in; the app renders into a size x size
 *   box and normalizes the root <svg> width/height to 100%.
 * - Prefer `fill="currentColor"` for monochrome logos: a single `light`
 *   variant then adapts to any theme via CSS color.
 * - Provide explicit `dark` artwork for brand-colored logos, or set
 *   `invertInDark` for logos that should be color-inverted in dark mode.
 * - Use `minSize` to supply simplified artwork for small renderings
 *   (e.g. mark-only below 24px, full wordmark above).
 */
const iconVariantSchema = z.object({
  /** Smallest rendered px size this artwork is designed for. */
  minSize: z.number().int().nonnegative().default(0),
  /** Raw SVG markup (kind: 'svg') or data URI (kind: 'image'). */
  light: z.string(),
  /** Omit when `light` works in dark mode or `invertInDark` is set. */
  dark: z.string().optional(),
});

export const iconAsset = definePluginAsset(
  'icon',
  z.object({
    kind: z.enum(['svg', 'image']),
    alt: z.string().optional(),
    /**
     * Size-responsive variants. The app picks the variant with the largest
     * `minSize` that is <= the rendered size. Most plugins provide one.
     */
    variants: z.array(iconVariantSchema).min(1),
    /** Fallback dark-mode strategy when a variant has no explicit dark art. */
    invertInDark: z.boolean().optional(),
    /**
     * The vendor's own app-icon plate, for surfaces that show an agent as an app (#6157).
     *
     * An app icon is a brand mark being quoted, so its colour is the vendor's, not ours:
     * `color` fills the whole rounded square and the mark sits on it. `mark: 'white'` knocks
     * the artwork out to white (monochrome logos); `'original'` keeps the artwork's own colours
     * (logos that are already a light-on-dark or two-tone mark). The plate does not change
     * with the app theme, the same way a real app icon does not.
     */
    plate: z
      .object({
        color: z.string(),
        mark: z.enum(['white', 'original']).default('white'),
      })
      .optional(),
  })
);

export type PluginIconAsset = InferPluginAssetType<typeof iconAsset>;
export type PluginIconVariant = PluginIconAsset['variants'][number];
