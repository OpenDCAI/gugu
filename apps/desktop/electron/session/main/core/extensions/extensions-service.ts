import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { activitySignal } from '../activity/signals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  declaredContexts,
  isValidExtensionId,
  parseExtensionManifest,
  safeParseExtensionManifest,
  capabilityCovered,
  grantedReach,
  withCoveredCapabilities,
  type AgentReach,
  type ExtensionCapability,
  type ExtensionManifest,
} from '@shared/extensions/manifest';
import { EXTENSION_ORIGINS, keptRevocations, type ExtensionOrigin } from '@shared/extensions/upgrade';
import { appIdentityOf, appKey, type AppIdentity } from '@shared/extensions/app-identity';
import { resolveAppSettings, type AppSettings } from '@shared/extensions/app-settings';
import { requireAppPlatform } from '@shared/extensions/app-platforms';

import { z } from 'zod';
import { appVariantsSchema, type AppVariants, type ExtensionVariant } from '@shared/extensions/variants';

export type { ExtensionOrigin };

/**
 * Inventory of installed task extensions. The extensions root holds one
 * directory per extension, named by its manifest id; the directory scan is the
 * single source of truth (no side index that can drift). Refs #2374.
 *
 * This module stays free of electron imports: the root directory is injected
 * so the whole service is unit-testable against a temp dir. The app-level
 * singleton is created where the service is first consumed (controller).
 */

export const EXTENSION_MANIFEST_FILENAME = 'manifest.json';

/** Dot-prefixed so an interrupted install can never be mistaken for inventory. */
const STAGING_PREFIX = '.staging-';
const TRASH_PREFIX = '.trash-';

/**
 * Where withdrawn permissions are recorded, as `{ [extensionId]: host[] }`.
 *
 * A file rather than something derived from the bundle, because it holds what
 * the *user* decided and the bundle holds what the *author* asked for — an
 * upgrade rewrites the second and must not quietly overwrite the first. Kept
 * beside the bundles and dot-prefixed so the inventory scan (which reads
 * directories) never sees it, and pruned on uninstall so a reinstall does not
 * inherit a decision about an extension the user removed.
 */
const REVOCATIONS_FILENAME = '.revoked-permissions.json';

/**
 * Which installed extensions the user has switched off, as `extensionId[]`.
 *
 * "Off" sits between installed and uninstalled (owner, #5265: 可用/不可用 is its
 * own rung, and the workspace panel toggles it; uninstall stays in Settings). The
 * bundle stays on disk with its data and its consent; only activation is refused
 * and its tabs stop being offered. Same file discipline as the revocations: a
 * user decision kept beside the bundles, dot-prefixed so the scan never sees it,
 * pruned on uninstall.
 */
const DISABLED_FILENAME = '.disabled-extensions.json';
const SETTINGS_FILENAME = '.app-settings.json';

/**
 * The Apps pinned to the far-left rail (its dock), `extensionId[]` in the order they show. This machine's only: an App is
 * installed on a machine, and what is not installed here cannot open here. Same file discipline, pruned on uninstall.
 */
const DOCK_FILENAME = '.dock.json';

/**
 * The market Apps that are not updated by themselves (owner 10-19: market Apps update by themselves, as VS Code's do): the
 * person switched it off, or installed an older version than the market gives this machine — VS Code's `pinned` and its
 * per-extension 「Auto Update」 are one switch here. `extensionId[]`; same file discipline, pruned on uninstall.
 */
const AUTO_UPDATE_OFF_FILENAME = '.auto-update-off.json';

/**
 * D-30 「给哪些 agent」, this computer's half: `{ [<publisher>/<id>]: 'here:all'[] }` (host-actions
 * `HERE_*`), by the App's identity as the chats' rows are (`chat.app_enablements`): another publisher's App under the same
 * id does not inherit them. An App with no entry was never chosen for, and reaches every agent here (125 10-06); an entry,
 * even an empty one, is what the person chose. This machine's only, like the install; pruned on uninstall.
 */
const GIVEN_HERE_FILENAME = '.given-here.json';

/**
 * Which installed extensions list their agent tools natively in new sessions, as `extensionId[]`
 * (#6615, D-10). Every other extension is `progressive`: its tools are reached through the catalog.
 * Same file discipline as the disabled list, pruned on uninstall.
 */
const FULL_DISCLOSURE_FILENAME = '.full-disclosure-extensions.json';

export type ExtensionDisclosure = 'full' | 'progressive';

/**
 * #6646 (E-05) Where each installed extension came from, as `{ [extensionId]: origin }`. Kept from #6646 on,
 * so one installed before has no entry. Same file discipline as the revocations, pruned on uninstall.
 */
const ORIGINS_FILENAME = '.extension-origins.json';
/**
 * 摩擦单 F66 (统筹 06:16): who published each App installed from a chat or a folder — the person behind the card's sender
 * (an agent's owner; #7290, owner 10-17), or the account installing a folder — and their name, as
 * `{ [extensionId]: { id, name } }`. Half of the App's identity (app-identity.ts), kept from the install on: never read
 * off whoever is signed in later. An update from anyone else is asked about in full. Pruned on uninstall, like the origins.
 */
const PUBLISHERS_FILENAME = '.extension-publishers.json';

