import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { contact, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { SettingsPanel } from '@/components/SettingsPanel';
import { AgentSettingsModal } from '@/components/agentsettings/AgentSettingsModal';
import { AgentModelPicker } from '@/components/agentsettings/AgentModelPicker';
import { Sheet } from '@/components/ui/Sheet';
import { i18n } from '@/i18n';
import '@/i18n/registerMainCatalog';
import '@/i18n/registerSettingsCatalog';
import '@/styles/tokens.css';

const fixture = vi.hoisted(() => ({
  assistant: { id: 'assistant-layer', display_name: 'Layer assistant', avatar: null, type: 'agent' as const, owner_user_id: 'owner-layer', agent_type: 'claude-code' as const },
}));
// Only external identity/presence/device reads are fixtures. Both dialogs, their
// portals, styles and the look/model panes are the actual product components.
vi.mock('@/lib/myAssistant', async (original) => ({
  ...await original<object>(),
  useMyAssistantContact: () => ({ contact: fixture.assistant, agentId: fixture.assistant.id, loading: false, error: null, homeDeviceId: null }),
  useMyAssistant: () => ({ agentId: fixture.assistant.id, loading: false, error: null }),
}));
vi.mock('@/lib/useAssistantHome', () => ({
  useAssistantHome: () => ({ mine: { loading: false }, contact: fixture.assistant, home: null, localDeviceId: null, snapshot: null, cloudDeviceId: null, cloudComputer: null, devices: [] }),
}));
vi.mock('@/lib/avatarIdentity', async (original) => ({
  ...await original<object>(), useIsAssistantAvatar: (id: string) => id === fixture.assistant.id,
}));
vi.mock('@/hooks/useAgentDisplayStatus', () => import('../../../../../../../tests/support/agentDisplayStatusTestDouble'));
vi.mock('@/session/renderer/lib/ipc', async (original) => ({ ...await original<object>(), invokeOnMachine: async () => ({ ok: true }) }));

let harness: ReturnType<typeof createReactHarness>;
let previousTheme: string | undefined;
beforeEach(async () => {
  await page.viewport(1600, 1000);
  await i18n.changeLanguage('en');
  previousTheme = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = 'light';
  harness = createReactHarness();
});
afterEach(() => {
  harness.cleanup();
  if (previousTheme) document.documentElement.dataset.theme = previousTheme;
  else delete document.documentElement.dataset.theme;
});

async function dialog() {
  await until('the real agent settings dialog has its desktop layout', () => {
    const node = document.querySelector<HTMLElement>('[data-testid="agent-settings-modal"]');
    return !!node && node.getBoundingClientRect().width >= 879 && !node.hasAttribute('data-starting-style');
  });
  return document.querySelector<HTMLElement>('[data-testid="agent-settings-modal"]')!;
}

it.each(['look', 'model'])('the real %s settings dialog receives hits above the settings panel', async (entry) => {
  await renderWithAppProviders(harness, <SettingsPanel initialSection="assistant" onClose={vi.fn()} />, {
    auth: { id: 'owner-layer' }, contacts: { contacts: [contact(fixture.assistant)] },
  });
  const trigger = page.getByTestId(`settings-assistant-${entry}`);
  await userEvent.click(trigger);
  const modal = await dialog();
  const box = modal.getBoundingClientRect();
  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  expect(modal.contains(hit)).toBe(true);
});

it('keeps the default agent dialog outside Settings at the ordinary modal layer', async () => {
  await renderWithAppProviders(harness, <AgentSettingsModal agent={contact(fixture.assistant)} initialTab="look" onClose={vi.fn()} />, {
    auth: { id: 'owner-layer' }, contacts: {},
  });
  const modal = await dialog();
  expect(getComputedStyle(modal.closest('.gg-sheet-viewport')!).zIndex).toBe('2000');
});

it.each(['look', 'model'])('one desktop Escape closes %s and leaves Settings open', async (entry) => {
  const closeSettings = vi.fn();
  await renderWithAppProviders(harness, <SettingsPanel initialSection="assistant" onClose={closeSettings} />, {
    auth: { id: 'owner-layer' }, contacts: { contacts: [contact(fixture.assistant)] },
  });
  await userEvent.click(page.getByTestId(`settings-assistant-${entry}`));
  await dialog();
  await userEvent.keyboard('{Escape}');
  await until('the agent dialog closes after one Escape', () => !document.querySelector('[data-testid="agent-settings-modal"]'));
  expect(closeSettings).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid="settings-panel"]')).not.toBeNull();
});

it.each([2000, 5100])('the real model menu can be hit and selected above Sheet %i', async (zIndex) => {
  const select = vi.fn();
  await renderWithAppProviders(harness, <Sheet zIndex={zIndex} onClose={vi.fn()} ariaLabel="Model settings">
    <AgentModelPicker items={[{ id: 'first', name: 'First model' }, { id: 'second', name: 'Second model' }]}
      value="first" disabled={false} onChange={select} />
  </Sheet>, { auth: { id: 'owner-layer' }, contacts: {} });
  await userEvent.click(page.getByTestId('composer-model-trigger'));
  await until('the real model menu opens', () => !!document.querySelector('[data-slot="combobox-content"]'));
  const popup = document.querySelector<HTMLElement>('[data-slot="combobox-content"]')!;
  const box = popup.getBoundingClientRect();
  expect(popup.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))).toBe(true);
  expect(getComputedStyle(popup.parentElement!).zIndex).toBe(String(zIndex + 1));
  await userEvent.click(page.getByRole('option', { name: 'Second model', exact: true }));
  expect(select).toHaveBeenCalledWith('second');
});
