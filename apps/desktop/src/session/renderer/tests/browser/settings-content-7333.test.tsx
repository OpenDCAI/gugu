import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { AssistantSection } from '@/components/settings/AssistantSection';
import { AccountSection } from '@/components/settings/AccountSection';
import { Pane, PaneHeader } from '@/components/ui/Pane';
import { i18n } from '@/i18n';
import '@/i18n/registerMainCatalog';
import '@/i18n/registerSettingsCatalog';
import '@/styles/tokens.css';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@/lib/useAssistantHome', () => ({ useAssistantHome: () => ({ mine: { loading: false }, contact: { id: 'assistant-content', display_name: '小咕', avatar: null }, home: null, localDeviceId: null, snapshot: null, cloudDeviceId: null, cloudComputer: null, devices: [] }) }));
vi.mock('@/lib/firstRun', async (original) => ({ ...(await original<object>()), readOccupation: async () => null, writeOccupation: vi.fn() }));
const { nicknameUpdate } = vi.hoisted(() => ({ nicknameUpdate: vi.fn(async () => ({ success: true })) }));
vi.mock('@/lib/auth', async (original) => {
  const actual = await original<typeof import('@/lib/auth')>();
  return { ...actual, authService: { ...actual.authService, updateNickname: nicknameUpdate } };
});
vi.mock('@/session/renderer/lib/ipc', async (original) => ({ ...(await original<object>()), invokeOnMachine: async () => ({ ok: true }) }));

const user = { id: 'settings-content-user', nickname: '验收账号', email: 'settings@example.com', bio: '' };
let harness: ReturnType<typeof createReactHarness>;
function Frame({ children, mobile = false }: { children: ReactNode; mobile?: boolean }) {
  return <Pane paneRole="detail" mobile={mobile} className="gg-settings-detail">
    <PaneHeader title="资料" />
    <div className="gg-settings-body">{children}</div>
  </Pane>;
}
beforeEach(async () => {
  await page.viewport(1100, 900);
  await i18n.changeLanguage('zh-CN');
  document.documentElement.dataset.theme = 'light';
  nicknameUpdate.mockClear();
  harness = createReactHarness();
  harness.container.style.cssText = 'display:flex;width:800px;height:760px;';
});
afterEach(() => { harness.cleanup(); delete document.documentElement.dataset.theme; });

it.each(['light', 'dark'])('actual assistant content distinguishes identity, editors and navigable entries in %s', async (theme) => {
  document.documentElement.dataset.theme = theme;
  const open = vi.fn();
  const openModel = vi.fn();
  const update = vi.fn(async () => {});
  await renderWithAppProviders(harness, <Frame><AssistantSection available={['connectors', 'devices', 'channels']} onOpenSection={open} onOpenAssistantPage={open} onOpenModel={openModel} /></Frame>, { auth: user, contacts: { updateAgentProfile: update } });
  const summary = harness.container.querySelector<HTMLElement>('[data-settings-group="summary"] > .gg-settings-card')!;
  expect(summary.getBoundingClientRect().width).toBe(640);
  expect(getComputedStyle(summary).borderWidth).toBe('0px');
  expect(getComputedStyle(summary).borderRadius).toBe('12px');
  expect(getComputedStyle(summary).backgroundColor).not.toBe(getComputedStyle(harness.container.querySelector('.gg-settings-detail')!).backgroundColor);
  expect(harness.container.querySelector('input')).toBeNull();
  const title = harness.container.querySelector<HTMLElement>('[data-testid="assistant-name-display"]')!;
  expect(title.textContent).toBe('小咕');
  expect(harness.container.querySelector('[data-testid="assistant-name-edit"] svg')!.getBoundingClientRect().width).toBe(16);
  const memory = harness.container.querySelector<HTMLElement>('[data-testid="settings-assistant-open-memory"]')!;
  expect(getComputedStyle(memory).borderRadius).toBe('8px');
  expect(memory.querySelector('.gg-settings-row-leading svg')!.getBoundingClientRect().width).toBe(16);
  const resting = getComputedStyle(memory).backgroundColor;
  await userEvent.hover(memory);
  await until('navigation hover appears', () => getComputedStyle(memory).backgroundColor !== resting);
  memory.focus();
  await userEvent.keyboard('{Enter}');
  expect(open).toHaveBeenCalledExactlyOnceWith('memory');
  await userEvent.click(harness.container.querySelector('[data-testid="settings-assistant-model"]')!);
  expect(openModel).toHaveBeenCalledTimes(1);
  await userEvent.dblClick(title);
  const name = harness.container.querySelector<HTMLInputElement>('[data-testid="assistant-name-input"]')!;
  expect(document.activeElement).toBe(name);
  await userEvent.fill(name, '小团');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  expect(update).toHaveBeenCalledExactlyOnceWith('assistant-content', { name: '小团' });
});

