import { observer } from 'mobx-react-lite';
import { useMemo } from 'react';
import type { FileTabResource } from '@renderer/features/sessions/editor/stores/file-tab-resource';
import { ContainedImage } from '@renderer/lib/ui/contained-image';
import { ModelStatusOverlay } from '@renderer/lib/monaco/model-status-overlay';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';
import { useModelStatus } from '@renderer/lib/monaco/use-model';

interface SvgRendererProps {
  tab: FileTabResource;
}

/**
 * Renders an SVG file as an image preview.
 * The source/preview toggle lives in the FileContent container above this component.
 */
export const SvgRenderer = observer(function SvgRenderer({ tab }: SvgRendererProps) {
  const filePath = tab.path;
  const uri = tab.bufferUri;
  const status = useModelStatus(uri);

  // Touch bufferVersions so this observer re-renders when the model is first
  // populated — otherwise the preview can stick on an empty src.
  void modelRegistry.bufferVersions.get(uri);
  const content = status === 'ready' ? (modelRegistry.getText(uri) ?? '') : '';
  const svgUrl = useMemo(
    () => (content ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}` : ''),
    [content]
  );
  const fileName = filePath.split('/').pop() ?? filePath;

  return (
    <div className="relative flex h-full items-center justify-center overflow-auto p-4">
      {tab.externalError ? (
        <div className="px-8 text-sm text-foreground-destructive">{tab.externalError}</div>
      ) : status !== 'ready' ? (
        <ModelStatusOverlay status={status} />
      ) : svgUrl ? (
        <ContainedImage src={svgUrl} alt={fileName} className="max-h-full max-w-full" />
      ) : (
        <div className="text-xs text-foreground-passive">Empty file</div>
      )}
    </div>
  );
});
