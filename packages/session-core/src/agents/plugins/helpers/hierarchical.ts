import type { PluginFs } from '../../runtime/fs';

export type ConfigLayer<T> = {
  root: string;
  content: string | null;
  parsed: T | null;
};

/**
 * Read the same relative config path from each root in order.
 * Roots should be ordered from most-specific (workspace) to least-specific (global).
 * Returns one entry per root; `content` is null when the file does not exist.
 */
export async function readHierarchical(
  fs: PluginFs,
  relativePath: string,
  roots: string[]
): Promise<Array<{ root: string; content: string | null }>> {
  return Promise.all(
    roots.map(async (root) => ({
      root,
      content: await fs.read(`${root}/${relativePath}`),
    }))
  );
}