/** Who published an App installed from a chat or a folder (`PUBLISHERS_FILENAME`). */
export interface ExtensionPublisher {
  id: string;
  /** As the identity directory names them; none for a folder's (nothing is read to install a folder). */
  name?: string;
}
/**
 * 「始终用它」(真源 §2.4, 主人 09-29): the App the person chose for one kind of file in one
 * context, `<context>:<suffix>` → tab kind (file-openers.ts `openWithKey`).
 */
const OPEN_WITH_FILENAME = '.open-with-defaults.json';
/** `<context>:<claim>` — a suffix (`.csv`) or, since 摩擦单 F82, a file name (`todo.md`, `todo-*.md`), lowercase. */
const OPEN_WITH_KEY = /^(session|chat):(\.[a-z0-9][a-z0-9.+-]*|[a-z0-9_*+-][a-z0-9._*+ -]{0,127})$/;

/**
 * What a bundle declares, plus a fingerprint of the file that declares it.
 *
 * The user consents to a permission list read off disk, and the install then
 * reads that file again. Carrying the fingerprint back is what ties the two
 * reads together: without it, a manifest edited while the confirm dialog is up
 * installs permissions that were never shown to anyone.
 */
export interface InspectedExtension {
  manifest: ExtensionManifest;
  manifestDigest: string;
}

export interface InstalledExtension {
  manifest: ExtensionManifest;
  /** Absolute path of the installed bundle directory. */
  rootDir: string;
  /** Fingerprint of the installed manifest — names this exact version (same value install checks). */
  manifestDigest: string;
}

/** A directory under the extensions root that is not a valid extension. */
export interface InvalidExtensionDir {
  dirName: string;
  reason: string;
}

export class ExtensionsService {
  private readonly variantsFile: JsonFile<Record<string, AppVariants>>;
  private readonly grantsFile: JsonFile<Record<string, NonNullable<ExtensionManifest['permissions']>>>;
  private readonly settingsFile: JsonFile<Record<string, AppSettings>>;
  private readonly revocationsFile: JsonFile<Record<string, string[]>>;
  private readonly disabledFile: JsonFile<string[]>;
  private readonly fullDisclosureFile: JsonFile<string[]>;
  private readonly dockFile: JsonFile<string[]>;
  private readonly autoUpdateOffFile: JsonFile<string[]>;
  private readonly givenHereFile: JsonFile<Record<string, string[]>>;
  private readonly originsFile: JsonFile<Record<string, ExtensionOrigin>>;
  private readonly publishersFile: JsonFile<Record<string, ExtensionPublisher>>;
  private readonly openWithFile: JsonFile<Record<string, string>>;

  constructor(private readonly rootDir: string) {
    this.variantsFile = jsonFile(rootDir, '.variants.json', '{}', (value) => Object.assign(Object.create(null) as Record<string, AppVariants>, z.record(z.string(), appVariantsSchema).parse(value)));
    this.grantsFile = jsonFile(rootDir, '.granted-permissions.json', '{}', (value) => z.record(z.string(), z.object({ capabilities: z.array(z.string()), network: z.array(z.string()) })).parse(value) as Record<string, NonNullable<ExtensionManifest['permissions']>>);
    this.settingsFile = jsonFile(rootDir, SETTINGS_FILENAME, '{}', (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid App settings file');
      return value as Record<string, AppSettings>;
    }, 0o600);
    this.revocationsFile = jsonFile(rootDir, REVOCATIONS_FILENAME, '{}', readRevocationsJson);
    this.disabledFile = jsonFile(rootDir, DISABLED_FILENAME, '[]', stringList(DISABLED_FILENAME, 'extension ids'));
    this.fullDisclosureFile = jsonFile(rootDir, FULL_DISCLOSURE_FILENAME, '[]', stringList(FULL_DISCLOSURE_FILENAME, 'extension ids'));
    this.dockFile = jsonFile(rootDir, DOCK_FILENAME, '[]', stringList(DOCK_FILENAME, 'App ids'));
    this.autoUpdateOffFile = jsonFile(rootDir, AUTO_UPDATE_OFF_FILENAME, '[]', stringList(AUTO_UPDATE_OFF_FILENAME, 'App ids'));
    this.givenHereFile = jsonFile(rootDir, GIVEN_HERE_FILENAME, '{}', mapOf<string[]>(GIVEN_HERE_FILENAME, 'places',
      (value) => Array.isArray(value) && value.every((place) => typeof place === 'string')));
    this.originsFile = jsonFile(rootDir, ORIGINS_FILENAME, '{}', mapOf<ExtensionOrigin>(ORIGINS_FILENAME, 'extension origins',
      (origin) => (EXTENSION_ORIGINS as readonly unknown[]).includes(origin)));
    this.publishersFile = jsonFile(rootDir, PUBLISHERS_FILENAME, '{}', mapOf<ExtensionPublisher>(PUBLISHERS_FILENAME, 'extension publishers',
      (value) => !!value && typeof value === 'object' && typeof (value as ExtensionPublisher).id === 'string' &&
        ['string', 'undefined'].includes(typeof (value as ExtensionPublisher).name)));
    this.openWithFile = jsonFile(rootDir, OPEN_WITH_FILENAME, '{}', mapOf<string>(OPEN_WITH_FILENAME, 'file kinds to tabs',
      (tabKind) => typeof tabKind === 'string'));
  }

