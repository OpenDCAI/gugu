// @vitest-environment jsdom
// #7199 打开一条在睡着的云电脑上的会话:先说「正在唤醒」等它醒,❌ 先去准备文件、连不上就报失败;
// 醒了(连上了)之前那一下失败了就自己重来一次(验收实测:不重来就一直停在「准备文件失败」)。
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  connection: 'asleep' as string,
  provisionSession: vi.fn(async () => {}),
  mountProject: vi.fn(async () => {}),
}));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: {
    connectionState: () => env.connection,
    device: () => ({ label: '云电脑' }),
    wakeFailure: () => ({ reason: 'timeout', code: null, message: 'x' }),
  },
}));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => 'cloud' } }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({ getProjectManagerStore: () => ({ mountProject: env.mountProject }) }));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({ getSessionManagerStore: () => ({ provisionSession: env.provisionSession }) }));

const { useCloudComputerGate } = await import('./use-cloud-computer-gate');

type Gate = ReturnType<typeof useCloudComputerGate>;
let seen: Gate = null;
function Probe({ kind }: { kind: string }) {
  seen = useCloudComputerGate('p1', 's1', kind as never);
  return null;
}

let root: Root;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  env.connection = 'asleep';
  env.provisionSession.mockClear();
  env.mountProject.mockClear();
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
});

describe('useCloudComputerGate', () => {
  it('没醒着:交出那台(页面说「正在唤醒」);叫醒没成带上原因', () => {
    act(() => root.render(createElement(Probe, { kind: 'provisioning' })));
    expect(seen).toMatchObject({ deviceId: 'cloud', label: '云电脑', failure: null });
    env.connection = 'wake-failed';
    act(() => root.render(createElement(Probe, { kind: 'provision-error' })));
    expect(seen?.failure).toMatchObject({ reason: 'timeout' });
  });

  it('醒了而准备文件那一下失败过:自己重来一次,只一次', () => {
    act(() => root.render(createElement(Probe, { kind: 'provision-error' })));
    env.connection = 'waking';
    act(() => root.render(createElement(Probe, { kind: 'provision-error' })));
    env.connection = 'connected';
    act(() => root.render(createElement(Probe, { kind: 'provision-error' })));
    expect(seen).toBeNull();
    expect(env.provisionSession).toHaveBeenCalledTimes(1);
    act(() => root.render(createElement(Probe, { kind: 'provision-error' })));
    expect(env.provisionSession).toHaveBeenCalledTimes(1);
  });

  it('连上那一刻还在准备、随后才失败:照样重来;项目没挂上则重挂项目', () => {
    act(() => root.render(createElement(Probe, { kind: 'project-mounting' })));
    env.connection = 'connected';
    act(() => root.render(createElement(Probe, { kind: 'project-mounting' })));
    act(() => root.render(createElement(Probe, { kind: 'project-error' })));
    expect(env.mountProject).toHaveBeenCalledTimes(1);
    expect(env.provisionSession).not.toHaveBeenCalled();
  });

  it('一直连着的机器上失败 ❌ 自己重来(那是别的原因,照原样给重试)', () => {
    env.connection = 'connected';
    act(() => root.render(createElement(Probe, { kind: 'provisioning' })));
    act(() => root.render(createElement(Probe, { kind: 'provision-error' })));
    expect(env.provisionSession).not.toHaveBeenCalled();
  });
});
