/**
 * The one mermaid renderer every surface draws with: transcript blocks and their viewer, documents, and the App
 * runtime's `gugu.markdown()`. Official mermaid, loaded on first use, `securityLevel: 'strict'`, one diagram at a time.
 */
import type { MermaidConfig } from 'mermaid';

let idCounter = 0;
let renderQueue: Promise<void> = Promise.resolve();
let lastInitializedConfigKey: string | null = null;

export type MermaidTheme = NonNullable<MermaidConfig['theme']>;

interface MermaidRenderRequest {
  id: string;
  chart: string;
  theme: MermaidTheme;
  /** Aborted once the caller no longer wants this diagram; a queued request is then skipped, never rendered. */
  signal?: AbortSignal;
}

export function createMermaidRenderId(): string {
  idCounter += 1;
  return `emdash-mermaid-${idCounter}`;
}

export async function renderMermaidDiagram({
  id,
  chart,
  theme,
  signal,
}: MermaidRenderRequest): Promise<string> {
  const render = async () => {
    // One queue serves every surface, so a render nobody waits for any more (a streaming block's earlier source, a
    // re-clicked viewer) would hold up every diagram behind it.
    signal?.throwIfAborted();
    const mermaid = (await import('mermaid')).default;
    const config: MermaidConfig = {
      startOnLoad: false,
      htmlLabels: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme,
      flowchart: {
        htmlLabels: false,
      },
    };
    const configKey = JSON.stringify(config);

    if (lastInitializedConfigKey !== configKey) {
      mermaid.initialize(config);
      lastInitializedConfigKey = configKey;
    }

    const { svg } = await mermaid.render(id, chart);
    return svg;
  };

  const result = renderQueue.then(render, render);
  renderQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** The theme matching the host's light/dark truth, `<html data-theme>` (written only by host-theme.ts). */
export function readMermaidTheme(): MermaidTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'neutral';
}

export function subscribeMermaidTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