  settings(extensionId: string): AppSettings {
    const stored = this.settingsFile.read();
    return resolveAppSettings(this.get(extensionId).manifest, Object.hasOwn(stored, extensionId) ? stored[extensionId] : {}, true);
  }

  setSettings(extensionId: string, input: unknown): AppSettings {
    const settings = resolveAppSettings(this.get(extensionId).manifest, input);
    this.settingsFile.write({ ...this.settingsFile.read(), [extensionId]: settings });
    return settings;
  }

  /**
   * Scans the extensions root. Invalid directories are reported, not silently
   * skipped — a corrupt bundle must be visible without bricking the rest.
   */
  list(): { extensions: InstalledExtension[]; invalid: InvalidExtensionDir[] } {
    if (!fs.existsSync(this.rootDir)) return { extensions: [], invalid: [] };
    const extensions: InstalledExtension[] = [];
    const invalid: InvalidExtensionDir[] = [];
    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      // Dot-directories are install staging/trash leftovers, never inventory.
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      try {
        extensions.push(this.readExtensionDir(entry.name));
      } catch (error) {
        invalid.push({
          dirName: entry.name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    extensions.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    return { extensions, invalid };
  }

  get(extensionId: string): InstalledExtension {
    if (!isValidExtensionId(extensionId)) {
      throw new Error(`Invalid App id: ${extensionId}`);
    }
    if (!this.isInstalled(extensionId)) {
      throw new Error(`App not installed: ${extensionId}`);
    }
    return this.readExtensionDir(extensionId);
  }

  /** Whether a bundle is in place under this id (readable or not). */
  isInstalled(extensionId: string): boolean {
    return isValidExtensionId(extensionId) && fs.existsSync(path.join(this.rootDir, extensionId));
  }

  /**
   * Reads and validates a bundle without installing it, so the install flow can
   * show what the extension is and which permissions it declares *before* the
   * user consents. Throws exactly what installFromDirectory would throw.
   */
  inspectDirectory(sourceDir: string): InspectedExtension {
    const { manifest, manifestDigest } = this.validateSource(sourceDir);
    return { manifest, manifestDigest };
  }

  /**
   * Installs (or replaces) the extension whose bundle lives at sourceDir.
   * The copy goes through a staging directory and lands via rename, so a
   * crashed install never leaves a half-written bundle under the extension's
   * id, and a replace that fails puts the previous version back.
   *
   * `consentedDigest` is the fingerprint `inspectDirectory` handed back with the
   * permission list the user agreed to. It is required rather than optional: the
   * check is only worth anything if no caller can install without it.
   */
  installFromDirectory(sourceDir: string, consentedDigest: string, origin: ExtensionOrigin, publisher?: ExtensionPublisher, variant?: ExtensionVariant): InstalledExtension {
    const { source, manifest, manifestDigest } = this.validateSource(sourceDir);
    requireAppPlatform(manifest, 'desktop');
    // Read the withdrawal record up front. It is written after the bundle lands,
    // and reading it can throw — doing that afterwards would report a failed
    // install for one that already happened: the new bundle on disk, the caller
    // told it failed, the session never reconfigured, the screen never refreshed.
    const revocations = this.revocationsFile.read();
    const origins = this.origins();
    const publishers = this.publishers();
    const identity = appIdentityOf({ manifest, origin, publisher });
    const grants = this.grantsFile.read();
    const previousIdentity = this.identityOf(manifest.id);
    const previous = previousIdentity && identity && appKey(previousIdentity) === appKey(identity) && this.isInstalled(manifest.id) ? this.approvedManifest(manifest.id).permissions : undefined;
    const approved = {
      capabilities: [...new Set([...(previous?.capabilities ?? []), ...(manifest.permissions?.capabilities ?? [])])],
      network: [...new Set([...(previous?.network ?? []), ...(manifest.permissions?.network ?? [])])],
    };
    const variants = this.variantsFile.read();
    const variantState = variants[manifest.id];
    if (variantState && !variant) throw new Error(`App ${manifest.id} has variants; install its upstream version or switch a named variant.`);
    if (variant && variant.name !== 'upstream' && !variantState) throw new Error(`App ${manifest.id} has no upstream variant; fork it with app_create first.`);
    // A preinstalled App's id is gugu's: a folder, market or chat package claiming it would replace
    // part of gugu (and be put back at the next start anyway).
    if (origins[manifest.id] === 'preinstalled' && origin !== 'preinstalled') {
      throw new Error(`"${manifest.id}" is a preinstalled App; another package cannot replace it.`);
    }
    if (manifestDigest !== consentedDigest) {
      // The folder changed between being shown and being installed. Refuse
      // rather than install what nobody saw — asking again is cheap, and the
      // second ask shows whatever it says now.
      throw new Error(
        'This folder changed after its permissions were shown. Nothing was installed — open it again to review what it asks for now.'
      );
    }

    fs.mkdirSync(this.rootDir, { recursive: true });
    this.sweepInterruptedInstalls();

    const staging = path.join(this.rootDir, `${STAGING_PREFIX}${manifest.id}-${randomHex()}`);
    const target = path.join(this.rootDir, manifest.id);
    // The first install (none of this id here) is where an App's own choices count; read up front, like the withdrawals.
    const firstInstall = fs.existsSync(target) ? null : { full: this.fullDisclosureFile.read(), dock: this.dock() };
    let displaced: string | null = null;
    try {
      // Symlinks are copied as links, never followed: dereferencing would pull
      // whatever a bundle points at — a key, someone's documents — into the
      // extension's own origin, where it is then served to the extension.
      fs.cpSync(source, staging, { recursive: true, dereference: false, verbatimSymlinks: true, ...(origin === 'fork' ? { filter: (file: string) => path.basename(file) !== '.git' } : {}) });

      // Re-check the copy, not the folder it came from. The digest above was
      // taken before this copy; anything that rewrote the source in between
      // would otherwise land unseen. The containment check inside also catches a
      // manifest symlinked out of the bundle.
      //
      // ⚠️ Scope: this covers `manifest.json` and nothing else. It ties the
      // install to *the permissions the user agreed to*, which is what the
      // consent was about — it is not a signature over the code. Two folders
      // with identical manifests and different code are interchangeable here,
      // by design: nobody was shown the code either way.
      //
      // ⚠️ No automated judge for this specific window: reproducing it means
      // rewriting the source *during* cpSync, and `node:fs` exports cannot be
      // spied under ESM. The symlink case and the dialog-window case next to it
      // are both covered; this line closes a race that is argued, not measured.
      const stagedDigest = createHash('sha256').update(readManifestText(staging)).digest('hex');
      if (stagedDigest !== consentedDigest) {
        throw new Error(
          'This folder changed after its permissions were shown. Nothing was installed — open it again to review what it asks for now.'
        );
      }

      if (fs.existsSync(target)) {
        if (variantState) this.cacheVariant(manifest.id, variantState.active, target);
        displaced = path.join(this.rootDir, `${TRASH_PREFIX}${manifest.id}-${randomHex()}`);
        fs.renameSync(target, displaced);
      }
      fs.renameSync(staging, target);
    } catch (error) {
      // Put the working install back. Losing the extension the user already had
      // is a worse outcome than the upgrade they attempted not happening.
      if (displaced && !fs.existsSync(target)) {
        fs.renameSync(displaced, target);
        displaced = null;
      }
      throw error;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
      if (displaced) fs.rmSync(displaced, { recursive: true, force: true });
    }
    // No install restores a withdrawal; only the person does, in settings (`keptRevocations`).
    const kept = keptRevocations(revocations[manifest.id] ?? [], { ...manifest, permissions: approved });
    if ((revocations[manifest.id] ?? []).length !== kept.length) {
      if (kept.length > 0) revocations[manifest.id] = kept;
      else delete revocations[manifest.id];
      this.revocationsFile.write(revocations);
    }
    origins[manifest.id] = origin;
    this.originsFile.write(origins);
    // A package from a chat or a folder has a publisher; one installed without (preinstalled, market: gugu's) has none.
    if (publisher) publishers[manifest.id] = { ...publisher };
    else delete publishers[manifest.id];
    this.publishersFile.write(publishers);
    if (identity) { grants[appKey(identity)] = approved; this.grantsFile.write(grants); }
    if (variant) {
      variants[manifest.id] = { active: variant.name, variants: [...(variantState?.variants ?? []).filter((entry) => entry.name !== variant.name), variant] };
      this.variantsFile.write(variants);
    }
    // From then on both are the person's: an upgrade over it changes neither, and uninstalling forgets both.
    if (firstInstall) {
      if (manifest.contributes.toolsListed && !firstInstall.full.includes(manifest.id)) {
        this.fullDisclosureFile.write([...firstInstall.full, manifest.id]);
      }
      // Owner 10-06「装之后应该自动 pin 吧」: an App with a page of its own goes on the rail (`setDock`'s rule), whoever
      // installed it — a preinstalled one too. The workspace only opens files, so the same rule leaves it off.
      const ownPage = manifest.contributes.tabs.some((tab) => declaredContexts(tab).length === 0);
      if (ownPage && !firstInstall.dock.includes(manifest.id)) {
        this.dockFile.write([...firstInstall.dock, manifest.id]);
      }
    }
    const installed = this.get(manifest.id);
    if (origin !== 'preinstalled') activitySignal({ event_id: randomUUID(), kind: firstInstall ? 'app.installed' : 'app.replaced',
      object_id: manifest.id, app_version: manifest.version, occurred_at: Date.now() });
    return installed;
  }

  /** The union of declarations the person has approved for this identity, used by the existing consent difference. */
  approvedManifest(id: string): ExtensionManifest {
    const manifest = this.get(id).manifest;
    const identity = this.identityOf(id);
    const permissions = identity ? this.grantsFile.read()[appKey(identity)] : undefined;
    return permissions ? { ...manifest, permissions } : manifest;
  }

  variants(id: string): AppVariants {
    this.get(id);
    return this.variantsFile.read()[id] ?? { active: 'upstream', variants: [] };
  }

  variantDirectory(id: string, name: string): string {
    if (!isValidExtensionId(id)) throw new Error(`Invalid App id: ${id}`);
    appVariantsSchema.shape.active.parse(name);
    return path.join(path.dirname(this.rootDir), 'extension-variants', id, name);
  }

  /** Keep the installed upstream before creating the first fork. Never reads a new market version instead. */
  retainUpstream(id: string, variant: ExtensionVariant): void {
    const variants = this.variantsFile.read();
    if (variants[id]) return;
    if (variant.name !== 'upstream') throw new Error('Expected the upstream variant');
    const installed = this.get(id);
    this.cacheVariant(id, variant.name, installed.rootDir);
    variants[id] = { active: 'upstream', variants: [variant] };
    this.variantsFile.write(variants);
  }

  cacheVariant(id: string, name: string, sourceDir: string): string {
    const target = this.variantDirectory(id, name);
    if (path.resolve(sourceDir) === target) return target;
    const staging = `${target}-${randomHex()}`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.cpSync(sourceDir, staging, { recursive: true, dereference: false, verbatimSymlinks: true, filter: (source) => path.basename(source) !== '.git' });
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staging, target);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    return target;
  }

  /** Who published each App installed from a chat (摩擦单 F66); throws on a file it cannot read, like the origins. */
  publishers(): Record<string, ExtensionPublisher> {
    return this.publishersFile.read();
  }

  /** Who published an App installed here, and its id (app-identity.ts): what a chat's row names it by; null without one. */
  identityOf(id: string): AppIdentity | null {
    return appIdentityOf({ manifest: { id }, origin: this.origins()[id], publisher: this.publishers()[id] });
  }

  /** D-30: this computer's places the App of this identity is given at, or null when the person never chose (every agent). */
  givenHere(app: AppIdentity): string[] | null {
    return this.givenHereFile.read()[appKey(app)] ?? null;
  }

  /** The person's choice of this computer's places for an App (the whole set; null forgets it, as an uninstall does). */
  setGivenHere(app: AppIdentity, places: readonly string[] | null): void {
    const given = this.givenHereFile.read();
    if (places === null) {
      if (!(appKey(app) in given)) return;
      delete given[appKey(app)];
    } else {
      given[appKey(app)] = [...new Set(places)];
    }
    this.givenHereFile.write(given);
  }

  /** #6646 Where each installed extension came from; throws on a file it cannot read, like the revocations. */
  origins(): Record<string, ExtensionOrigin> {
    return this.originsFile.read();
  }

  /**
   * An App gugu installed itself (`preinstalled`) that this build no longer ships: from now on it is the person's, an
   * ordinary market App — they can switch it off, uninstall it, update it from the market (gugu's Apps live there).
   * Only where it came from changes: its bytes, its data, the agents it is given to and what was withdrawn stay as they
   * are. Refuses for an App not recorded as preinstalled.
   */
  releasePreinstalled(extensionId: string): void {
    const origins = this.origins();
    if (origins[extensionId] !== 'preinstalled') throw new Error(`"${extensionId}" is not a preinstalled App`);
    origins[extensionId] = 'market';
    this.originsFile.write(origins);
  }

  /**
   * Removes staging and trash directories left by an install that died partway.
   * They are hidden from `list()` by design, so nothing else would ever notice
   * them, and each one is a full copy of a bundle.
   */
  private sweepInterruptedInstalls(): void {
    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(STAGING_PREFIX) && !entry.name.startsWith(TRASH_PREFIX)) continue;
      fs.rmSync(path.join(this.rootDir, entry.name), { recursive: true, force: true });
    }
  }

