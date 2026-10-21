import type * as monaco from 'monaco-editor';
// @@@sessionpage monaco-local — Monaco is vendored into the build instead of the upstream
// @monaco-editor/loader CDN path (cdn.jsdelivr.net; 6s+ cold load, unreachable on CN networks).
// Worker stubs below are tiny wrappers; the editor itself stays code-split behind the dynamic
// import in init(), so app boot remains monaco-free until an editor actually needs it.
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { configureMonacoTypeScript } from './monaco-config';
import { modelRegistry } from './monaco-model-registry';
import { defineMonacoThemes, getMonacoTheme } from './monaco-themes';

let instance: typeof monaco | null = null;
let initPromise: Promise<typeof monaco> | null = null;
let cancellationBoundaryInstalled = false;

function installMonacoCancellationBoundary(): void {
  if (cancellationBoundaryInstalled) return;
  cancellationBoundaryInstalled = true;
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    if (
      reason instanceof Error &&
      reason.name === 'Canceled' &&
      reason.message === 'Canceled' &&
      (reason.stack?.includes('/monaco-editor/') || reason.stack?.includes('/assets/editor.main-'))
    ) {
      event.preventDefault();
    }
  });
}

function installMonacoEnvironment(): void {
  (globalThis as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case 'json':
          return new jsonWorker();
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker();
        case 'typescript':
        case 'javascript':
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };
}

/**
 * Shared Monaco bootstrap — the single entry point for loading Monaco,
 * defining themes, and configuring TypeScript support.
 *
 * Both EditorProvider (code editor) and StickyDiffEditor (diff editor) use this
 * instead of maintaining separate pools. Bootstrap is idempotent: subsequent
 * calls to init() return the same promise. The resolved instance is exposed via
 * globalThis.__monaco so module-level Monaco integrations can access it without
 * importing the bootstrap directly.
 */
export const monacoBootstrap = {
  /** Load Monaco once, set up themes and TypeScript. Safe to call multiple times. */
  init(): Promise<typeof monaco> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      installMonacoEnvironment();
      // Monaco uses Canceled/Canceled rejections to stop in-flight editor work during normal
      // model disposal. Keep that lifecycle signal inside the Monaco boundary.
      installMonacoCancellationBoundary();
      const m = await import('monaco-editor');
      instance = m;
      // oxlint-disable-next-line typescript/no-explicit-any
      (globalThis as any).__monaco = m;
      modelRegistry.notifyMonacoReady(m);
      defineMonacoThemes(m);
      configureMonacoTypeScript(m);
      return m;
    })();
    return initPromise;
  },

  /** Returns the loaded Monaco namespace, or null if init() has not yet resolved. */
  getMonaco(): typeof monaco | null {
    return instance;
  },

  /** Switch the active Monaco theme across all editor instances. Both themes are defined once in init():
   *  their colors come from the static emlight / emdark classes, so redefining them per editor mount bought nothing. */
  setTheme(effectiveTheme: string): void {
    instance?.editor.setTheme(getMonacoTheme(effectiveTheme));
  },
};
