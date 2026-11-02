import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WidgetBubble } from '@/components/chat/WidgetBubble';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';

const state = vi.hoisted(() => ({
  manifests: [] as { id: string; version: string; contributes: { tabs: { name: string; widget?: { height: number } }[] } }[],
  shared: new Map(),
  notify: null as null | ((chat: string) => void),
  installAttachment: vi.fn(), installFromMarket: vi.fn(), marketOffers: vi.fn(),
}));
vi.mock('react-i18next', async original => ({ ...(await original<object>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/store/auth', async original => ({ ...(await original<object>()), useAuth: () => ({ user: { id: 'reader' } }) }));
vi.mock('@/components/chat/useConversationVisibility', () => ({ useConversationVisibility: () => ({ ref: () => undefined, shown: true }) }));
vi.mock('@/components/appSlot/appsHere', () => ({ appsHere: { ...state, runs: () => true } }));
vi.mock('@/components/extensionBundle/sharedPackages', async original => ({
  ...(await original<object>()),
  sharedPackagesOf: async () => state.shared,
  subscribeSharedPackages: (fn: (chat: string) => void) => { state.notify = fn; return () => { state.notify = null; }; },
}));
vi.mock('@renderer/features/extensions/extension-view-layer', () => ({ ExtensionPage: () => <div>Widget view</div> }));
vi.mock('@renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: {
  isLoaded: true, get manifests() { return state.manifests; }, origins: {},
  manifestFor: (id: string) => state.manifests.find(m => m.id === id), isEnabled: () => true,
} }));
const pkg = () => ({ manifest: { id: 'vote', name: 'Vote', version: '2.0.0', contributes: { tabs: [{ name: 'main', widget: { height: 200 } }] } }, card: { source: { kind: 'message', messageId: 'package-message' }, messageId: 'package-message' } });
const message = { id: 'widget', chat_id: 'chat', sender_user_id: 'agent', content: JSON.stringify({ v: 2, app: 'vote', view: 'main', text: 'Vote here' }) };
let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => {
  state.manifests = []; state.shared = new Map(); state.notify = null;
  state.installAttachment.mockReset().mockResolvedValue({ success: true, data: { installed: false, outcome: 'cancelled' } });
  state.installFromMarket.mockReset(); state.marketOffers.mockReset().mockResolvedValue({ success: true, data: [] });
});
afterEach(() => harness?.cleanup());
const button = () => [...harness.container.querySelectorAll('button')].find(b => b.textContent === 'chatArea.openWith.install');
async function mount() { harness = createReactHarness(); await harness.render(<WidgetBubble message={message} />); }

it('offers an unlisted package from this chat through the same attachment consent entry', async () => {
  state.shared.set('vote', pkg());
  await mount();
  await until('the shared App can be installed from the widget', () => !!button());
  button()!.click();
  await until('the original attachment installer is called', () => state.installAttachment.mock.calls.length === 1);
  expect(state.installAttachment).toHaveBeenCalledWith({ messageId: 'package-message', chatId: 'chat' });
  expect(state.installFromMarket).not.toHaveBeenCalled();
  await until('cancelling consent restores the button', () => !button()?.disabled);
  expect(harness.container.querySelector('[role="alert"]')).toBeNull();
});
it('offers a later chat package without reloading the widget', async () => {
  await mount();
  await until('the shared package subscription is active', () => state.notify !== null);
  expect(button()).toBeUndefined();
  state.shared = new Map([['vote', pkg()]]);
  state.notify!('chat');
  await until('the newly shared App is offered', () => !!button());
});
it('offers a newer package when the installed App lacks the widget view', async () => {
  state.manifests = [{ id: 'vote', version: '1.0.0', contributes: { tabs: [{ name: 'old' }] } }];
  state.shared.set('vote', pkg());
  await mount();
  await until('the new view is available to install', () => !!button());
  expect(harness.container.textContent).toContain('message.widgetUnavailable.view');
});
