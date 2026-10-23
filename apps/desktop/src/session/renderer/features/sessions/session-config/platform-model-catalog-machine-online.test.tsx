// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #137 owner 2026-10-23 实测:选着的机器离线时新建框里写「咕咕模型列表尚未就绪,请稍后重试」;机器回来之后它还停在那句,
// 要人点「重试」。目录是问那台机器要的:没连上就不问(原因由机器的提示说),连上了自己重取。
const invoke = vi.fn();
const host = { remote: { deviceId: 'mac-1', online: true } as { deviceId: string; online: boolean } };
vi.mock('@renderer/lib/ipc', () => ({ invokeOnMachine: (...args: unknown[]) => invoke(...args) }));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => null } }));
vi.mock('@renderer/features/library/library-host', () => ({ useLibraryHost: () => host }));

import { usePlatformModelCatalog } from './platform-model-catalog';

const MODELS = { models: [{ id: 'glm-5.3-flash', protocol: 'anthropic-messages' }] };

let state: ReturnType<typeof usePlatformModelCatalog> | null = null;
type Where = { online: boolean; device?: string; provider?: string };
function Probe({ online, device = 'mac-1', provider = 'claude' }: Where) {
  host.remote = { deviceId: device, online };
  state = usePlatformModelCatalog(provider, 'acp');
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
async function render(where: boolean | Where) {
  const props = typeof where === 'boolean' ? { online: where } : where;
  await act(async () => {
    root!.render(<Probe {...props} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(MODELS);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('usePlatformModelCatalog —— 跟着那台机器连没连上走', () => {
  it('机器没连上:不去问,也不落「尚未就绪」;连上那一刻自己取到', async () => {
    await render(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(state?.catalogError).toBeNull();
    await render(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(state?.models.map((m) => m.id)).toEqual(['glm-5.3-flash']);
  });

  it('连着时取到过,掉线又回来:自己重取,手上的清单不先清空', async () => {
    await render(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    await render(false);
    expect(state?.models.map((m) => m.id)).toEqual(['glm-5.3-flash']);
    invoke.mockReturnValueOnce(new Promise(() => {}));
    await render(true);
    expect(invoke).toHaveBeenCalledTimes(2);
    // 重取在路上时照旧列着上次的
    expect(state?.models.map((m) => m.id)).toEqual(['glm-5.3-flash']);
  });

  it('掉线时问到一半失败了:回来之后重取把「尚未就绪」换掉,❌ 等人点重试', async () => {
    invoke.mockReset().mockRejectedValue(new Error('no answer'));
    await render(true);
    // 第一次失败按设计隔一会儿再试一次;这里只看回来之后
    await render(false);
    invoke.mockReset().mockResolvedValue(MODELS);
    await render(true);
    expect(invoke).toHaveBeenCalled();
    expect(state?.catalogError).toBeNull();
    expect(state?.models.map((m) => m.id)).toEqual(['glm-5.3-flash']);
  });

  it('换到一台没连上的机器 / 离线时换了 agent:清掉上一份,❌ 把别处的模型留在下拉里', async () => {
    invoke.mockReset().mockImplementation(async (machine: string) => ({ models: [{ id: `${machine}-model`, protocol: 'anthropic-messages' }] }));
    await render({ online: true, device: 'mac-1' });
    expect(state?.models.map((m) => m.id)).toEqual(['mac-1-model']);
    await render({ online: false, device: 'mac-2' });
    expect(state?.models).toEqual([]);
    await render({ online: true, device: 'mac-1' });
    expect(state?.models.map((m) => m.id)).toEqual(['mac-1-model']);
    await render({ online: false, device: 'mac-1', provider: 'codex' });
    expect(state?.models).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('掉线这一下不动预选:这一份的默认模型照旧在', async () => {
    invoke.mockReset().mockResolvedValue({ ...MODELS, agentDefault: { modelId: 'glm-5.3-flash' } });
    await render(true);
    expect(state?.agentDefault).toEqual({ modelId: 'glm-5.3-flash' });
    await render(false);
    expect(state?.agentDefault).toEqual({ modelId: 'glm-5.3-flash' });
  });
});
