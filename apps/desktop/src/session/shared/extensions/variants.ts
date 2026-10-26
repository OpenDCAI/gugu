import { z } from 'zod';
import { safePathSegment } from '../path-name';
import { compareExtensionVersions } from './manifest';
import type { MarketIndexVersion } from './market';

/** A name is also a directory and a Git branch component, on every desktop OS. */
export const variantNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).refine((name) => safePathSegment(name, '') === name, 'Choose a name that can be used as a folder.');
export const extensionVariantSchema = z.object({
  name: variantNameSchema,
  base: z.string(),
  commit: z.string(),
  repo: z.string().nullable(),
  path: z.string(),
  dir: z.string().nullable(),
  sha256: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type ExtensionVariant = z.infer<typeof extensionVariantSchema>;
export const appVariantsSchema = z.object({ active: variantNameSchema, variants: z.array(extensionVariantSchema) });
export type AppVariants = z.infer<typeof appVariantsSchema>;
export interface ForkBehind { upstream: string; behind: number; commit: string }
export type AppVariantsResult = AppVariants & { behind: ForkBehind | null };

/** Count published versions, excluding withdrawals; the merge target is the newest exact source commit. */
export function forkBehind(base: string, versions: readonly MarketIndexVersion[]): ForkBehind | null {
  const newer = versions.filter((row) => !row.yanked && compareExtensionVersions(row.version, base) > 0)
    .sort((a, b) => compareExtensionVersions(b.version, a.version));
  const latest = newer[0];
  return latest ? { upstream: latest.version, behind: newer.length, commit: latest.source.commit } : null;
}
