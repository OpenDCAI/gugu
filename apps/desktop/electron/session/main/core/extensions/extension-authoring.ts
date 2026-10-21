import * as fs from 'node:fs';
import * as path from 'node:path';
import { extensionManifestSchema, type ExtensionManifest } from '@shared/extensions/manifest';

/**
 * Writing an extension, and the one line an agent may not cross.
 *
 * behavior: an agent can build a tab for itself or for the user 「agent 可以创建,
 * 但不能自己批准权限」. Both halves are load-bearing. Creating is authoring — the
 * agent already writes files. Granting is consent, and consent belongs to the
 * person who bears the consequence.
 *
 * So the line is drawn where it can actually be enforced rather than promised:
 * an agent may install **only a bundle that asks for nothing new** (`replacesWithoutAsking`
 * on a reinstall). There is no "agent consented" path anywhere, because a path that
 * exists is a path that gets taken. Anything newly declaring a capability or a network
 * host goes through the same human consent dialog as a bundle from a stranger. Refs #2374.
 */

/** A bundle is its manifest.json and its files; nothing else. */
export interface ScaffoldRequest {
  /** Directory to write the bundle into. Must not already contain one, unless `update`. */
  targetDir: string;
  /**
   * manifest.json as written, not yet read: the manifest's own schema is the one check of its fields.
   *
   * Permissions are accepted here on purpose, even though an install that newly declares one
   * waits for the person: **authoring is not consenting**. An agent that cannot even write down
   * "this tab needs to read the working copy" cannot build for the person at all — it can only
   * build the subset it happens to be allowed to install by itself, which is the tail wagging the dog.
   */
  manifest: Record<string, unknown>;
  /** Every other file, pages included: bundle-relative path → text. */
  files: Record<string, string>;
  /**
   * F93 The folder holds this same App and the caller laid this manifest over the one there: write over it. Files not
   * given stay, and a page may be one already in the folder.
   */
  update?: boolean;
}

export class AgentPermissionRefusal extends Error {
  constructor(readonly declared: string[]) {
    super(
      `This App asks for ${declared.join(', ')}. An agent cannot approve permissions — ` +
        'ask the person you are working with to install it, or remove the permissions and try again.'
    );
    this.name = 'AgentPermissionRefusal';
  }
}

/** Everything a manifest asks the user to agree to. Empty means nothing to agree to. */
export function declaredPermissions(manifest: ExtensionManifest): string[] {
  return [...(manifest.permissions?.capabilities ?? []), ...(manifest.permissions?.network ?? [])];
}

/**
 * Writes a bundle an agent can then install.
 *
 * Refuses a manifest that would not parse, or one naming a page that is not among the files, rather
 * than writing a directory that only fails later at install: the agent is holding the pen right now
 * and can fix it, which is the cheapest moment this will ever be fixable.
 */
export function scaffoldExtension(request: ScaffoldRequest): {
  sourceDir: string;
  manifest: ExtensionManifest;
} {
  const sourceDir = path.resolve(request.targetDir);
  // F93 An update (the caller read the bundle there and it is this App) writes over it; anything else there is refused.
  if (!request.update && fs.existsSync(path.join(sourceDir, 'manifest.json'))) {
    throw new Error(`${sourceDir} already contains an App bundle`);
  }
  // Parsed before anything is written: a bundle on disk that cannot be read back
  // is worse than a refusal, because it looks like progress.
  const manifest = extensionManifestSchema.parse(request.manifest);
  const inBundle = (relative: string) => path.relative(sourceDir, path.resolve(sourceDir, relative));
  const files = Object.entries(request.files).map(([relative, content]) => {
    const target = path.resolve(sourceDir, relative);
    if (!target.startsWith(sourceDir + path.sep) || inBundle(relative) === 'manifest.json') {
      throw new Error(`${relative}: not a file this bundle may add`);
    }
    return { target, relative: inBundle(relative), content };
  });
  const written = new Set(files.map((file) => file.relative));
  const pages = [
    ...manifest.contributes.tabs.filter((tab) => !tab.hostPage).map((tab) => ({ what: `tab "${tab.name}"'s page`, entry: tab.entry ?? manifest.entry })),
    ...(manifest.background ? [{ what: 'the background page', entry: manifest.background.entry }] : []),
  ];
  for (const { what, entry } of pages) {
    if (!entry) throw new Error(`${what} has no HTML entry`);
    const there = request.update && fs.existsSync(path.resolve(sourceDir, entry));
    if (!written.has(inBundle(entry)) && !there) throw new Error(`${what} is ${entry}, which is not in files`);
  }

  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  for (const { target, content } of files) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return { sourceDir, manifest };
}
