import type { ExtensionVariant } from '@shared/extensions/variants';
import { createHash } from 'node:crypto';
import { forkBehind } from '@shared/extensions/variants';
import type { HandedConsent } from '@shared/extensions/install-consent-flow';
import { agreeThenInstall } from '@shared/extensions/install-consent-flow';
import { requestExtensionInstallConsent } from './extension-bridge-relay';
import { extensionsService } from './extensions-root';
import { cloudExtensionMarket } from './market-catalog-root';
import { announceInstalledChanged } from './extension-bridge-relay';
import { installPlan } from './install-plan';
import { installPrepared, type InstallDependencies } from './install-prepared';

export async function extensionVariants(id: string, name?: string) {
  const state = extensionsService().variants(id);
  const current = state.variants.find((entry) => entry.name === (name ?? state.active));
  const behind = current && current.name !== 'upstream'
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
    const announced = await announceInstalledChanged(dependencies.notifyInstalledChanged);
    return { installed: true as const, outcome: 'confirmed' as const, id, name: installed.manifest.name, version: installed.manifest.version, manifest: installed.manifest, rootDir: installed.rootDir, asked: false, announced };
  }
  const prepared = prepareVariant(service.variantDirectory(id, name), variant);
  if (prepared.manifest.id !== id) throw new Error(`The cached variant is not App ${id}; reinstall the fork from its source_dir.`);
  const done = await installPrepared(prepared, consent ?? { kind: 'here' }, dependencies);
  const summary = { id, name: prepared.manifest.name, version: prepared.manifest.version };
  if (done.outcome !== 'confirmed') return { installed: false as const, ...summary, ...done };
  return { installed: true as const, outcome: 'confirmed' as const, ...summary, manifest: done.installed.manifest, rootDir: done.installed.rootDir, asked: done.asked, announced: done.announced };
}

/** Confirmation binds the fork, active variant and original that will replace it, including new permissions. */
export async function removeExtensionVariant(id: string, name: string, consent?: HandedConsent, dependencies: InstallDependencies = {}) {
  const service = extensionsService();
  const state = service.variants(id);
  const variant = state.variants.find((entry) => entry.name === name);
  if (name === 'upstream' || !variant) throw new Error(`App ${id} has no removable fork ${JSON.stringify(name)}.`);
  const active = state.active === name;
  const upstream = state.variants.find((entry) => entry.name === 'upstream');
  if (active && !upstream) throw new Error('The original is missing; restore it before removing the active fork.');
  const prepared = active ? prepareVariant(service.variantDirectory(id, 'upstream'), upstream!) : null;
  const fingerprint = () => {
    const snapshot = service.variants(id);
    return createHash('sha256').update(JSON.stringify({ operation: 'remove', id, name, identity: service.identityOf(id), state: snapshot,
      upstreamManifest: snapshot.active === name ? service.inspectDirectory(service.variantDirectory(id, 'upstream')).manifestDigest : undefined })).digest('hex');
  };
  const ask = {
    manifest: prepared?.manifest ?? service.get(id).manifest,
    ...prepared?.sheet,
    revokedPermissions: prepared?.sheet.revokedPermissions ?? service.revokedPermissions(id),
    removeVariant: { name, active },
    manifestDigest: fingerprint(),
  };
  const done = await agreeThenInstall(ask, true, consent ?? { kind: 'here' },
    () => (dependencies.requestInstallConsent ?? requestExtensionInstallConsent)({ ...ask, sourceDir: service.variantDirectory(id, name) }),
    async (enableIn) => {
      if (fingerprint() !== ask.manifestDigest) throw new Error('This fork changed while awaiting confirmation; read it and ask again.');
      if (prepared) {
        try {
          const switched = await switchExtensionVariant(id, 'upstream', { kind: 'given', digest: prepared.manifestDigest, enableIn }, dependencies);
          if (!switched.installed) return { removed: false as const, active: service.variants(id).active, outcome: switched.outcome };
        } catch (error) { return { removed: false as const, active: service.variants(id).active, error: String(error) }; }
      }
      let result;
      try { result = service.removeVariant(id, name); }
      catch (error) { return { removed: false as const, active: service.variants(id).active, error: String(error) }; }
      const announced = await announceInstalledChanged(dependencies.notifyInstalledChanged);
      return { ...result, active: service.variants(id).active, announced };
    });
  if (done.outcome === 'ask') return { outcome: 'ask' as const, asks: true, ask };
  return done.outcome === 'confirmed' ? done.installed : { removed: false as const, outcome: done.outcome };
}