  /**
   * Hosts this extension may actually reach: what it declared, minus what the
   * user took back. This is the list the session enforces and the CSP mirrors —
   * the manifest alone is a request, not a grant.
   */
  grantedHosts(extensionId: string): string[] {
    const declared = this.get(extensionId).manifest.permissions?.network ?? [];
    const revoked = new Set(this.revocationsFile.read()[extensionId] ?? []);
    return declared.filter((host) => !revoked.has(host));
  }

  /**
   * Capabilities this extension may actually use: declared minus withdrawn, with the narrower words those cover.
   *
   * The bridge asks this on every call rather than caching it at activation —
   * a capability the user takes back has to stop working on the next call, not
   * on the next restart, which is the same contract the network list already has.
   */
  grantedCapabilities(extensionId: string): ExtensionCapability[] {
    // An App no longer installed may do nothing — and asking must say so, not throw: what it left running asks (a
    // program's file frame, a watched workspace file changing after an uninstall, 10-06), and a throw in main is
    // gugu's own exit. hasCapability and every other caller go through here.
    if (!this.isInstalled(extensionId)) return [];
    const declared = this.get(extensionId).manifest.permissions?.capabilities ?? [];
    const revoked = new Set(this.revocationsFile.read()[extensionId] ?? []);
    return withCoveredCapabilities(declared.filter((capability) => !revoked.has(capability)));
  }

