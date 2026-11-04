import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot, type Root } from 'react-dom/client';
import { useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AssistantMainPanel } from '@renderer/features/assistant/assistant-view';
import { installAssistantShellBridge, publishAssistantShell } from '@/lib/assistantShellBridge';
import { installShellSlots, readShellSlots } from '@/lib/shellSlots';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { AssistantEngineChoice } from '@/components/assistant/AssistantEngineChoice';
import type { AssistantEngine } from '@/lib/assistantHomeIpc';
import { DEFAULT_ASSISTANT_LOOK } from '@/components/agentAvatar/look';
import { subscriptionKey } from '@renderer/features/settings/subscriptions/subscription-queries';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { setLocalePreference } from '@/i18n';
import '@/i18n/registerAssistantCatalog';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { ModalRenderer } from '@renderer/lib/modal/modal-renderer';
import { untilStable } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';
import '@/components/assistant/assistant-onboarding.css';

const f = vi.hoisted(() => ({
  states: { claude: 'authenticated', codex: 'authenticated' } as Record<string, string>,
  hold: null as Promise<void> | null,
  continued: vi.fn(), back: vi.fn(), missingProgram: false, saved: false, selected: '',
}));
function agent(id: string): AgentPayload {
  return { id, name: id === 'codex' ? 'Codex' : 'Claude', status: f.missingProgram ? 'missing' : 'available',
    reading: f.missingProgram ? 'not-detected' : 'installed', command: id, installOptions: [], capabilities: {
      hostDependency: { updates: { kind: 'none' }, uninstall: { kind: 'none' } },
      hooks: { kind: 'none' }, sessions: { kind: 'stateless' },
      auth: { kind: 'supported', methods: [{ kind: 'cli-login', id: `${id}-login`, name: id, args: ['login'] }] },
    },
  } as unknown as AgentPayload;
}
vi.mock('@renderer/lib/ipc', async original => {
  const actual = await original<typeof import('@renderer/lib/ipc')>();
  const pending = () => new Promise(() => {});
  const agents = { get: async (id: string) => agent(id), getManagement: async (id: string) => agent(id),
    listIcons: async () => ({}), getSettings: async () => null,
    modelCatalog: async () => ({ state: { kind: 'ready', models: [] }, refreshing: false }) };
  return { ...actual, rpc: new Proxy({}, { get: (_, key) => key === 'agents' ? agents : new Proxy({}, { get: () => pending }) }) };
});
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async () => ({
    refreshAuthStatus: async ({ providerId }: { providerId: string }) => {
      if (f.hold) await f.hold;
      return { success: true, data: { kind: f.states[providerId], credentialKind: 'api-key' } };
    },
    listConnections: async () => ({ success: true, data: [
      { id: 'native', kind: 'native', name: 'CLI', current: !f.selected },
      ...(f.saved ? [{ id: 'saved', kind: 'api-key', name: 'Saved API', current: !!f.selected }] : []),
    ] }),
    createConnection: async () => {
      f.saved = true;
      return { success: true, data: { id: 'saved', kind: 'api-key', name: 'Saved API', current: false } };
    },
    selectConnection: async ({ providerId }: { providerId: string }) => {
      f.selected = providerId; f.states[providerId] = 'authenticated';
      return { success: true };
    },
    readSubscription: async () => ({ success: true, data: { payer: 'not-signed-in' } }),
    readSubscriptionUsage: async () => ({ success: true, data: { kind: 'unavailable', reason: 'not-signed-in' } }),
  }),
}));
// Keep the real main panel, ShellSlot and shell portal registry: the shell's
// read models and unrelated device services are the only substituted boundaries.
vi.mock('@renderer/lib/layout/navigation-provider', async original => ({ ...await original<typeof import('@renderer/lib/layout/navigation-provider')>(), useParams: () => ({ params: {}, setParams: vi.fn() }) }));
vi.mock('@/lib/assistantTaskChat', () => ({ useOpenedAssistantTaskChat: () => null, OPEN_ASSISTANT_TASK_CHAT: 'open-task', showAssistantTaskChat: vi.fn() }));
vi.mock('@/lib/assistantSetup', () => ({ refreshLocalAssistantHome: vi.fn(async () => {}) }));
vi.mock('@renderer/features/assistant/assistant-data', () => ({
  assistantWorkdir: () => null, useAssistantMachine: () => ({ data: null, isLoading: false, error: null }),
}));
vi.mock('@renderer/features/assistant/assistant-home-sessions', () => ({ homeTarget: () => null, localHomeSessions: { use: () => () => {} } }));
vi.mock('@renderer/features/assistant/voice-notes/voice-recording-bar', () => ({ useVoiceNotesHost: () => {}, VoiceRecordingBar: () => null }));
vi.mock('@renderer/features/assistant/assistant-pages', () => ({ ASSISTANT_PAGES: { today: () => null } }));
vi.mock('@renderer/features/assistant/assistant-ideas-layer', () => ({ AssistantIdeasLayer: () => null }));
vi.mock('@renderer/features/assistant/assistant-setup-finish', () => ({ AssistantSetupFinish: () => { throw new Error('Expected the onboarding shell, not completed setup'); } }));
vi.mock('@renderer/lib/components/titlebar/shell-titlebar', () => ({ ShellTitlebar: () => { throw new Error('Expected the onboarding shell, not the assistant titlebar'); } }));
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  setLocalePreference('en-US');
  f.states = { claude: 'authenticated', codex: 'authenticated' }; f.hold = null; f.missingProgram = false; f.saved = false; f.selected = '';
  f.continued.mockClear(); f.back.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  host = document.createElement('div'); host.className = 'gugu-skin emlight'; host.style.cssText = 'height:100vh';
  document.body.append(host); root = createRoot(host);
  installShellSlots(); installAssistantShellBridge();
  publishAssistantShell({ cloudAvailable: true, canHostHere: true, cloud: null, loadError: null,
    assistant: null, assistantState: 'none', ownerName: 'Owner', chatId: null, home: null,
    setup: 'shell', member: true, preparing: false });
});
afterEach(() => { modalStore.closeModal(); root.unmount(); client.clear(); host.remove(); });
function Harness() {
  const [engine, setEngine] = useState<AssistantEngine>('claude');
  const slots = readShellSlots()!;
  const registered = useSyncExternalStore(slots.subscribeSlots, slots.getSlots);
  const slot = registered.get('assistant:onboarding');
  return <><AssistantMainPanel />{slot && createPortal(<div className="ta-onb-slot ta-onb-slot-engine"><section className="ta-onb ta-onb-engine" data-testid="engine-frame">
    <AssistantEngineChoice engine={engine} onEngineChange={setEngine} draft={{ name: 'Gugu', ...DEFAULT_ASSISTANT_LOOK,
      owner: { preferredName: 'Owner', about: '' } }} onContinue={() => f.continued(engine)} onBack={f.back} />
    <ModalRenderer />
  </section></div>, slot)}</>;
}
function render() {
  root.render(<QueryClientProvider client={client}><SessionLocalizationProvider><Harness /></SessionLocalizationProvider></QueryClientProvider>);
}
const rect = (element: Element) => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
};
function boxes() {
  return ['engine-frame', 'assistant-engine-claude', 'assistant-engine-codex', 'assistant-engine-continue']
    .map(id => rect(page.getByTestId(id).element()));
}
async function refresh(id: string) { await client.invalidateQueries({ queryKey: [...subscriptionKey(null, id), 'availability'] }); }

