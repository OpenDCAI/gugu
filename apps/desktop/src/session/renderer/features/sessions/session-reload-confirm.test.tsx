// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ titles: [] as Array<{ open: boolean; title: string }> }));

vi.mock('@gugu/session-ui/react/components', () => ({
  ConfirmationDialog: ({ open, title }: { open: boolean; title: string }) => {
    h.titles.push({ open, title });
    return null;
  },
}));
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({
    translate: (key: string, vars?: Record<string, string>) => `${key}(${vars?.target ?? vars?.agentName ?? ''})`,
  }),
}));

import { SessionReloadConfirm } from './session-reload-confirm';

describe('SessionReloadConfirm', () => {
  it('keeps the last open content while closing, so the exit animation does not read "switch to ?"', () => {
    const root = createRoot(document.createElement('div'));
    const render = (props: { open: boolean; target: string; isReloading: boolean }) =>
      act(() => {
        root.render(
          <SessionReloadConfirm
            {...props}
            onOpenChange={() => undefined}
            reason="permission-switch"
            agentName="DeepSeek Harness"
            onConfirm={() => undefined}
          />,
        );
      });

    render({ open: true, target: 'Full Access', isReloading: false });
    render({ open: true, target: 'Full Access', isReloading: true });
    // The caller closes by clearing its pending target and the reloading flag in one render.
    render({ open: false, target: '', isReloading: false });

    expect(h.titles.map((entry) => entry.title)).toEqual([
      'chat.reloadConfirmTitlePermission(Full Access)',
      'chat.reloadInProgressPermission(DeepSeek Harness)',
      'chat.reloadInProgressPermission(DeepSeek Harness)',
    ]);
    expect(h.titles.at(-1)?.open).toBe(false);
    act(() => root.unmount());
  });
});
