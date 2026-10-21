import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { observer } from 'mobx-react-lite';
import type { TabBarItemProps, ResolvedTab } from '@renderer/features/tabs/core/tab-provider';
import {
  GenericTabDragPreview,
  GenericTabItem,
} from '@renderer/features/tabs/tab-bar/generic-tab-item';
import { FileIcon } from '@renderer/lib/editor/file-icon';
import { useDelayedBoolean } from '@renderer/lib/hooks/use-delay-boolean';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';
import { fileBaseName } from '../stores/workspace-path';
import { isFileTabLoading } from './file-tab-loading';
import { fileTabLabels } from './file-tab-label';
import type { FileTabResource } from './stores/file-tab-resource';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

// diskStatus 是稳定枚举，只在这里映射成本地化外壳；字节数是测量值，只作为插值带入。
function fileTabErrorTooltip(
  diskStatus: string,
  diskUri: string,
  translate: ReturnType<typeof useSessionMessages>['translate']
): string | undefined {
  if (diskStatus === 'error') return translate('task.fileNotFound');
  if (diskStatus === 'binary') return translate('task.unsupportedFileFormat');
  if (diskStatus === 'too-large') {
    const bytes = modelRegistry.modelTotalSizes.get(diskUri);
    if (bytes == null) return translate('task.fileTooLarge');
    const size =
      bytes < 1024
        ? `${bytes} B`
        : bytes < 1024 * 1024
          ? `${(bytes / 1024).toFixed(1)} KB`
          : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return translate('task.fileTooLargeWithSize', { size });
  }
  return undefined;
}

export const FileTabBarItem = observer(function FileTabBarItem({
  tab,
  host,
  ctx,
}: TabBarItemProps<FileTabResource>) {
  const { translate } = useSessionMessages();
  const resource = tab.resource;
  const fileName = fileBaseName(resource.path);
  const isMonacoFile =
    resource.path.endsWith('.md') ||
    resource.path.endsWith('.svg') ||
    !resource.path.includes('.') ||
    /\.(ts|tsx|js|jsx|json|css|html|py|go|rs|sh|yml|yaml|toml|txt)$/.test(resource.path);

  const bufferUri = resource.bufferUri;
  // 名字在这个面板的文件页签里一起定:重名的才补一截路径(file-tab-label.ts)。
  const fileTabs = host.resolvedTabs.filter((t): t is ResolvedTab<FileTabResource> => t.kind === 'file');
  const { name, hint } =
    fileTabLabels(fileTabs.map((t) => t.resource))[fileTabs.findIndex((t) => t.tabId === tab.tabId)] ?? { name: fileName };
  // 照 VS Code:盘上已被删掉的文件,页签标「已删除」(正文还在,存一下就重新建出来)。
  const label = bufferUri && modelRegistry.deletedOnDisk.has(bufferUri) ? translate('file.deletedTab', { name }) : name;
  const diskUri = bufferUri ? modelRegistry.toDiskUri(bufferUri) : '';
  const diskStatus = diskUri ? modelRegistry.modelStatus.get(diskUri) : undefined;
  const hasFileIssue =
    diskStatus === 'error' || diskStatus === 'too-large' || diskStatus === 'binary';
  const showSpinner = useDelayedBoolean(
    isFileTabLoading({
      isExternal: resource.isExternal,
      isExternalLoading: resource.isLoading,
      isMonacoFile,
      diskStatus,
    }),
    200
  );

  const errorTooltip = hasFileIssue ? fileTabErrorTooltip(diskStatus, diskUri, translate) : undefined;
  const tooltip = errorTooltip ? `${resource.path} — ${errorTooltip}` : resource.path;

  return (
    <GenericTabItem
      tab={tab}
      host={host}
      ctx={ctx}
      label={label}
      hint={hint}
      tooltip={tooltip}
      preSlot={
        <span className="shrink-0 [&>svg]:h-3 [&>svg]:w-3">
          {showSpinner ? (
            <LoadingIndicator size="inline" />
          ) : (
            <FileIcon filename={fileName} />
          )}
        </span>
      }
      hasError={hasFileIssue}
      statusSlot={
        resource.isDirty ? (
          <div
            className="size-2 rounded-full bg-foreground"
            title={translate('task.unsavedChanges')}
          />
        ) : undefined
      }
    />
  );
});

export function FileTabBarItemDragPreview({ tab }: { tab: ResolvedTab<FileTabResource> }) {
  const fileName = fileBaseName(tab.resource.path);
  return (
    <GenericTabDragPreview
      preSlot={
        <span className="shrink-0 [&>svg]:h-3 [&>svg]:w-3">
          <FileIcon filename={fileName} />
        </span>
      }
      label={tab.resource.title || fileName}
    />
  );
}