it.each([1440, 390])('keeps both 74px cards, the frame and single action fixed through every state at %ipx', async width => {
  await page.viewport(width, 900); render();
  await expect.element(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await untilStable('engine layout settled', boxes);
  const initial = boxes();
  const samples: Array<{ engine: string; state: string; boxes: ReturnType<typeof boxes> }> = [];
  expect(initial[0].width).toBeGreaterThan(300);
  // 8px of the actual main panel plus 24px of the engine step's top inset.
  expect(initial[0].y - host.getBoundingClientRect().y).toBe(32);
  expect(initial[2].y - initial[1].y - initial[1].height).toBe(16);
  const brandNames = [...host.querySelectorAll('.ta-engine-name')];
  expect(brandNames).toHaveLength(2);
  for (const name of brandNames) {
    expect(getComputedStyle(name).fontSize).toBe('20px');
  }
  if (width === 390) {
    expect(initial[1].x - host.getBoundingClientRect().x).toBe(16);
    expect(initial[1].width).toBe(358);
    const frameStyle = getComputedStyle(page.getByTestId('engine-frame').element());
    expect(frameStyle.padding).toBe('0px');
    expect(frameStyle.borderWidth).toBe('0px');
    expect(frameStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)');
  }
  for (const box of initial.slice(1, 3)) { expect(box.height).toBe(74); expect(box.width).toBeGreaterThan(200); }
  for (const id of ['claude', 'codex']) {
    await userEvent.click(page.getByTestId(`assistant-engine-${id}`));
    for (const state of ['authenticated', 'unauthenticated', 'unknown', 'authenticated']) {
      f.states[id] = state; await refresh(id);
      const name = state === 'authenticated' ? 'Continue' : state === 'unknown' ? 'Check again' : `Configure ${id === 'codex' ? 'Codex' : 'Claude'}`;
      await expect.element(page.getByRole('button', { name, exact: true })).toBeVisible();
      samples.push({ engine: id, state, boxes: boxes() });
      expect(boxes()).toEqual(initial);
      if (state === 'authenticated') expect(page.getByTestId(`assistant-engine-${id}`).element().textContent).not.toContain('Not ready');
    }
    let finish!: () => void;
    f.hold = new Promise<void>(resolve => { finish = resolve; });
    const pending = refresh(id);
    await expect.element(page.getByRole('button', { name: 'Checking…', exact: true })).toBeDisabled();
    samples.push({ engine: id, state: 'checking', boxes: boxes() });
    expect(boxes()).toEqual(initial);
    finish(); await pending; f.hold = null;
    await expect.element(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
    expect(boxes()).toEqual(initial);
  }
  console.info('ENGINE_GEOMETRY_JSON', JSON.stringify({ width, initial, samples, cardGap: initial[2].y - initial[1].y - initial[1].height, brandFontSizes: brandNames.map(name => getComputedStyle(name).fontSize), framePadding: getComputedStyle(page.getByTestId('engine-frame').element()).padding, frameBorder: getComputedStyle(page.getByTestId('engine-frame').element()).borderWidth }));
});

it.each(['claude', 'codex'])('continues with usable %s API credentials without an account subscription', async id => {
  render();
  await expect.element(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await userEvent.click(page.getByTestId(`assistant-engine-${id}`));
  await userEvent.click(page.getByRole('button', { name: 'Continue', exact: true }));
  expect(f.continued).toHaveBeenCalledExactlyOnceWith(id);
});

it.each(['claude', 'codex'])('opens the existing %s connection panel and accessible API form without leaving setup', async id => {
  f.states[id] = 'unauthenticated'; render();
  await expect.element(page.getByTestId('assistant-engine-claude')).toBeVisible();
  await userEvent.click(page.getByTestId(`assistant-engine-${id}`));
  const name = id === 'codex' ? 'Codex' : 'Claude';
  await userEvent.click(page.getByRole('button', { name: `Configure ${name}`, exact: true }));
  await userEvent.click(page.getByRole('menuitem', { name: 'Add connection', exact: true }));
  await expect.element(page.getByRole('dialog', { name: `Add a ${name} connection`, exact: true })).toBeVisible();
  await userEvent.click(page.getByRole('button', { name: 'API Key', exact: true }));
  await expect.element(page.getByLabelText('API Key', { exact: true })).toBeVisible();
  const form = document.querySelector('.subscription-connection-form')!;
  expect(form.closest('[aria-hidden="true"], [inert]')).toBeNull();
  expect(f.continued).not.toHaveBeenCalled();
});

it('shows retry while unknown and completes a fresh check before allowing setup', async () => {
  f.states.claude = 'unknown'; render();
  await userEvent.click(page.getByRole('button', { name: 'Check again', exact: true }));
  expect(f.continued).not.toHaveBeenCalled();
  f.states.claude = 'authenticated';
  await userEvent.click(page.getByRole('button', { name: 'Check again', exact: true }));
  await expect.element(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
});

it('offers connection configuration before installing a not-detected local engine', async () => {
  f.missingProgram = true; f.states.codex = 'unknown'; render();
  await userEvent.click(page.getByTestId('assistant-engine-codex'));
  await expect.element(page.getByRole('button', { name: 'Configure Codex', exact: true })).toBeVisible();
  expect(f.continued).not.toHaveBeenCalled();
});

it('returns from the shared API form and continues with the same selected Codex engine', async () => {
  f.states.codex = 'unauthenticated'; render();
  await userEvent.click(page.getByTestId('assistant-engine-codex'));
  await userEvent.click(page.getByRole('button', { name: 'Configure Codex', exact: true }));
  await userEvent.click(page.getByRole('menuitem', { name: 'Add connection', exact: true }));
  await userEvent.click(page.getByRole('button', { name: 'API Key', exact: true }));
  await userEvent.fill(page.getByLabelText('API Key', { exact: true }), 'sk-isolated-test-fixture');
  await userEvent.click(page.getByRole('button', { name: 'Save connection', exact: true }));
  await userEvent.click(page.getByTestId('connection-use-saved'));
  await expect.element(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await expect.element(page.getByTestId('assistant-engine-codex')).toHaveAttribute('aria-checked', 'true');
  await userEvent.click(page.getByRole('button', { name: 'Continue', exact: true }));
  expect(f.selected).toBe('codex');
  expect(f.continued).toHaveBeenCalledExactlyOnceWith('codex');
});
