// @vitest-environment jsdom
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageProvider } from '@gugu/session-ui/react/components';
import { translateSessionMessage } from '@renderer/localization/locale-store';

// #7092 免费号首启一条会员模型的任务,签票被拒。owner:「模型不能用，不能说任务不能启动吧」「只是个模型不能用」。
const invoke = vi.fn();
const openMembershipPage = vi.fn();
vi.mock('@renderer/lib/ipc', () => ({ invokeOnMachine: (...args: unknown[]) => invoke(...args) }));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => null } }));
vi.mock('@renderer/features/library/library-host', () => ({ useLibraryHost: () => ({ remote: null }) }));
vi.mock('@renderer/lib/stores/use-agents', () => ({ useAgents: () => ({ data: [] }) }));
vi.mock('@renderer/features/settings/agents-page/AgentDetailModal', () => ({ AgentDetailModal: () => null }));
vi.mock('@renderer/features/sessions/session-config/use-composer-model-options', () => ({
  openMembershipPage: () => openMembershipPage(),
}));

import { SessionStartFailedView } from './session-start-failed-view';
import type { SessionStartupFailure } from './stores/session-startup-failures';

const CATALOG = {
  models: [
    { id: 'glm-5.3-flash', displayName: 'GLM-5.3 Flash', protocol: 'anthropic-messages' },
    { id: 'glm-5.3', displayName: 'GLM-5.3', protocol: 'anthropic-messages', requiresMembership: true },
  ],
  sessionSelection: { modelId: 'glm-5.3' },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MessageProvider locale="zh-CN" translate={translateSessionMessage}>
        {node}
      </MessageProvider>
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(testId: string): HTMLButtonElement {
  const found = container!.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`no ${testId}`);
  return found;
}

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(CATALOG);
  openMembershipPage.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('SessionStartFailedView — the model needs a membership', () => {
  const failure: SessionStartupFailure = {
    sessionId: 'session-1',
    message: "Error invoking remote method 'pty:start': Error: gugu-models:membership-required",
    retrying: false,
    runtimeUpgrade: null,
  };

  // 按钮照规格原因表:要会员给「开通会员」,另带「我开好了」(开完回来再起一次);❌ 再摆「换模型」。
  it('talks about the model, not about a broken task, and offers getting a membership', async () => {
    const onRetry = vi.fn();
    const onSwitchModel = vi.fn();
    await render(
      <SessionStartFailedView failure={failure} onRetry={onRetry} providerId="codex" onSwitchModel={onSwitchModel} />
    );

    const text = container!.textContent ?? '';
    // 要会员的是咕咕提供的那一个:名字照模型按钮的叫法带「咕咕」,❌ 裸名(用户自己的同名模型不用会员)。
    expect(text).toContain('Gugu GLM-5.3 needs a membership');
    expect(text).not.toContain('没能启动');
    expect(text).not.toMatch(/could not start/i);
    expect(text).not.toContain('ModelAccessHttpError');
    expect(text).not.toContain('gugu-models');

    expect(container!.querySelector('[data-testid="session-start-switch-model"]')).toBeNull();
    act(() => button('session-start-join-membership').click());
    expect(openMembershipPage).toHaveBeenCalledTimes(1);
    // 「我开好了」先让模型下拉重取目录(会员可能是在别处开的),再起一次。
    const refreshed = vi.fn();
    window.addEventListener('gugu:platform-models-changed', refreshed);
    act(() => button('session-start-membership-retry').click());
    window.removeEventListener('gugu:platform-models-changed', refreshed);
    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('still names what happened when the model list is not there', async () => {
    invoke.mockReset().mockRejectedValue(new Error('offline'));
    await render(<SessionStartFailedView failure={failure} onRetry={() => {}} providerId="codex" />);

    const detail = container!.querySelector('[data-testid="session-start-failure-detail"]')?.textContent ?? '';
    expect(detail).toBe('This Gugu model needs a membership. Switch models, or get a membership, then resend.');
    expect(detail).not.toContain('没能启动');
  });

  // #7103 咕咕这一侧没说清原因的内部故障:一句「咕咕这边出错了」+ 重试,原文只进日志。
  it('says "something went wrong on Gugu\'s side" for a Gugu-side failure without a spoken reason', async () => {
    const onRetry = vi.fn();
    await render(
      <SessionStartFailedView
        failure={{ ...failure, message: "Error invoking remote method 'pty:start': Error: gugu-models:service-unavailable" }}
        onRetry={onRetry}
        providerId="codex"
        onSwitchModel={() => {}}
      />
    );
    expect(container!.querySelector('[data-reason="service-unavailable"]')).not.toBeNull();
    const detail = container!.querySelector('[data-testid="session-start-failure-detail"]')?.textContent ?? '';
    expect(detail).toBe("Something went wrong on Gugu's side.");
    expect(container!.textContent).not.toContain('gugu-models');
    expect(container!.querySelector('[data-testid="session-start-switch-model"]')).toBeNull();
    act(() => button('session-start-retry').click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // #4657 咕咕以外(harness 起不来)不带原因码:递它的原话一行,去掉路径,+ 重试。
  it("passes on the harness's own words in one line, without local paths", async () => {
    const onRetry = vi.fn();
    await render(
      <SessionStartFailedView
        failure={{ ...failure, message: 'spawn codex ENOENT at /Users/someone/.local/bin/codex\n    at ChildProcess._handle' }}
        onRetry={onRetry}
        providerId="codex"
        onSwitchModel={() => {}}
      />
    );
    expect(container!.querySelector('[data-reason="harness"]')).not.toBeNull();
    const detail = container!.querySelector('[data-testid="session-start-failure-detail"]')?.textContent ?? '';
    expect(detail).toBe('spawn codex ENOENT at [path]');
    expect(container!.textContent).not.toContain('/Users/someone');
    expect(container!.textContent).not.toContain('ChildProcess');
    expect(container!.querySelector('[data-testid="session-start-switch-model"]')).toBeNull();
    act(() => button('session-start-retry').click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

// #7103 评审 F2:这一页手上没有咕咕的登录入口,给「我已登录」—— 在别处登好了回来再起一次(先清退避)。
describe('SessionStartFailedView — signed out of Gugu', () => {
  it("says so and offers \"I've signed in\", which starts the task again", async () => {
    const onRetry = vi.fn();
    await render(
      <SessionStartFailedView
        failure={{ sessionId: 'session-1', message: "Error invoking remote method 'pty:start': Error: gugu-models:signed-out", retrying: false, runtimeUpgrade: null }}
        onRetry={onRetry}
        providerId="codex"
      />
    );
    expect(container!.querySelector('[data-reason="signed-out"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="session-start-failure-detail"]')?.textContent)
      .toBe(translateSessionMessage('guguCatalog.reason.signed-out'));
    const signedIn = button('session-start-signed-in-retry');
    expect(signedIn.textContent).toBe(translateSessionMessage('chat.signInDone'));
    act(() => signedIn.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('SessionStartFailedView — the model is no longer sold (#7103)', () => {
  const failure: SessionStartupFailure = {
    sessionId: 'session-1',
    message: "Error invoking remote method 'pty:start': Error: gugu-models:model-unavailable",
    retrying: false,
    runtimeUpgrade: null,
  };

  it('names the model and offers only switching models', async () => {
    const onSwitchModel = vi.fn();
    await render(
      <SessionStartFailedView failure={failure} onRetry={() => {}} providerId="codex" onSwitchModel={onSwitchModel} />
    );
    expect(container!.querySelector('[data-reason="model-unavailable"]')).not.toBeNull();
    expect(container!.textContent).toContain('Gugu GLM-5.3 is unavailable now. Switch to another model, then resend.');
    expect(container!.querySelector('[data-testid="session-start-join-membership"]')).toBeNull();
    expect(container!.querySelector('[data-testid="session-start-membership-retry"]')).toBeNull();
    act(() => button('session-start-switch-model').click());
    expect(onSwitchModel).toHaveBeenCalledTimes(1);
  });
});
