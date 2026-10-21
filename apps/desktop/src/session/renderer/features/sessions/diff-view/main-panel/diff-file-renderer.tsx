import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { usePaneContext } from '@renderer/features/tabs/pane-context';
import { ImageDiffView } from '@renderer/features/sessions/diff-view/main-panel/image-diff-view';
import { isMissingFileError } from '@renderer/features/sessions/diff-view/main-panel/missing-file-error';
import type { DiffTabResource } from '@renderer/features/sessions/diff-view/stores/diff-tab-resource';
import {
  useSessionViewContext,
  useWorkspace,
  useWorkspaceId,
  useWorkspaceSurface,
} from '@renderer/features/sessions/session-view-context';
import { HtmlContentRenderer } from '@renderer/lib/editor/html-renderer';
import { resolveWorkspaceResourcePath } from '@renderer/lib/editor/workspace-resource-path';
import { ModelStatusOverlay } from '@renderer/lib/monaco/model-status-overlay';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';
import { buildMonacoModelPath } from '@renderer/lib/monaco/monacoModelPath';
import { StickyDiffEditor } from '@renderer/lib/monaco/sticky-diff-editor';
import { useModelStatus } from '@renderer/lib/monaco/use-model';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { getLanguageFromPath } from '@renderer/utils/languageUtils';
import { HEAD_REF, STAGED_REF } from '@shared/core/git/types';
import type { ActiveFile } from '@shared/view-state';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';

interface DiffFileRendererProps {
  tab: DiffTabResource;
}

/**
 * Routes a diff tab to the correct renderer based on its renderer kind.
 * Mirrors the FileRenderer pattern for file tabs.
 */
export const DiffFileRenderer = observer(function DiffFileRenderer({ tab }: DiffFileRendererProps) {
  const { translate } = useSessionMessages();
  const { projectId } = useSessionViewContext();
  const workspaceId = useWorkspaceId();

  switch (tab.renderer.kind) {
    case 'text':
      return <TextDiffRenderer tab={tab} />;
    case 'image': {
      const activeFile = tabToActiveFile(tab);
      return (
        <ImageDiffView
          key={`${workspaceId}:${tab.diffGroup}:${tab.path}`}
          projectId={projectId}
          workspaceId={workspaceId}
          activeFile={activeFile}
        />
      );
    }
    case 'binary':
      return (
        <div className="text-foreground-muted flex h-full items-center justify-center text-sm">
          {translate('diff.binaryNoDiff')}
        </div>
      );
  }
});

/** Owns text diff model registration and preview rendering. */
const TextDiffRenderer = observer(function TextDiffRenderer({ tab }: DiffFileRendererProps) {
  const { projectId } = useSessionViewContext();
  const workspaceId = useWorkspaceId();
  const diffView = useWorkspaceSurface().diffView;

  const root = `workspace:${workspaceId}`;
  const uri = buildMonacoModelPath(root, tab.path);
  const language = getLanguageFromPath(tab.path);

  const originalUri = (() => {
    if (tab.diffGroup === 'disk') {
      return modelRegistry.toGitUri(uri, STAGED_REF);
    }
    if (tab.diffGroup === 'git' || tab.diffGroup === 'pr') {
      return modelRegistry.toGitUri(uri, tab.originalRef);
    }
    return modelRegistry.toGitUri(uri, HEAD_REF);
  })();

  const modifiedUri = (() => {
    if (tab.diffGroup === 'staged') return modelRegistry.toGitUri(uri, STAGED_REF);
    if (tab.diffGroup === 'pr') {
      return modelRegistry.toGitUri(uri, tab.modifiedRef ?? HEAD_REF);
    }
    if (tab.diffGroup === 'git') {
      return modelRegistry.toGitUri(uri, tab.modifiedRef ?? HEAD_REF);
    }
    return uri;
  })();

  const previewContentUri = modifiedUri;

  useEffect(() => {
    let disposed = false;

    if (tab.diffGroup === 'disk') {
      const diskUri = modelRegistry.toDiskUri(uri);
      void (async () => {
        if (tab.status !== 'deleted') {
          try {
            await modelRegistry.registerModel(
              projectId,
              workspaceId,
              root,
              tab.path,
              language,
              'disk'
            );
          } catch (err) {
            if (!isMissingFileError(err)) throw err;
          }
        }
        if (disposed) {
          modelRegistry.unregisterModel(diskUri);
          return;
        }
        await modelRegistry.registerModel(
          projectId,
          workspaceId,
          root,
          tab.path,
          language,
          'buffer'
        );
        if (disposed) {
          modelRegistry.unregisterModel(modifiedUri);
        }
      })().catch(() => {});
      void modelRegistry
        .registerModel(projectId, workspaceId, root, tab.path, language, 'git', STAGED_REF)
        .catch(() => {});
    } else if (tab.diffGroup === 'staged') {
      void modelRegistry
        .registerModel(projectId, workspaceId, root, tab.path, language, 'git', HEAD_REF)
        .catch(() => {});
      void modelRegistry
        .registerModel(projectId, workspaceId, root, tab.path, language, 'git', STAGED_REF)
        .catch(() => {});
    } else {
      void modelRegistry
        .registerModel(projectId, workspaceId, root, tab.path, language, 'git', tab.originalRef)
        .catch(() => {});
      const effectiveModifiedRef = tab.modifiedRef ?? HEAD_REF;
      void modelRegistry
        .registerModel(
          projectId,
          workspaceId,
          root,
          tab.path,
          language,
          'git',
          effectiveModifiedRef
        )
        .catch(() => {});
    }

    return () => {
      disposed = true;
      modelRegistry.unregisterModel(originalUri);
      modelRegistry.unregisterModel(modifiedUri);
      if (tab.diffGroup === 'disk') {
        modelRegistry.unregisterModel(modelRegistry.toDiskUri(uri));
      }
    };
  }, [
    originalUri,
    modifiedUri,
    language,
    tab.path,
    tab.diffGroup,
    tab.originalRef,
    tab.modifiedRef,
    tab.status,
    projectId,
    workspaceId,
    root,
    uri,
  ]);

  if (!diffView) return null;

  if (tab.viewMode === 'preview' && tab.renderer.kind === 'text' && tab.renderer.previewKind) {
    return (
      <DiffContentPreview
        tab={tab}
        contentUri={previewContentUri}
        previewKind={tab.renderer.previewKind}
      />
    );
  }

  return (
    <div className="file-diff-view flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        <StickyDiffEditor
          originalUri={originalUri}
          modifiedUri={modifiedUri}
          diffStyle={diffView.diffStyle}
        />
      </div>
    </div>
  );
});

