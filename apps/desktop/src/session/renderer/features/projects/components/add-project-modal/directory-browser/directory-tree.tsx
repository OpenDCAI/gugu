// 懒加载的目录树:根 = 调用方给的起点(网页版是宿主家目录),点一层展开一层,只列目录。
// 状态(展开/焦点/选中/键盘)交给 headless-tree,读目录走 rpc.files.browseDirectory。
// 读失败不吞:那一行右侧标「读取失败」并把原始错误放 title;读失败的节点当叶子。
import { asyncDataLoaderFeature, hotkeysCoreFeature, selectionFeature } from '@headless-tree/core';
import { useTree } from '@headless-tree/react';
import { useRef, useState } from 'react';
import { Folder, FolderOpen } from '@/lib/icons';
import { rpc } from '@renderer/lib/ipc';
import { Spinner } from '@renderer/lib/ui/spinner';
import { Tree, TreeItem, TreeItemLabel } from '@renderer/lib/ui/tree';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { directoryNodeName, subdirectoryPaths } from './directory-tree-model';
import { normalizePath } from './paths';

type DirectoryNode = { path: string };

interface DirectoryTreeProps {
  /** 树的根;换根请换 key 重挂,树的缓存跟着根走。 */
  rootPath: string;
  /** 当前选中的目录(受控)。 */
  value: string;
  onChange: (path: string) => void;
  className?: string;
}

export function DirectoryTree({ rootPath, value, onChange, className }: DirectoryTreeProps) {
  const { translate } = useSessionMessages();
  const root = normalizePath(rootPath);
  // 已知的子目录数:0 = 叶子(不再画箭头);没读过 = 先当文件夹,点了才知道。
  const childCountsRef = useRef(new Map<string, number>());
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const selected = value ? [normalizePath(value)] : [];

  const tree = useTree<DirectoryNode>({
    rootItemId: root,
    getItemName: (item) => directoryNodeName(item.getId(), root),
    isItemFolder: (item) => childCountsRef.current.get(item.getId()) !== 0,
    createLoadingItemData: () => ({ path: '' }),
    initialState: { expandedItems: [root] },
    state: { selectedItems: selected },
    setSelectedItems: (updater) => {
      const next = typeof updater === 'function' ? updater(selected) : updater;
      onChange(next[0] ?? '');
    },
    dataLoader: {
      getItem: async (path) => ({ path }),
      // ❌ 不能 reject:headless-tree 的 async loader 不 catch,reject 会让「读取中」永远转下去。
      getChildren: async (path) => {
        const result = await rpc.files
          .browseDirectory({ type: 'local', path })
          .catch((error: unknown) => ({
            success: false as const,
            error: { message: error instanceof Error ? error.message : String(error) },
          }));
        if (!result.success) {
          childCountsRef.current.set(path, 0);
          setLoadErrors((prev) => ({ ...prev, [path]: result.error.message }));
          return [];
        }
        const children = subdirectoryPaths(result.data);
        childCountsRef.current.set(path, children.length);
        setLoadErrors((prev) => {
          if (!(path in prev)) return prev;
          const { [path]: _, ...rest } = prev;
          return rest;
        });
        return children;
      },
    },
    features: [asyncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  });

  return (
    <Tree tree={tree} label={translate('projects.dirTree.label')} className={className}>
      {tree.getItems().map((item) => {
        const id = item.getId();
        const error = loadErrors[id];
        const FolderIcon = item.isExpanded() ? FolderOpen : Folder;
        return (
          <TreeItem key={id} item={item} aria-invalid={error ? true : undefined}>
            <TreeItemLabel
              icon={<FolderIcon className="size-4 text-foreground-muted" />}
              trailing={
                item.isLoading() ? (
                  <Spinner size="sm" className="text-foreground-muted" />
                ) : error ? (
                  <span className="text-xs text-foreground-destructive" title={error}>
                    {translate('projects.dirTree.loadFailed')}
                  </span>
                ) : null
              }
            >
              {item.getItemName()}
            </TreeItemLabel>
          </TreeItem>
        );
      })}
    </Tree>
  );
}
