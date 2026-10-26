import type { ExtensionVariant } from '@shared/extensions/variants';
import { forkBehind } from '@shared/extensions/variants';
import type { HandedConsent } from '@shared/extensions/install-consent-flow';
import { extensionsService } from './extensions-root';
import { cloudExtensionMarket } from './market-catalog-root';
import { installPlan } from './install-plan';
import { installPrepared, type InstallDependencies } from './install-prepared';

export async function extensionVariants(id: string) {
  const state = extensionsService().variants(id);
  const current = state.variants.find((entry) => entry.name === state.active);
  const behind = current && state.active !== 'upstream'
    ? forkBehind(current.base, await cloudExtensionMarket().sourceVersions(id)) : null;
  return { ...state, behind };
}

/** The same approval and install path as a folder, with identity and places kept from the installed App. */
export function prepareVariant(dir: string, variant: ExtensionVariant) {
  const service = extensionsService();
  const { manifest, manifestDigest } = service.inspectDirectory(dir);
  const origin = variant.name === 'upstream' ? 'market' as const : 'fork' as const;
  const plan = installPlan(service, manifest, origin);
  const identity = service.identityOf(manifest.id);
  if (!identity) throw new Error(`App ${manifest.id} has no publisher identity; reinstall it from the market before forking.`);
  return {
    dir, manifest, manifestDigest, variant, origin,
    publisher: origin === 'fork' ? { id: identity.publisher } : undefined,
    asks: plan.asks,
    sheet: { installed: plan.approved, revokedPermissions: plan.revokedPermissions },
    places: { first: false, identity },
  };
}

export async function switchExtensionVariant(id: string, name: string, consent?: HandedConsent, dependencies: InstallDependencies = {}) {
  const service = extensionsService();
  const state = service.variants(id);
  const variant = state.variants.find((entry) => entry.name === name);
  if (!variant) throw new Error(`App ${id} has no variant ${JSON.stringify(name)}. Read extensions.variants or install its fork's source_dir first.`);
  if (state.active === name) {
    const installed = service.get(id);
    return { installed: true as const, outcome: 'confirmed' as const, id, name: installed.manifest.name, version: installed.manifest.version, manifest: installed.manifest, rootDir: installed.rootDir, asked: false, announced: 'shown' as const };
  }
  const prepared = prepareVariant(service.variantDirectory(id, name), variant);
  const done = await installPrepared(prepared, consent ?? { kind: 'here' }, dependencies);
  const summary = { id, name: prepared.manifest.name, version: prepared.manifest.version };
  if (done.outcome !== 'confirmed') return { installed: false as const, ...summary, ...done };
  return { installed: true as const, outcome: 'confirmed' as const, ...summary, manifest: done.installed.manifest, rootDir: done.installed.rootDir, asked: done.asked, announced: done.announced };
}
