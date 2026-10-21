import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { createReactHarness, renderWithAppProviders, contact } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/i18n/registerMainCatalog';
import '@/i18n/registerMessagingCatalog';
import '@/i18n/registerContactsCatalog';
import '@/styles/tokens.css';
import '@/styles/desktop-shell.css';
import '@renderer/index.css';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@/lib/chat', () => import('../../../../../../../tests/support/contactsChatServiceTestDouble'));
vi.mock('@/hooks/useAgentDisplayStatus', () => import('../../../../../../../tests/support/agentDisplayStatusTestDouble'));
const { ContactsPanel } = await import('@/components/ContactsPanel');
let harness: ReturnType<typeof createReactHarness>;
beforeEach(async () => {
  await page.viewport(1100, 760);
  document.documentElement.dataset.theme = 'light';
  document.documentElement.dataset.platform = 'mac';
});
afterEach(() => { harness?.cleanup(); delete document.documentElement.dataset.theme; delete document.documentElement.dataset.platform; delete document.documentElement.dataset.windowMaterial; });

it('the native workspace frame preserves viewport-fixed overlays and lets workspace controls receive clicks', async () => {
  document.documentElement.dataset.windowMaterial = 'native';
  harness = createReactHarness();
  harness.container.style.cssText = 'position:fixed;inset:0;display:flex';
  const clicked = vi.fn();
  await harness.render(
    <div data-desktop-shell="" style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0 }}>
      <aside className="gg-sidebar-rail" style={{ width: 56, flexShrink: 0 }} />
      <div style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, margin: 0, borderRadius: 'var(--radius-page)', overflow: 'hidden' }}>
        <button onClick={clicked} style={{ position: 'absolute', bottom: 12, right: 12 }}>workspace action</button>
        <div data-testid="fixed-session-overlay" style={{ position: 'fixed', left: 160, top: 90, width: 360, height: 180, zIndex: 5 }}>
          <button onClick={clicked}>session action</button>
        </div>
      </div>
    </div>
  );
  const workspace = harness.container.querySelector<HTMLElement>('.gg-sidebar-rail + div')!;
  const rect = workspace.getBoundingClientRect();
  expect(rect.top).toBe(5);
  expect(rect.right).toBe(1095);
  expect(rect.bottom).toBe(755);
  const fixed = harness.container.querySelector<HTMLElement>('[data-testid="fixed-session-overlay"]')!.getBoundingClientRect();
  expect([fixed.left, fixed.top, fixed.width, fixed.height]).toEqual([160, 90, 360, 180]);
  await page.getByRole('button', { name: 'workspace action', exact: true }).click();
  await page.getByRole('button', { name: 'session action', exact: true }).click();
  expect(clicked).toHaveBeenCalledTimes(2);
});

it.each(['light', 'dark'])('real contacts selected detail keeps the same %s inset frame without full-height navigation borders', async (theme) => {
  document.documentElement.dataset.theme = theme;
  harness = createReactHarness();
  harness.container.style.cssText = 'position:fixed;inset:0;display:flex';
  await renderWithAppProviders(harness,
    <div data-desktop-shell="" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div data-shell-contacts="" style={{ flex: 1, minHeight: 0 }}>
        <ContactsPanel activeTab="contacts" mobile={false} />
      </div>
    </div>, {
      auth: { id: 'owner-1', email: 'owner@example.com', nickname: 'Owner' },
      contacts: { contacts: [contact({ id: 'alice', display_name: 'Alice' })], groupChats: [] },
      chat: { chats: [] },
    });
  const region = harness.container.querySelector<HTMLElement>('[data-shell-contacts]')!;
  const getDetail = () => region.querySelector<HTMLElement>(':scope > div > :nth-child(2)')!;
  const geometry = () => {
    const detail = getDetail();
    const a = region.getBoundingClientRect(); const b = detail.getBoundingClientRect();
    expect(b.width, 'real CSS geometry must be present').toBeGreaterThan(600);
    expect(b.top - a.top).toBeCloseTo(5);
    expect(a.bottom - b.bottom).toBeCloseTo(5);
    expect(a.right - b.right).toBeCloseTo(5);
    expect(getComputedStyle(detail).borderRadius).toBe('12px');
  };
  geometry();
  const nav = region.querySelector<HTMLElement>('[data-role="nav"]')!;
  expect(getComputedStyle(nav).borderInlineEndWidth).toBe('0px');
  expect(getComputedStyle(getDetail().querySelector('.gg-pane-header')!).borderBottomWidth).toBe('1px');
  const row = region.querySelector<HTMLElement>('[data-contact-id="alice"]')!;
  expect(row).not.toBeNull();
  // Avatar loading can change the exact accessible name (Alice Alice → Alice).
  // Match the stable contact name while still exercising the real browser click.
  await page.getByRole('button', { name: /Alice/ }).click();
  await until('real contact profile opens', () => getDetail().textContent!.includes('Alice'));
  geometry();
  expect(getDetail().querySelector('.gg-pane-title')?.textContent).toBe('Alice');
});

it('the actual empty contacts detail keeps its drag lane without drawing a blank header rule', async () => {
  harness = createReactHarness();
  harness.container.style.cssText = 'position:fixed;inset:0;display:flex';
  await renderWithAppProviders(harness,
    <div data-desktop-shell="" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div data-shell-contacts="" style={{ flex: 1, minHeight: 0 }}><ContactsPanel activeTab="contacts" mobile={false} /></div>
    </div>, { contacts: { contacts: [], groupChats: [], sharedGroupAgents: [] }, chat: { chats: [] } });
  const detail = harness.container.querySelector<HTMLElement>('[data-shell-contacts] > div > :nth-child(2)')!;
  expect(detail.getBoundingClientRect().height).toBe(750);
  const header = detail.querySelector<HTMLElement>('.gg-pane-header')!;
  expect(header.querySelector('.gg-pane-title')).toBeNull();
  expect(getComputedStyle(header).borderBottomWidth).toBe('0px');
  expect(header.getBoundingClientRect().height).toBeGreaterThan(0);
});
