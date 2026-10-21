// @vitest-environment jsdom
// #7199 什么时候叫醒云电脑:新建框里开始输入才叫(打开、选它做目标、挂上时带进来的草稿都不算);
// 打开 / 选中会话这类「要用它」的地方每次选中叫一次,开着时它又睡着了 ❌ 再叫。
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  state: 'asleep' as string,
  wakeCloudComputer: vi.fn(async () => true),
}));
vi.mock('./remote-hosts-store', () => ({
  remoteHostsStore: {
    connectionState: () => store.state,
    wakeCloudComputer: store.wakeCloudComputer,
  },
}));

const { useWakeCloudOnInput, useWakeCloudOnce } = await import('./use-wake-cloud-once');

let root: Root;
let host: HTMLDivElement;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function OnInput({ deviceId, input }: { deviceId: string | null; input: string }) {
  useWakeCloudOnInput(deviceId, input);
  return null;
}
function Once({ deviceId, target }: { deviceId: string | null; target: 'asleep' | 'other' | null }) {
  useWakeCloudOnce(deviceId, target);
  return null;
}

beforeEach(() => {
  store.state = 'asleep';
  store.wakeCloudComputer.mockClear();
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
});

describe('useWakeCloudOnInput', () => {
  it('打开新建框(带着草稿)不叫;开始输入才叫', () => {
    act(() => root.render(createElement(OnInput, { deviceId: 'cloud', input: '0:草稿' })));
    expect(store.wakeCloudComputer).not.toHaveBeenCalled();
    act(() => root.render(createElement(OnInput, { deviceId: 'cloud', input: '0:草稿,' })));
    expect(store.wakeCloudComputer).toHaveBeenCalledWith('cloud');
  });

  it('换了目标机器、草稿原样留着 ❌ 叫;叫醒没成之后敲字 ❌ 再叫', () => {
    act(() => root.render(createElement(OnInput, { deviceId: 'box', input: '0:hi' })));
    act(() => root.render(createElement(OnInput, { deviceId: 'cloud', input: '0:hi' })));
    expect(store.wakeCloudComputer).not.toHaveBeenCalled();
    store.state = 'wake-failed';
    act(() => root.render(createElement(OnInput, { deviceId: 'cloud', input: '0:hi!' })));
    expect(store.wakeCloudComputer).not.toHaveBeenCalled();
  });
});

describe('useWakeCloudOnce', () => {
  it('每次选中叫一次;开着时它又睡着 ❌ 再叫;换一台再选回来 = 新的一次', () => {
    act(() => root.render(createElement(Once, { deviceId: 'cloud', target: 'asleep' })));
    act(() => root.render(createElement(Once, { deviceId: 'cloud', target: 'other' })));
    act(() => root.render(createElement(Once, { deviceId: 'cloud', target: 'asleep' })));
    expect(store.wakeCloudComputer).toHaveBeenCalledTimes(1);
    act(() => root.render(createElement(Once, { deviceId: 'box', target: 'other' })));
    act(() => root.render(createElement(Once, { deviceId: 'cloud', target: 'asleep' })));
    expect(store.wakeCloudComputer).toHaveBeenCalledTimes(2);
  });

  it('设备表还没到(null)先不算这一次', () => {
    act(() => root.render(createElement(Once, { deviceId: 'cloud', target: null })));
    act(() => root.render(createElement(Once, { deviceId: 'cloud', target: 'asleep' })));
    expect(store.wakeCloudComputer).toHaveBeenCalledTimes(1);
  });
});
