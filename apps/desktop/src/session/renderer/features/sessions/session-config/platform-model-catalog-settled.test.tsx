// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
const invoke = vi.fn();
vi.mock('@renderer/lib/ipc', () => ({ invokeOnMachine: (...args: unknown[]) => invoke(...args) }));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => null } }));
vi.mock('@renderer/features/library/library-host', () => ({ useLibraryHost: () => ({ remote: null }) }));
import { usePlatformModelCatalog, type PlatformModelCatalogState } from './platform-model-catalog';
import { unavailablePlatformModelId } from './platform-model-selection';
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let current: PlatformModelCatalogState;
function Probe() { current = usePlatformModelCatalog('codex', 'acp', 'session'); return null; }
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.useRealTimers(); });

describe('retirement waits for the authoritative catalog response', () => {
  it.each([true, false])('does not turn the interim auth empty list into retirement (success=%s)', async (success) => {
    vi.useFakeTimers();
    invoke.mockReset().mockResolvedValueOnce({ models: [], sessionSelection: { modelId: 'retired-model' } });
    let finish!: (value: unknown) => void;
    let fail!: (error: Error) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<Probe />); });
    expect(current.settled).toBe(false);
    expect(unavailablePlatformModelId(current)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    await act(async () => {
      if (success) finish({ models: [], sessionSelection: { modelId: 'retired-model' } });
      else fail(new Error('catalog offline'));
    });
    expect(current.settled).toBe(success);
    expect(unavailablePlatformModelId(current)).toBe(success ? 'retired-model' : null);
  });
});
