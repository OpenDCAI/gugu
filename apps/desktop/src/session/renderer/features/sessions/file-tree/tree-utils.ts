export interface NestedFileNode {
  path: string;
  name: string;
  parentPath: string | null;
  depth: number;
  type: 'file' | 'directory';
  children: NestedFileNode[];
  isHidden: boolean;
  extension?: string;
}

export function normalizeFileTreePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (normalized === '/') return normalized;
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function parentPathForNormalizedPath(path: string): string | null {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return null;
  const parentPath = parts.slice(0, -1).join('/');
  return path.startsWith('/') ? `/${parentPath}` : parentPath;
}

export function makeNode(filePath: string, type: 'file' | 'directory'): NestedFileNode {
  const path = normalizeFileTreePath(filePath);
  const parts = path.split('/').filter(Boolean);
  const name = parts[parts.length - 1] ?? path;
  const parentPath = parentPathForNormalizedPath(path);
  const depth = parts.length - 1;
  const extension = type === 'file' && name.includes('.') ? name.split('.').pop() : undefined;

  return {
    path,
    name,
    parentPath,
    depth,
    type,
    children: [],
    isHidden: name.startsWith('.'),
    extension,
  };
}

export function sortFileNodes(nodes: readonly NestedFileNode[]): NestedFileNode[] {
  return [...nodes].sort((a, b) => {
    const rankDiff = (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1);
    if (rankDiff !== 0) return rankDiff;
    return a.name.localeCompare(b.name);
  });
}

export interface TreeRow<T extends NestedFileNode = NestedFileNode> {
  node: T;
  chain: T[];
  renderDepth: number;
}

function extendNestedDirectoryChain(node: NestedFileNode): NestedFileNode[] {
  const chain: NestedFileNode[] = [node];
  const visited = new Set<string>([node.path]);
  let current = node;
  while (current.type === 'directory') {
    const children = current.children;
    if (
      children.length !== 1 ||
      children[0].type !== 'directory' ||
      visited.has(children[0].path)
    ) {
      break;
    }
    current = children[0];
    visited.add(current.path);
    chain.push(current);
  }
  return chain;
}

export function isChainExpanded(chain: readonly NestedFileNode[], expandedPaths: Set<string>): boolean {
  for (const segment of chain) {
    if (expandedPaths.has(segment.path)) return true;
  }
  return false;
}

export function buildNestedVisibleRows(
  rootNodes: readonly NestedFileNode[],
  expandedPaths: Set<string>
): Array<TreeRow<NestedFileNode>> {
  const rows: Array<TreeRow<NestedFileNode>> = [];

  function walk(nodes: readonly NestedFileNode[], renderDepth: number) {
    for (const node of nodes) {
      const chain = node.type === 'directory' ? extendNestedDirectoryChain(node) : [node];
      const terminus = chain[chain.length - 1];
      rows.push({ node: terminus, chain, renderDepth });
      if (terminus.type === 'directory' && isChainExpanded(chain, expandedPaths)) {
        walk(terminus.children, renderDepth + 1);
      }
    }
  }

  walk(rootNodes, 0);
  return rows;
}
