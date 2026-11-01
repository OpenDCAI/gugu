import { Fragment, createRef, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat';
import { chat, contact, createNode, createReactHarness, displayIdentity, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { i18n } from '@/i18n';
import '@/i18n/registerMessagingCatalog';
import '@/i18n/registerContactsCatalog';
import '@/i18n/registerMainCatalog';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@/lib/chat', () => import('../../../../../../../tests/support/contactsChatServiceTestDouble'));
vi.mock('@/store/devicesContext', async (original) => ({ ...(await original<object>()), useDevicesStore: () => ({ devices: [], phones: [] }) }));
vi.mock('@/hooks/useAgentDisplayStatus', () => import('../../../../../../../tests/support/agentDisplayStatusTestDouble'));

const { BubbleTime } = await import('@/components/chat/MessageBubbleChrome');
const { MemberListPanel } = await import('@/components/chat/MemberListPanel');
const { ChatHeaderActions } = await import('@/components/chat/ChatHeaderActions');
const { ChatListPanel } = await import('@/components/ChatListPanel');
const { MemberPicker } = await import('@/components/member-picker/MemberPicker');

let harness: ReturnType<typeof createReactHarness>;
let previousTheme: string | null;
beforeEach(async () => {
  previousTheme = document.documentElement.getAttribute('data-theme');
  document.documentElement.setAttribute('data-theme', 'dark');
  await i18n.changeLanguage('zh-CN');
  await page.viewport(1000, 1000);
  harness = createReactHarness();
  harness.container.style.cssText = 'width:800px;height:800px;display:flex;background:var(--bg);color:var(--fg)';
});
afterEach(() => {
  harness.cleanup();
  if (previousTheme === null) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', previousTheme);
});

// Chromium resolves CSS colours (including color-mix); a canvas composites their alpha.
// Reject image/opacity surfaces rather than treating an unsupported background as black.
function contrast(element: HTMLElement, foreground = getComputedStyle(element).color) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const ancestors: HTMLElement[] = [];
  for (let node: HTMLElement | null = element; node; node = node.parentElement) ancestors.push(node);
  for (const ancestor of ancestors.reverse()) {
    const style = getComputedStyle(ancestor);
    expect(style.backgroundImage, 'contrast fixture must use solid surfaces').toBe('none');
    expect(Number(style.opacity), 'contrast fixture must not hide text with opacity').toBe(1);
    context.fillStyle = style.backgroundColor;
    context.fillRect(0, 0, 1, 1);
  }
  const background = context.getImageData(0, 0, 1, 1).data;
  expect(background[3], 'a real opaque background must have painted').toBe(255);
  context.fillStyle = foreground;
  context.fillRect(0, 0, 1, 1);
  const paintedText = context.getImageData(0, 0, 1, 1).data;
  const luminance = (pixel: Uint8ClampedArray) => [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
    const channel = pixel[index] / 255;
    return sum + weight * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  }, 0);
  const a = luminance(background), b = luminance(paintedText);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function token(name: string) {
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  harness.container.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

async function readable(selector: string) {
  const elements = [...harness.container.querySelectorAll<HTMLElement>(selector)];
  expect(elements.length, `missing actual metadata: ${selector}`).toBeGreaterThan(0);
  for (const element of elements) {
    await until(`metadata is painted: ${selector}`, () => {
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        if (Number(getComputedStyle(node).opacity) !== 1) return false;
      }
      return element.getBoundingClientRect().height > 0;
    });
    expect(element.textContent?.trim(), selector).toBeTruthy();
    expect(element.getBoundingClientRect().height, selector).toBeGreaterThan(0);
    expect(getComputedStyle(element).visibility, selector).toBe('visible');
    // This also catches a missing Tailwind rule inheriting the brighter body colour.
    expect(getComputedStyle(element).color, selector).toBe(token('--muted-fg'));
    expect(contrast(element), selector).toBeGreaterThanOrEqual(4.5);
    expect(contrast(element, token('--faint-fg')), `faint negative control: ${selector}`).toBeLessThan(4.5);
  }
}

describe('dark informational text contrast (#916)', () => {
  it('keeps received bubble timestamps readable on their bubble surface', async () => {
    harness.container.style.background = 'var(--bubble-other)';
    await harness.render(createNode(BubbleTime, { iso: '2026-10-29T10:00:00Z', isMine: false, inline: true }));
    await readable('[data-message-time]');
    expect(getComputedStyle(harness.container.querySelector('[data-message-time]')!).fontSize).toBe('12px');
  });

  it('keeps member roles, section counts, model metadata and listening modes readable', async () => {
    const snapshot: GroupCollabSnapshot = {
      scheduler: { chat_id: 'group', paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: '2026-10-29T10:00:00Z' },
      humans: [{ id: 'owner', role: 'owner', type: 'human', account_status: null }],
      agents: [{ id: 'helper', role: 'member', type: 'agent', account_status: 'active', client: 'Codex', model_source: 'Test model', tools: [], permission_scope: null, current_task_id: null, current_task_title: null, last_action: null, last_active_at: null, listen_mode: 'active' }],
      tasks: [],
    };
    await renderWithAppProviders(harness, createNode(MemberListPanel, {
      chatId: 'group', chatKind: 'group', snapshot, onReload: vi.fn(async () => {}),
      head: (title: ReactNode, actions: ReactNode) => createNode(Fragment, null, title, actions),
    }), { auth: { id: 'owner' }, contacts: { contacts: [] }, chat: { identitiesById: {
      owner: displayIdentity('owner', { display_name: 'Owner' }),
      helper: displayIdentity('helper', { type: 'agent', display_name: 'Helper', owner_user_id: 'owner' }),
    } } });
    await readable('[data-member-role="owner"]');
    await readable('[data-member-section="human"] > div:first-child > span');
    await readable('[data-agent-meta="model"]');
    await readable('[data-listen-mode-toggle]');
  });

  it('gives the header member count a text colour without brightening its icon', async () => {
    await renderWithAppProviders(harness, createNode(ChatHeaderActions, {
      isGroupChat: false, isRoomChat: true, searchMode: false, folderShown: false,
      infoShown: false, showHeaderMenu: false, memberCount: 4, moreButtonRef: createRef<HTMLButtonElement>(),
      onEnterSearchMode: vi.fn(), onOpenFolder: vi.fn(), onCloseWorkspacePanel: vi.fn(),
      onOpenInfo: vi.fn(), onCloseInfo: vi.fn(), onToggleHeaderMenu: vi.fn(), onCloseHeaderMenu: vi.fn(),
    }));
    await readable('[data-member-count]');
    const icon = harness.container.querySelector('[data-member-count]')!.parentElement!.querySelector('svg')!;
    expect(getComputedStyle(icon).color).toBe(token('--faint-fg'));
  });

  it('keeps the folded-topic count readable in the actual chat list', async () => {
    await renderWithAppProviders(harness, createNode(ChatListPanel, { activeTab: 'chats' }), { chat: {
      activeChatId: 'group', chats: [
        chat({ id: 'group', kind: 'group', name: 'Group' }),
        chat({ id: 'old-topic', kind: 'topic', source_chat_id: 'group', name: 'Old topic', last_message_at: '2020-01-01T00:00:00Z', unread_count: 0 }),
      ],
    } });
    await readable('[data-testid="topic-sunk-section"]');
  });

  it('keeps new-group source counts readable on the picker surface', async () => {
    await renderWithAppProviders(harness, createNode(MemberPicker, {
      title: 'Add', confirmLabel: (count: number) => `Add ${count}`, onConfirm: vi.fn(), onClose: vi.fn(),
    }), { auth: { id: 'owner' }, chat: { chats: [] }, contacts: { contacts: [contact({ id: 'alice', display_name: 'Alice' })] } });
    await readable('[data-picker-source] > span:last-child');
  });
});