  /**
   * Whether the extension may do this, counting a wider grant as covering a
   * narrower one.
   *
   * `agents:read:all-machines` ⊇ `agents:read:all` ⊇ `agents:read`: the same verb at
   * different reach, and the bridge asks for the narrow word because that is
   * the minimum the call needs. Without this, an extension that declared only
   * the wide word — the honest thing to do, since declaring two is refused by
   * the schema — would be turned away at the door.
   *
   * ❌ 别反过来:窄的永远不满足宽的。
   */
  hasCapability(extensionId: string, capability: ExtensionCapability): boolean {
    return capabilityCovered(this.grantedCapabilities(extensionId), capability);
  }

  /**
   * How far an App's `agents:*` tier reaches: the agents it started, this machine's, or all machines'. The one place
   * that reads it — the listing, the change events and every verb ask here, so a new tier cannot be missed by one of them.
   */
  agentReach(extensionId: string, family: 'agents:read' | 'agents:history' | 'agents:control'): AgentReach {
    return grantedReach(this.grantedCapabilities(extensionId), family);
  }

  /** Ids the user has switched off. Order is the order they were switched off in. */
  disabledIds(): string[] {
    return this.disabledFile.read();
  }

  isEnabled(extensionId: string): boolean {
    return !this.disabledFile.read().includes(extensionId);
  }

