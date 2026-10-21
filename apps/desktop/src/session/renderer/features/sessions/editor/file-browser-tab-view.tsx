import type { TabContentProps } from '@renderer/features/tabs/core/tab-provider';
import { pickSessionOpener } from '@renderer/features/extensions/open-with';
import { EditorFileTree } from './editor-file-tree';
import type { FileBrowserResource } from './file-browser-tab-provider';

export function TabContent({ host }: TabContentProps) {
  const activeTab = host.resolvedTabs.find((tab) => tab.isActive && tab.kind === 'file-browser');
  const resource = activeTab?.resource as FileBrowserResource | undefined;

  if (!resource) return null;

  const openFile = (path: string, preview: boolean) => {
    void resource.handle.close({ force: true });
    // The file browser is its OWN open path — it does not go through
    // open-file-in-file-editor.ts. Wiring the claim only there left clicking a
    // claimed file landing in the built-in editor, with every unit test green
    // (measured on the real app, #2374). A claim has to be honoured at every
    // door a file can be opened from, or it is honoured at none the user uses.
    // One resolver for every door (open-with.ts): one claim opens, several ask 「用哪个打开」.
    void pickSessionOpener(path).then((opener) => {
      if ('cancelled' in opener) return;
      if ('tabKind' in opener) resource.handle.open(opener.tabKind, { filePath: path }, { preview });
      else resource.handle.open('file', { path }, { preview });
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="file-browser-tab">
      {/* 顶栏写着这条会话的根目录,右边新建文件 / 新建文件夹 / 刷新 / 全部收起(照 VS Code 资源管理器的视图标题栏)。 */}
      <EditorFileTree onOpenFile={openFile} showHeader />
    </div>
  );
}
