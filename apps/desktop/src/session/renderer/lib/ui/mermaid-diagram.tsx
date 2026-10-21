import React, { useEffect, useMemo, useState } from 'react';
import { cn } from '@renderer/utils/utils';
import { MermaidDiagramDialog } from './mermaid-diagram-dialog';
import { MermaidDiagramPreview } from './mermaid-diagram-preview';
import { createMermaidRenderId, renderMermaidDiagram } from '@gugu/session-chat-ui/mermaid';

interface MermaidDiagramProps {
  chart: string;
  isDark: boolean;
  compact?: boolean;
}

type RenderState =
  | { kind: 'rendered'; key: string; svg: string }
  | { kind: 'error'; key: string; message: string | null };

const GENERIC_RENDER_ERROR = 'Unable to render Mermaid diagram.';

function errorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message && error.message !== GENERIC_RENDER_ERROR) {
    return error.message;
  }
  if (typeof error === 'string' && error && error !== GENERIC_RENDER_ERROR) {
    return error;
  }
  return null;
}

export const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ chart, isDark, compact }) => {
  const id = useMemo(() => createMermaidRenderId(), []);
  const theme = isDark ? 'dark' : 'neutral';
  const renderKey = `${theme}:${chart}`;
  const [state, setState] = useState<RenderState | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    renderMermaidDiagram({ id, chart, theme })
      .then((svg) => {
        if (!cancelled) setState({ kind: 'rendered', key: renderKey, svg });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: 'error', key: renderKey, message: errorMessage(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [chart, id, renderKey, theme]);

  const visibleState = state?.key === renderKey ? state : null;

  if (visibleState?.kind === 'error') {
    return (
      <div
        className={cn(
          'my-3 rounded-md border border-border-destructive/30 bg-background-destructive p-3 text-xs text-foreground-destructive',
          compact && 'my-2 p-2 text-tiny'
        )}
        role="alert"
      >
        <div className="font-medium">{GENERIC_RENDER_ERROR}</div>
        {visibleState.message && (
          <div className="text-foreground-muted mt-1">{visibleState.message}</div>
        )}
        <pre className="bg-background-2/60 text-foreground-muted mt-2 overflow-x-auto rounded-sm p-2">
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  if (!visibleState) {
    return (
      <div
        className={cn(
          'my-3 rounded-md border border-border bg-background-2/20 p-3 text-xs text-foreground-muted',
          compact && 'my-2 p-2 text-tiny'
        )}
      >
        Rendering diagram...
      </div>
    );
  }

  return (
    <>
      <MermaidDiagramPreview
        svg={visibleState.svg}
        compact={compact}
        onExpand={() => setIsExpanded(true)}
      />
      <MermaidDiagramDialog
        open={isExpanded}
        svg={visibleState.svg}
        renderKey={visibleState.key}
        onOpenChange={setIsExpanded}
      />
    </>
  );
};
