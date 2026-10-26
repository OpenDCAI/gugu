import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { CliToolRecipe } from './cli-tools';
import { currentCliPlatform } from './cli-tools';

/** Public software in the managed image; account credentials never live here.
 * The image builder verifies release hashes before writing both final markers.
 * Existing account installations are selected before this system-owned cache. */
export function preinstalledCliDirectory(recipe: CliToolRecipe): string | undefined {
  if (process.env.GUGU_CLOUD_COMPUTER !== '1') return;
  const root = process.env.GUGU_CLI_PREINSTALL_ROOT || '/opt/gugu/integration-tools';
  if (!path.isAbsolute(root)) throw new Error('CLI preinstall root must be an absolute path');
  const dir = path.join(root, recipe.tool, recipe.version);
  try {
    if (readFileSync(path.join(dir, '.complete'), 'utf8').trim() !== recipe.version
      || readFileSync(path.join(dir, '.platform'), 'utf8').trim() !== currentCliPlatform()) return;
    const binary = statSync(path.join(dir, 'bin', recipe.bin));
    if (!binary.isFile() || !(binary.mode & 0o111) || !statSync(path.join(dir, 'skills')).isDirectory()) return;
    return dir;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw error;
  }
}
