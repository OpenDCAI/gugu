import { runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { EDITOR_CONFIRM_FILE_BYTES } from '@renderer/lib/editor/file-size-limits';
import { isSelfLoadingKind } from '@renderer/lib/editor/fileKind';
import type { ManagedFileKind } from '@renderer/lib/editor/types';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import { applyExternalFileLoad, readExternalFileForTab } from './external-file-load';
import { FILE_CONTENT_TYPES } from './file-content-types';
import type { FileTabResource } from './stores/file-tab-resource';
import { workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';

interface FileContentPreviewProps {
  tab: FileTabResource;
  ctx: SessionTabContext;
}

/**
 * Renders the preview for a file tab by routing on tab.contentType via FILE_CONTENT_TYPES.
 *
 * Also owns the async external-file content load: when an external file is opened,
 * the store starts in an isLoading state and this effect triggers the actual read.
 * This effect lives here (and not in the store) so that open() and deserialize() remain
 * synchronous.
 *
 * Only mounted when the container (FileContent) determines showPreview is true, which
 * means this component's wrapper div never covers Monaco in source mode — fixing the
 * pointer-events bug from the old always-mounted overlay approach.
 */
export const FileContentPreview = observer(function FileContentPreview({
  tab,
  ctx,
}: FileContentPreviewProps) {
  useEffect(() => {
    // PDF 这类自己取字节的类型必须绕开这条:它走 `readText`,读到二进制就把 contentType
    // 盖成 binary,刚判出来的类型当场被抹掉(#5269)。
    if (!tab.isExternal || !tab.isLoading || isSelfLoadingKind(tab.contentType as ManagedFileKind))
      return;
    let cancelled = false;
    void (async () => {
      // 图片和文本各走各的读取(#6455):图片走 `readImage`,❌ 走按文本读的那条被判成 binary。
      const load = await readExternalFileForTab(tab.fileKind, tab.path, EDITOR_CONFIRM_FILE_BYTES, {
        readImage: (path) => workspaceRpc(ctx.projectId).files.readImage(ctx.projectId, ctx.workspaceId, path),
        readExternalFile: (path, maxBytes) =>
          workspaceRpc(ctx.projectId).files.readExternalFile(ctx.projectId, ctx.workspaceId, path, maxBytes),
      });
      if (cancelled) return;
      runInAction(() => applyExternalFileLoad(tab, load));
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx.projectId, ctx.workspaceId, tab, tab.isExternal, tab.isLoading, tab.path]);

  const def = FILE_CONTENT_TYPES[tab.contentType];
  if (!def.Preview) return null;
  const { Preview } = def;
  return <Preview tab={tab} ctx={ctx} />;
});