  /**
   * Switches an installed extension off or back on. Off means: activation is
   * refused and the renderer stops offering its tabs; nothing on disk changes.
   * Refuses for an extension that is not installed — a record about nothing
   * would sit in the file forever, and a later install of that id would arrive
   * silently switched off.
   */
  setEnabled(extensionId: string, enabled: boolean): void {
    this.get(extensionId);
    if (!enabled && this.origins()[extensionId] === 'preinstalled') {
      throw new Error(`"${extensionId}" is a preinstalled App and cannot be switched off.`);
    }
    const disabled = new Set(this.disabledFile.read());
    if (enabled) disabled.delete(extensionId);
    else disabled.add(extensionId);
    this.disabledFile.write([...disabled]);
  }

  /** The installed Apps that are not updated by themselves. Unreadable throws, like the lists above. */
  autoUpdateOffIds(): string[] {
    return this.autoUpdateOffFile.read();
  }

  /** An installed App's 「自动更新」 switch. Refuses for one not installed, as `setEnabled` does. */
  setAutoUpdate(extensionId: string, on: boolean): void {
    this.get(extensionId);
    const off = new Set(this.autoUpdateOffFile.read());
    if (on) off.delete(extensionId);
    else off.add(extensionId);
    this.autoUpdateOffFile.write([...off]);
  }

  /** The Apps on the far-left rail, in order (its dock). Unreadable throws, like the lists above. */
  dock(): string[] {
    return this.dockFile.read();
  }

  /**
   * The whole dock at once: pinning, taking off and reordering are one write of the list. Only installed Apps with a
   * page of their own — a tab that opens no file; an App that only opens files has nothing to show from the rail.
   */
  setDock(ids: readonly string[]): string[] {
    const dock = [...new Set(ids)];
    for (const id of dock) {
      if (!this.get(id).manifest.contributes.tabs.some((tab) => declaredContexts(tab).length === 0)) {
        throw new Error(`"${id}" only opens files; it has no page of its own to pin`);
      }
    }
    this.dockFile.write(dock);
    return dock;
  }

  /**
   * The remembered 「始终用它」 choices; throws on a file it cannot read, like the origins. A key this build does not
   * read — `group:<claim>`, which builds before #6913 wrote for a chat's files — is left out as it is read: that one
   * choice is made again (owner 10-05: accepted, no migration), and every other choice still holds.
   */
  openWithDefaults(): Record<string, string> {
    const kept = Object.entries(this.openWithFile.read()).filter(([key]) => OPEN_WITH_KEY.test(key));
    return Object.assign(Object.create(null) as Record<string, string>, Object.fromEntries(kept));
  }

  /** Remember (or, with `null`, forget) the App for `key` (`<context>:<suffix>`). */
  setOpenWithDefault(key: string, tabKind: string | null): void {
    if (!OPEN_WITH_KEY.test(key)) throw new Error(`Not a file kind: ${key}`);
    const defaults = this.openWithDefaults();
    if (tabKind === null) delete defaults[key];
    else defaults[key] = tabKind;
    this.openWithFile.write(defaults);
  }

  /** How the extension's agent tools reach a session that starts now. */
  disclosure(extensionId: string): ExtensionDisclosure {
    return this.fullDisclosureFile.read().includes(extensionId) ? 'full' : 'progressive';
  }

  setDisclosure(extensionId: string, level: ExtensionDisclosure): void {
    this.get(extensionId);
    const full = new Set(this.fullDisclosureFile.read());
    if (level === 'full') full.add(extensionId);
    else full.delete(extensionId);
    this.fullDisclosureFile.write([...full]);
  }

  /** Everything the user has taken back — declared hosts and capabilities alike. */
  revokedPermissions(extensionId: string): string[] {
    return this.revocationsFile.read()[extensionId] ?? [];
  }

  /**
   * Takes a single declared permission away, or gives it back — a network host
   * or a capability, the same record either way. The extension keeps working;
   * it just cannot do that one thing any more, which is the difference between
   * managing an extension and having to uninstall it to say no.
   */
  setPermissionGranted(extensionId: string, permission: string, granted: boolean): void {
    const permissions = this.get(extensionId).manifest.permissions;
    const declared = [...(permissions?.network ?? []), ...(permissions?.capabilities ?? [])];
    if (!declared.includes(permission)) {
      // Nothing else in the system would notice a revocation for something this
      // extension never asked for; it would just sit in the file forever.
      throw new Error(`App "${extensionId}" does not declare permission: ${permission}`);
    }
    const revocations = this.revocationsFile.read();
    const current = new Set(revocations[extensionId] ?? []);
    if (granted) current.delete(permission);
    else current.add(permission);
    if (current.size === 0) delete revocations[extensionId];
    else revocations[extensionId] = [...current];
    this.revocationsFile.write(revocations);
  }

