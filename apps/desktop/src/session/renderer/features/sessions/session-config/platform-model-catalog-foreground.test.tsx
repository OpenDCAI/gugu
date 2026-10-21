// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #7056 owner 2026-10-10 实测:在网页上开完会员回到窗口,下拉仍是三个免费模型 + 「升级解锁」。
// 开会员只写会员表、没有推送 ⇒ 模型目录要在**回到前台**时自己重取(与 useSpendingPower 同一条规矩)。
const invoke = vi.fn();
vi.mock('@renderer/lib/ipc', () => ({ invokeOnMachine: (...args: unknown[]) => invoke(...args) }));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => null } }));
vi.mock('@renderer/features/library/library-host', () => ({ useLibraryHost: () => ({ remote: null }) }));

import { usePlatformModelCatalog } from './platform-model-catalog';

const FREE = { models: [{ id: 'glm-5.3-flash', protocol: 'anthropic-messages' }] };
const MEMBER = {
  models: [
    { id: 'glm-5.3-flash', protocol: 'anthropic-messages' },
    { id: 'claude-opus-5', protocol: 'anthropic-messages' },
  ],
};

let shown: string[] = [];
function Probe() {
  shown = usePlatformModelCatalog('claude', 'acp', 'session-1').models.map((m) => m.id);
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let visibility: DocumentVisibilityState = 'visible';

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function foreground(kind: 'focus' | 'visibilitychange') {
  act(() => {
    if (kind === 'focus') window.dispatchEvent(new Event('focus'));
    else document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  invoke.mockReset().mockResolvedValueOnce(FREE).mockResolvedValue(MEMBER);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Probe />));
  await flush();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe('usePlatformModelCatalog —— 回到前台重取', () => {
  it('从网页开完会员回来,下拉换成会员的清单', async () => {
    expect(shown).toEqual(['glm-5.3-flash']);
    expect(invoke).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    foreground('focus');
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(shown).toEqual(['glm-5.3-flash', 'claude-opus-5']);
  });

  it('一次切窗只取一遍:focus 与 visibilitychange 紧挨着到时不重复', async () => {
    vi.advanceTimersByTime(60_000);
    foreground('focus');
    foreground('visibilitychange');
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('窗口在后台时不取', async () => {
    vi.advanceTimersByTime(60_000);
    visibility = 'hidden';
    foreground('visibilitychange');
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