interface DiffContentPreviewProps {
  tab: DiffTabResource;
  contentUri: string;
  previewKind: 'markdown' | 'html';
}

const DiffContentPreview = observer(function DiffContentPreview({
  tab,
  contentUri,
  previewKind,
}: DiffContentPreviewProps) {
  const { translate } = useSessionMessages();
  const { projectId } = useSessionViewContext();
  const workspaceId = useWorkspaceId();
  const workspacePath = useWorkspace().path;
  const { pane } = usePaneContext();
  const status = useModelStatus(contentUri);
  void modelRegistry.bufferVersions.get(contentUri);

  if (tab.status === 'deleted') {
    return (
      <div className="text-foreground-muted flex h-full items-center justify-center text-sm">
        {translate('diff.deletedNoPreview')}
      </div>
    );
  }

  if (status !== 'ready') {
    return (
      <div className="relative h-full bg-background-secondary-1">
        <ModelStatusOverlay status={status} />
      </div>
    );
  }

  const content = modelRegistry.getModelByUri(contentUri)?.getValue() ?? '';

  if (previewKind === 'html') {
    return <HtmlContentRenderer filePath={tab.path} rawContent={content} />;
  }

  const resolveImage = async (src: string): Promise<string | null> => {
    const imagePath = resolveWorkspaceResourcePath({
      workspacePath,
      containingFilePath: tab.path,
      resourcePath: src,
    });
    if (!imagePath) return null;
    const result = await workspaceRpc(projectId).files.readImage(projectId, workspaceId, imagePath);
    return result.success && result.data?.success ? result.data.dataUrl : null;
  };

  const openWorkspaceLink = (href: string): boolean => {
    const target = resolveWorkspaceResourcePath({
      workspacePath,
      containingFilePath: tab.path,
      resourcePath: href,
    });
    if (!target) return false;
    pane.open('file', { path: target }, { preview: false });
    return true;
  };

  return (
    <div className="relative h-full overflow-y-auto bg-background-secondary-1">
      <MarkdownRenderer
        content={content}
        density="comfortable"
        frontmatter
        className="w-full max-w-3xl px-8 py-8"
        resolveImage={resolveImage}
        onOpenLink={openWorkspaceLink}
      />
    </div>
  );
});

function tabToActiveFile(tab: DiffTabResource): ActiveFile {
  return {
    path: tab.path,
    type: tab.diffGroup === 'disk' ? 'disk' : 'git',
    group: tab.diffGroup,
    originalRef: tab.originalRef,
    modifiedRef: tab.modifiedRef,
    prNumber: tab.prNumber,
    prBaseOid: tab.prBaseOid,
    prHeadOid: tab.prHeadOid,
    commitOriginalSha: tab.commitOriginalSha,
    commitModifiedSha: tab.commitModifiedSha,
  };
}