  uninstall(extensionId: string): void {
    if (!isValidExtensionId(extensionId)) {
      throw new Error(`Invalid App id: ${extensionId}`);
    }
    const target = path.join(this.rootDir, extensionId);
    if (!fs.existsSync(target)) {
      throw new Error(`App not installed: ${extensionId}`);
    }
    if (this.origins()[extensionId] === 'preinstalled') {
      throw new Error(`"${extensionId}" is a preinstalled App and cannot be uninstalled.`);
    }
    // Rename first so a partially deleted bundle can never be mistaken for an
    // installed extension by a concurrent list().
    // Before the bundle is touched, not after: reading this can throw, and a
    // throw after the delete would leave the extension gone from disk while the
    // caller sees a failure and skips the rest of its teardown — its cookies and
    // localStorage would outlive it. Nothing is destroyed until every step that
    // can fail has succeeded.
    this.forgetRevocations(extensionId);
    const settings = this.settingsFile.read();
    if (Object.hasOwn(settings, extensionId)) {
      delete settings[extensionId];
      this.settingsFile.write(settings);
    }
    // Before its origin and publisher go: they are what names it (`identityOf`).
    const identity = this.identityOf(extensionId);
    if (identity) {
      this.setGivenHere(identity, null);
      const grants = this.grantsFile.read();
      delete grants[appKey(identity)];
      this.grantsFile.write(grants);
    }
    const variants = this.variantsFile.read();
    delete variants[extensionId];
    this.variantsFile.write(variants);
    fs.rmSync(path.dirname(this.variantDirectory(extensionId, 'upstream')), { recursive: true, force: true });
    const origins = this.origins();
    if (origins[extensionId]) {
      delete origins[extensionId];
      this.originsFile.write(origins);
    }
    const publishers = this.publishers();
    if (publishers[extensionId]) {
      delete publishers[extensionId];
      this.publishersFile.write(publishers);
    }
    // Same reason: "off" was a decision about something that no longer exists,
    // and a reinstall must not arrive switched off.
    // #6984 Pruned here, not through setEnabled / setDisclosure: those read the manifest first, and an App
    // whose manifest no longer reads (an older apiVersion) is exactly the one the person is trying to remove.
    const disabled = this.disabledFile.read();
    if (disabled.includes(extensionId)) this.disabledFile.write(disabled.filter((id) => id !== extensionId));
    const full = this.fullDisclosureFile.read();
    if (full.includes(extensionId)) this.fullDisclosureFile.write(full.filter((id) => id !== extensionId));
    const dock = this.dock();
    if (dock.includes(extensionId)) this.dockFile.write(dock.filter((id) => id !== extensionId));
    const autoUpdateOff = this.autoUpdateOffFile.read();
    if (autoUpdateOff.includes(extensionId)) this.autoUpdateOffFile.write(autoUpdateOff.filter((id) => id !== extensionId));

    const trash = path.join(this.rootDir, `${TRASH_PREFIX}${extensionId}-${randomHex()}`);
    fs.renameSync(target, trash);
    fs.rmSync(trash, { recursive: true, force: true });
  }

  /**
   * Drops every withdrawal recorded for one extension.
   *
   * Called on uninstall (the decision was about something that no longer
   * exists) and on install (an install always follows a consent that enumerated
   * everything not already granted — so anything still switched off afterwards
   * would be a decision the user was never shown, and a host the new version
   * stopped declaring could never be switched back on again).
   */
  private forgetRevocations(extensionId: string): void {
    const revocations = this.revocationsFile.read();
    if (!revocations[extensionId]) return;
    delete revocations[extensionId];
    this.revocationsFile.write(revocations);
  }

  /** Shared gate for inspect and install: the bundle must parse and be self-contained. */
  private validateSource(sourceDir: string): {
    source: string;
    manifest: ExtensionManifest;
    manifestDigest: string;
  } {
    const source = path.resolve(sourceDir);
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
      throw new Error(`App source is not a directory: ${source}`);
    }
    if (isInside(source, this.rootDir)) {
      throw new Error(`App source must live outside the folder Apps are installed in: ${source}`);
    }
    const text = readManifestText(source);
    const manifest = parseExtensionManifest(parseManifestJson(text, source));
    if (manifest.entry) resolveExistingBundleFile(source, manifest.entry, 'entry');
    for (const tab of manifest.contributes.tabs) if (tab.entry) resolveExistingBundleFile(source, tab.entry, `tab ${tab.name}`);
    // Over the raw bytes, not the parsed object: what the user agreed to is the
    // file as it stood, and a re-parse would forgive whatever the schema ignores.
    return { source, manifest, manifestDigest: createHash('sha256').update(text).digest('hex') };
  }

  private readExtensionDir(dirName: string): InstalledExtension {
    const bundleDir = path.join(this.rootDir, dirName);
    const parsed = safeParseExtensionManifest(readManifestJson(bundleDir));
    if (!parsed.ok) {
      throw new Error(`Invalid manifest:\n- ${parsed.issues.join('\n- ')}`);
    }
    if (parsed.manifest.id !== dirName) {
      throw new Error(
        `Directory name "${dirName}" does not match manifest id "${parsed.manifest.id}"`
      );
    }
    if (parsed.manifest.entry) resolveExistingBundleFile(bundleDir, parsed.manifest.entry, 'entry');
    for (const tab of parsed.manifest.contributes.tabs) if (tab.entry) resolveExistingBundleFile(bundleDir, tab.entry, `tab ${tab.name}`);
    const manifestDigest = createHash('sha256').update(readManifestText(bundleDir)).digest('hex');
    return { manifest: parsed.manifest, rootDir: bundleDir, manifestDigest };
  }
}

