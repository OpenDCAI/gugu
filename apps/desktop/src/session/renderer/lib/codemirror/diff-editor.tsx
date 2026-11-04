import { observer } from 'mobx-react-lite';
import { useLayoutEffect, useRef, useState } from 'react';
import { useTheme } from '@renderer/lib/hooks/useTheme';
import { ModelStatusOverlay } from '@renderer/lib/monaco/model-status-overlay';
import { modelRegistry } from '@renderer/lib/monaco/monaco-model-registry';
import { monacoBootstrap } from '@renderer/lib/monaco/monaco-bootstrap';
import { useModelStatus } from '@renderer/lib/monaco/use-model';
import { log } from '@renderer/utils/logger';
import { createDiffController } from './diff-controller';
import { loadLanguage } from './languages';

export const CodeMirrorDiffEditor = observer(function CodeMirrorDiffEditor({ originalUri, modifiedUri, diffStyle }: {
  originalUri: string;
  modifiedUri: string;
  diffStyle: 'split' | 'unified';
}) {
  const mount = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const { effectiveTheme } = useTheme();
  const originalStatus = useModelStatus(originalUri);
  const modifiedStatus = useModelStatus(modifiedUri);
  const status = failed ? 'error' : originalStatus !== 'ready' ? originalStatus : modifiedStatus !== 'ready' ? modifiedStatus : loaded ? 'ready' : 'loading';

  useLayoutEffect(() => {
    let disposed = false;
    let controller: ReturnType<typeof createDiffController> | undefined;
    setFailed(false);
    setLoaded(false);
    if (originalStatus !== 'ready' || modifiedStatus !== 'ready') return;
    const original = modelRegistry.getModelByUri(originalUri);
    const modified = modelRegistry.getModelByUri(modifiedUri);
    if (!original || !modified) throw new Error('Ready diff models are missing');
    void Promise.all([monacoBootstrap.init(), loadLanguage(modified.getLanguageId())]).then(([monaco, language]) => {
      if (disposed || !mount.current) return;
      controller = createDiffController({
        parent: mount.current, monaco, original, modified, style: diffStyle, language,
        dark: effectiveTheme !== 'emlight', saved: modelRegistry.restoreDiffViewState(originalUri, modifiedUri),
        save: () => { void modelRegistry.saveFileToDisk(modifiedUri); },
      });
      setLoaded(true);
    }).catch((error: unknown) => {
      if (disposed) return;
      log.error('Failed to load diff editor', error);
      setFailed(true);
    });
    return () => {
      disposed = true;
      if (controller) {
        modelRegistry.saveDiffViewState(originalUri, modifiedUri, controller.snapshot());
        controller.destroy();
      }
      mount.current?.replaceChildren();
    };
  }, [originalUri, modifiedUri, diffStyle, effectiveTheme, originalStatus, modifiedStatus]);

  return <div className="cm-diff relative h-full">
    <div ref={mount} className="h-full" />
    {status !== 'ready' ? <ModelStatusOverlay status={status} /> : null}
  </div>;
});
