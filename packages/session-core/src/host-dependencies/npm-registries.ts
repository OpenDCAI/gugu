/**
 * npm registries offered as install sources.
 *
 * Mainland-China users frequently cannot reach the official registry, so mirrors are
 * offered alongside it. Mirrors are NOT interchangeable — see product spec:
 *   - npmmirror lags behind on some packages (measured 2026-08-10: @xai-official/grok stuck at
 *     0.1.4 while official was 1.0.0; @gitlawb/zero 19 days behind). The UI shows each registry's
 *     own version so the user sees the gap before choosing.
 *   - Tencent's mirror is deliberately NOT offered: it does not honour Range requests (returns
 *     200 with the whole file where the others return 206), so resumable downloads break on the
 *     ~90MB platform packages these CLIs ship.
 *
 * `id` is persisted in the user's install-source selection — never renumber or reuse ids.
 */
export const NPM_REGISTRIES = [
  { id: 'official', label: 'npmjs.org', url: 'https://registry.npmjs.org' },
  { id: 'npmmirror', label: 'npmmirror', url: 'https://registry.npmmirror.com' },
  { id: 'huawei', label: 'Huawei Cloud', url: 'https://repo.huaweicloud.com/repository/npm' },
] as const;

export type NpmRegistryId = (typeof NPM_REGISTRIES)[number]['id'];

/** The registry used when a selection carries no explicit registry (legacy selections included). */
export const DEFAULT_NPM_REGISTRY_ID: NpmRegistryId = 'official';

export function npmRegistryUrl(id: string): string | undefined {
  return NPM_REGISTRIES.find((r) => r.id === id)?.url;
}

export function npmRegistryLabel(id: string): string | undefined {
  return NPM_REGISTRIES.find((r) => r.id === id)?.label;
}

/**
 * Registry ids other than the default, in display order.
 * Used to expand a single npm install option into one option per source.
 */
export function mirrorRegistryIds(): NpmRegistryId[] {
  return NPM_REGISTRIES.filter((r) => r.id !== DEFAULT_NPM_REGISTRY_ID).map((r) => r.id);
}