/**
 * Reads a bundle's manifest, requiring the file to really live inside it.
 *
 * ⚠️ The containment check is the point, not a formality. Bundles are copied
 * with symlinks preserved, so a `manifest.json` that is a link to somewhere else
 * on disk keeps pointing there after install — and every later read (`list`,
 * `get`, and through it the enforced host list) follows it. The permissions the
 * user consented to would then be editable from outside the bundle, with no
 * prompt and nothing for the consent digest to bind: the digest would be over
 * bytes the installed extension does not own.
 */
function readManifestText(bundleDir: string): string {
  const manifestPath = path.join(bundleDir, EXTENSION_MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing ${EXTENSION_MANIFEST_FILENAME} in ${bundleDir}`);
  }
  requireContainedInBundle(bundleDir, manifestPath, EXTENSION_MANIFEST_FILENAME);
  return fs.readFileSync(manifestPath, 'utf8');
}

function parseManifestJson(text: string, bundleDir: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `${EXTENSION_MANIFEST_FILENAME} in ${bundleDir} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function readManifestJson(bundleDir: string): unknown {
  return parseManifestJson(readManifestText(bundleDir), bundleDir);
}

/**
 * Resolves a manifest-declared bundle-relative path and requires the file to
 * exist inside the bundle.
 *
 * Containment is judged on the real path, not the written one: the schema
 * rejects '..' segments, but a symlink named `entry.html` pointing anywhere on
 * disk is a perfectly ordinary path that a lexical check would accept.
 */
function resolveExistingBundleFile(bundleDir: string, relative: string, label: string): string {
  const resolved = path.resolve(bundleDir, relative);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label} file not found in bundle: ${relative}`);
  }
  requireContainedInBundle(bundleDir, resolved, label);
  return resolved;
}

function requireContainedInBundle(bundleDir: string, target: string, label: string): void {
  if (!isInside(fs.realpathSync(target), fs.realpathSync(bundleDir))) {
    throw new Error(`${label} path escapes the bundle: ${label}`);
  }
}

function isInside(child: string, parent: string): boolean {
  const resolvedParent = path.resolve(parent);
  return child === resolvedParent || child.startsWith(resolvedParent + path.sep);
}

/**
 * One side file beside the bundles (the revocations, the dock, the origins …): dot-prefixed so the inventory scan never
 * sees it. Read through `validate`, which throws on anything it cannot read rather than falling back to empty — an empty
 * record means "nothing revoked / nothing off", which would quietly undo what the person decided. A missing file reads
 * as `empty`. Written whole through a staging file and a rename, the same landing pattern as an install: a crash partway
 * must not leave a half-written file that every later read throws on.
 */
interface JsonFile<T> {
  read(): T;
  write(value: T): void;
}

function jsonFile<T>(rootDir: string, name: string, empty: '{}' | '[]', validate: (parsed: unknown) => T, mode?: number): JsonFile<T> {
  const file = path.join(rootDir, name);
  return {
    read: () => validate(JSON.parse(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : empty)),
    write: (value) => {
      fs.mkdirSync(rootDir, { recursive: true });
      const staging = `${file}.${randomHex()}`;
      fs.writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
      fs.renameSync(staging, file);
    },
  };
}

function stringList(name: string, what: string): (parsed: unknown) => string[] {
  return (parsed) => {
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) throw new Error(`${name} is not a list of ${what}`);
    return parsed as string[];
  };
}

/** Null-prototype: an App id may be `constructor` or `toString`, which on a plain object resolve through Object.prototype. */
function mapOf<V>(name: string, what: string, valid: (value: unknown) => boolean): (parsed: unknown) => Record<string, V> {
  return (parsed) => {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.values(parsed).every(valid)) {
      throw new Error(`${name} is not a map of ${what}`);
    }
    return Object.assign(Object.create(null) as Record<string, V>, parsed);
  };
}

/**
 * The withdrawn-permission record, `{ [extensionId]: host[] }`. Null-prototype for the same reason as `mapOf`: on a plain
 * object `revokedPermissions('constructor')` would hand back a *function*, `new Set(fn)` would throw on activate, and the
 * whole revocation map would fail to cross IPC for every other extension too.
 */
function readRevocationsJson(parsed: unknown): Record<string, string[]> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${REVOCATIONS_FILENAME} is not an object`);
  }
  const result: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const [extensionId, hosts] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(hosts) || hosts.some((host) => typeof host !== 'string')) {
      throw new Error(`${REVOCATIONS_FILENAME}: "${extensionId}" is not a list of hosts`);
    }
    result[extensionId] = hosts as string[];
  }
  return result;
}

function randomHex(): string {
  return randomBytes(4).toString('hex');
}
