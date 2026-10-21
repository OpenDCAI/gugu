import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef } from 'react';
import { revealMarkdownAnchor } from '@/components/markdown/revealAnchor';
import { usePaneContext } from '@renderer/features/tabs/pane-context';
import type { FileTabResource } from '@renderer/features/sessions/editor/stores/file-tab-resource';
import {
  useSessionViewContext,
  useWorkspace,
  useWorkspaceId,
} from '@renderer/features/sessions/session-view-context';
import { useDelayedBoolean } from '@renderer/lib/hooks/use-delay-boolean';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { Spinner } from '@renderer/lib/ui/spinner';
import { resolveWorkspaceResourcePath } from './workspace-resource-path';
import { workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';

interface MarkdownEditorRendererProps {
  tab: FileTabResource;
}

/**
 * Renders a markdown file as a formatted preview.
 * The source/preview toggle lives in the FileContent container above this component.
 */
export const MarkdownEditorRenderer = observer(function MarkdownEditorRenderer({
  tab,
}: MarkdownEditorRendererProps) {
  const { projectId } = useSessionViewContext();
  const workspaceId = useWorkspaceId();
  const workspacePath = useWorkspace().path;
  const { pane } = usePaneContext();
  const showExternalSpinner = useDelayedBoolean(!!(tab.isExternal && tab.isLoading), 200);
  const uri = tab.bufferUri;

  // Reading bufferVersions creates a MobX tracking dependency so this observer
  // component re-renders whenever the model content changes or is first populated.
  const _version = uri ? modelRegistry.bufferVersions.get(uri) : undefined;
  const content = modelRegistry.getText(uri) ?? '';

  const resolveImage = useCallback(
    async (src: string): Promise<string | null> => {
      const imagePath = resolveWorkspaceResourcePath({
        workspacePath,
        containingFilePath: tab.path,
        resourcePath: src,
      });
      if (!imagePath) return null;
      const result = await workspaceRpc(projectId).files.readImage(projectId, workspaceId, imagePath);
      return result.success && result.data?.success ? result.data.dataUrl : null;
    },
    [projectId, workspaceId, workspacePath, tab.path]
  );

  const openWorkspaceLink = useCallback(
    (href: string): boolean => {
      const target = resolveWorkspaceResourcePath({
        workspacePath,
        containingFilePath: tab.path,
        resourcePath: href,
      });
      if (!target) return false;
      pane.open('file', { path: target }, { preview: false });
      // `./other.md#section` (#6950): the path opens the file, the fragment is where its preview lands.
      const fragment = href.includes('#') ? href.slice(href.indexOf('#') + 1) : '';
      if (fragment) {
        const opened = pane.resolvedTabs.find(
          (t) => t.kind === 'file' && (t.resource as FileTabResource).path === target
        );
        (opened?.resource as FileTabResource | undefined)?.requestReveal(fragment);
      }
      return true;
    },
    [workspacePath, tab.path, pane]
  );

  // A link that opened this file asked for an anchor: land on it once the text is in the DOM, then forget it.
  const containerRef = useRef<HTMLDivElement>(null);
  const reveal = tab.revealRequest;
  useEffect(() => {
    if (!reveal || !content) return;
    const frame = requestAnimationFrame(() => {
      revealMarkdownAnchor(containerRef.current, reveal.fragment);
      tab.clearRevealRequest();
    });
    return () => cancelAnimationFrame(frame);
  }, [reveal, content, tab]);

  return (
    <div ref={containerRef} className="relative h-full overflow-y-auto bg-background-secondary-1">
      {tab.isExternal && tab.isLoading ? (
        showExternalSpinner ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : null
      ) : tab.isExternal && tab.externalError ? (
        <div className="text-foreground-destructive px-8 py-8 text-sm">
          Could not load file: {tab.externalError}
        </div>
      ) : (
        <MarkdownRenderer
          content={content}
          density="comfortable"
          frontmatter
          className="mx-auto w-full max-w-3xl px-6 py-6"
          resolveImage={resolveImage}
          onOpenLink={openWorkspaceLink}
        />
      )}
    </div>
  );
});
