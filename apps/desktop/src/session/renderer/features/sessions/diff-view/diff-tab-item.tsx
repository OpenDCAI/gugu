import { observer } from 'mobx-react-lite';
import type { TabBarItemProps, ResolvedTab } from '@renderer/features/tabs/core/tab-provider';
import {
  GenericTabDragPreview,
  GenericTabItem,
} from '@renderer/features/tabs/tab-bar/generic-tab-item';
import { fileTabLabels } from '@renderer/features/sessions/editor/file-tab-label';
import { fileBaseName } from '@renderer/features/sessions/stores/workspace-path';
import { FileIcon } from '@renderer/lib/editor/file-icon';
import { GitChangeStatusIcon } from './changes-panel/components/changes-list-item';
import type { DiffTabResource } from './stores/diff-tab-resource';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

// diffGroup 是稳定枚举，只在展示边界映射成本地化后缀。
export function diffGroupSuffixKey(diffGroup: DiffTabResource['diffGroup']) {
  switch (diffGroup) {
    case 'disk':
      return 'diff.groupWorkingTree' as const;
    case 'staged':
      return 'diff.groupIndex' as const;
    case 'pr':
      return 'diff.groupPr' as const;
    case 'git':
      return 'diff.groupGit' as const;
  }
}

export const DiffTabBarItem = observer(function DiffTabBarItem({
  tab,
  host,
  ctx,
}: TabBarItemProps<DiffTabResource>) {
  const { translate } = useSessionMessages();
  const resource = tab.resource;
  const fileName = fileBaseName(resource.path);
  const suffix = translate(diffGroupSuffixKey(resource.diffGroup));
  // 同名的 diff 页签与文件页签同一条规矩:补上能区分它们的那截路径(file-tab-label.ts),后面再跟分组。
  const diffTabs = host.resolvedTabs.filter((t): t is ResolvedTab<DiffTabResource> => t.kind === tab.kind);
  const pathHint = fileTabLabels(diffTabs.map((t) => ({ path: t.resource.path, title: null })))[
    diffTabs.findIndex((t) => t.tabId === tab.tabId)
  ]?.hint;

  return (
    <GenericTabItem
      tab={tab}
      host={host}
      ctx={ctx}
      label={fileName}
      // 分组文案自带括号(「(Working Tree)」/「（工作树）」),区分路径直接排在它前面。
      hint={pathHint ? `${pathHint} ${suffix}` : suffix}
      tooltip={translate('diff.tabTooltip', { path: resource.path, suffix })}
      preSlot={
        <span className="shrink-0 [&>svg]:h-3 [&>svg]:w-3">
          <FileIcon filename={fileName} />
        </span>
      }
      statusSlot={
        resource.status ? <GitChangeStatusIcon status={resource.status} className="size-4" /> : undefined
      }
    />
  );
});

export function DiffTabBarItemDragPreview({ tab }: { tab: ResolvedTab<DiffTabResource> }) {
  const { translate } = useSessionMessages();
  const resource = tab.resource;
  const fileName = fileBaseName(resource.path);
  const suffix = translate(diffGroupSuffixKey(resource.diffGroup));
  return (
    <GenericTabDragPreview
      preSlot={
        <span className="shrink-0 [&>svg]:h-3 [&>svg]:w-3">
          <FileIcon filename={fileName} />
        </span>
      }
      label={translate('diff.tabDragLabel', { fileName, suffix })}
    />
  );
}
