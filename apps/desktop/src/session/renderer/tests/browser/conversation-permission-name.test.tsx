import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { useConversationOptions } from '@/components/chat/useConversationOptions';
import { i18n } from '@/i18n';

const state = vi.hoisted(() => ({ withModelMenu: true }));
vi.mock('@/components/assistant/assistantTimelineClient', () => ({
  conversationOptionClient: () => ({
    read: async () => ({
      mode: { selected: ':read-only', available: [{ id: ':read-only', name: 'native' }] },
      modeMap: { 'read-only': { id: ':read-only' } },
      permissionAgentName: 'Codex',
      ...(state.withModelMenu ? { modelMenu: { agentName: 'Codex' } } : {}),
    }),
  }),
}));

let root: Root | undefined;
afterEach(async () => {
  root?.unmount();
  document.body.replaceChildren();
  await i18n.changeLanguage('zh-CN');
});

function PermissionDescription() {
  const { props } = useConversationOptions({ deviceId: 'host', sessionId: 'session', local: false }, 'Agent nickname');
  return <p>{props.permissionModeOptions?.[':read-only']?.description}</p>;
}

it.each([
  { locale: 'en-US', withModelMenu: true }, { locale: 'zh-CN', withModelMenu: true },
  { locale: 'en-US', withModelMenu: false }, { locale: 'zh-CN', withModelMenu: false },
] as const)('conversation permissions use host metadata in $locale (model menu: $withModelMenu)', async ({ locale, withModelMenu }) => {
  state.withModelMenu = withModelMenu;
  await i18n.changeLanguage(locale);
  root = createRoot(document.body.appendChild(document.createElement('div')));
  root.render(<PermissionDescription />);
  await until('the host name is interpolated', () => document.body.textContent?.includes('Codex') === true);
  expect(document.body.textContent).not.toContain('Agent nickname');
  expect(document.body.textContent).not.toContain('{agent}');
});