it.each([800, 480])('actual account editors stay together at %ipx and retain explicit save', async (width) => {
  harness.container.style.width = `${width}px`;
  const update = vi.fn();
  await renderWithAppProviders(harness, <Frame><AccountSection user={user} updateUser={update} logout={vi.fn()} /></Frame>, { auth: user });
  const name = harness.container.querySelector<HTMLInputElement>('#settings-account-name')!;
  const bio = harness.container.querySelector<HTMLInputElement>('#settings-account-bio')!;
  await until('occupation resolves', () => harness.container.querySelector('#settings-account-occupation') !== null);
  const editor = harness.container.querySelector<HTMLElement>('[data-settings-group="editor"]')!;
  expect(editor.getBoundingClientRect().width).toBeGreaterThan(400);
  expect(name.getBoundingClientRect().width).toBeGreaterThan(width === 800 ? 250 : 350);
  expect(name.getBoundingClientRect().right).toBeLessThanOrEqual(editor.getBoundingClientRect().right);
  const label = harness.container.querySelector<HTMLElement>('label[for="settings-account-name"]')!;
  expect(label.getBoundingClientRect().bottom).toBeLessThan(name.getBoundingClientRect().top);
  expect(bio.getBoundingClientRect().top).toBeGreaterThan(name.getBoundingClientRect().top);
  const occupation = harness.container.querySelector<HTMLElement>('#settings-account-occupation')!;
  if (width === 800) expect(bio.getBoundingClientRect().top).toBeCloseTo(occupation.getBoundingClientRect().top, 0);
  const privacy = occupation.closest<HTMLElement>('.gg-settings-row')!.querySelector<HTMLElement>('.gg-settings-row-description')!;
  expect(privacy.getBoundingClientRect().top).toBeGreaterThanOrEqual(occupation.getBoundingClientRect().bottom);
  await userEvent.fill(name, '新名字');
  expect(nicknameUpdate).not.toHaveBeenCalled();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  expect(nicknameUpdate).toHaveBeenCalledExactlyOnceWith(user.id, '新名字');
  expect(update).toHaveBeenCalledTimes(1);
  const danger = harness.container.querySelector<HTMLElement>('[data-settings-group="danger"]')!;
  expect(danger.getBoundingClientRect().top).toBeGreaterThan(editor.getBoundingClientRect().bottom);
  expect(getComputedStyle(danger).borderTopWidth).toBe('1px');
});

it('a rejected assistant rename retains the edited name and exposes the original error feedback', async () => {
  const update = vi.fn(async () => { throw new Error('fixture rename rejected'); });
  await renderWithAppProviders(harness, <Frame><AssistantSection available={[]} onOpenSection={vi.fn()} /></Frame>, { auth: user, contacts: { updateAgentProfile: update } });
  await userEvent.click(harness.container.querySelector('[data-testid="assistant-name-edit"]')!);
  const name = harness.container.querySelector<HTMLInputElement>('[data-testid="assistant-name-input"]')!;
  await userEvent.fill(name, '保留这份草稿');
  await userEvent.keyboard('{Enter}');
  await until('rename failure cause is visible', () => harness.container.querySelector('[role="alert"]')?.textContent === 'fixture rename rejected');
  expect(name.value).toBe('保留这份草稿');
  expect(update).toHaveBeenCalledExactlyOnceWith('assistant-content', { name: '保留这份草稿' });
});

it('phone composition retains its original card boundary and full-width rows', async () => {
  harness.container.style.width = '412px';
  await renderWithAppProviders(harness, <Frame mobile><AssistantSection available={['devices']} onOpenSection={vi.fn()} /></Frame>, { auth: user });
  const card = harness.container.querySelector<HTMLElement>('.gg-settings-card')!;
  expect(getComputedStyle(card).borderWidth).toBe('1px');
  expect(card.getBoundingClientRect().width).toBeGreaterThan(300);
});

it('title rename requires double click or pencil, cancels without closing settings and submits once after IME', async () => {
  let finish!: () => void;
  const update = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const outerEscape = vi.fn();
  await renderWithAppProviders(harness, <div style={{ display: 'contents' }} onKeyDown={(event) => { if (event.key === 'Escape') outerEscape(); }}><Frame><AssistantSection available={[]} onOpenSection={vi.fn()} /></Frame></div>, { auth: user, contacts: { updateAgentProfile: update } });
  await userEvent.click(harness.container.querySelector('[data-testid="assistant-name-display"]')!);
  expect(harness.container.querySelector('input')).toBeNull();
  await userEvent.dblClick(harness.container.querySelector('[data-testid="assistant-name-display"]')!);
  let input = harness.container.querySelector<HTMLInputElement>('[data-testid="assistant-name-input"]')!;
  await userEvent.fill(input, '不保存');
  await userEvent.keyboard('{Escape}');
  expect(update).not.toHaveBeenCalled();
  expect(outerEscape).not.toHaveBeenCalled();
  expect(harness.container.querySelector('input')).toBeNull();
  await userEvent.click(harness.container.querySelector('[data-testid="assistant-name-edit"]')!);
  input = harness.container.querySelector<HTMLInputElement>('[data-testid="assistant-name-input"]')!;
  expect(input.value).toBe('小咕');
  await userEvent.fill(input, '取消按钮草稿');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect(update).not.toHaveBeenCalled();
  await userEvent.click(harness.container.querySelector('[data-testid="assistant-name-edit"]')!);
  input = harness.container.querySelector<HTMLInputElement>('[data-testid="assistant-name-input"]')!;
  await userEvent.fill(input, ' 新名字 ');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
  expect(update).not.toHaveBeenCalled();
  await userEvent.keyboard('{Enter}{Enter}');
  expect(update).toHaveBeenCalledExactlyOnceWith('assistant-content', { name: '新名字' });
  expect(input.readOnly).toBe(true);
  finish();
  await until('successful rename leaves edit mode', () => harness.container.querySelector('[data-testid="assistant-name-input"]') === null);
});
