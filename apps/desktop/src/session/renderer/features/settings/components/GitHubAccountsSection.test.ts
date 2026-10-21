import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@renderer/lib/ipc', () => ({ rpc: { github: {}, projects: {} }, events: { on: () => () => {} } }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => vi.fn() }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn(), useToast: () => ({ toast: vi.fn() }) }));

const { GitHubAccountRows } = await import('./GitHubAccountsSection');

const account = { accountId: 'gh:1', login: 'octo', isDefault: false, source: 'device-flow' } as never;

async function render(readOnly: boolean) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('navigator', dom.window.navigator);
  const root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        React.createElement(
          SessionLocalizationProvider,
          null,
          React.createElement(GitHubAccountRows, { accounts: [account], readOnly })
        )
      )
    );
  });
  const buttons = [...dom.window.document.querySelectorAll('button')];
  act(() => root.unmount());
  vi.unstubAllGlobals();
  return buttons;
}

describe('别的机器上的 GitHub 账号行(#6264)', () => {
  it('那台机器离线 / 太旧:「设为默认」「移除」与其余离线动作一样灰着', async () => {
    const buttons = await render(true);
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });

  it('在线:照常可点', async () => {
    const buttons = await render(false);
    expect(buttons.some((button) => !button.disabled)).toBe(true);
  });
});
