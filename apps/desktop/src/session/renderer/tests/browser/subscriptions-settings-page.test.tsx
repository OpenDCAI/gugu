/**
 * 设置「订阅」页(product spec)在设置弹窗里 —— 会话页那棵树**外面** —— 真画出一行。
 *
 * 逐格那条(session-settings-content.test.tsx)只判「这一格提交了渲染」:那里宿主永远不回话，订阅页一行都画不出来，
 * 行里要用的东西缺了它也看不见。2026-10-13 真机实撞:行头的 harness 图标经会话页的 ThemeContext 读主题，
 * 弹窗里没有 ThemeProvider,一打开「订阅」整个壳落进「这个界面出错了」。这里让宿主答一家 agent 与它的两份读数，
 * 钉住「行与自动读取的用量条都画得出来」。
 */
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition';
import { SessionSettingsContent } from '@renderer/features/settings/components/SettingsPage';
import { queryClient } from '@renderer/lib/query-client';
import type { HarnessConnection } from '@gugu/session-core/workspace-server/agent-config';
import '@/styles/tokens.css';
import '@renderer/index.css';

const CLAUDE = { id: 'claude', name: 'Claude Code', reading: 'installed', capabilities: { auth: { kind: 'supported', methods: [{ kind: 'cli-login', id: 'claude-login', name: 'Claude', args: ['auth', 'login'] }] } } };
// 有图标才会画到真正读主题的那一层(没图标时 AppIcon 只画一块底色)。
const ICONS = {
  claude: { kind: 'svg', variants: [{ minSize: 0, light: '<svg viewBox="0 0 1 1"></svg>' }], plate: { color: '#D97757', mark: 'white' } },
};

// 宿主只答「这台机器装了哪些 agent」;其余调用挂起不回(❌ 抛错 —— 抛错会落成测试之外的未处理错误)。
vi.mock('@renderer/lib/ipc', async (importOriginal) => {
  const pending = () => new Promise(() => {});
  const answers: Record<string, () => Promise<unknown>> = {
    listManagement: async () => control.codex ? [CLAUDE, { id: 'codex', name: 'Codex', reading: 'installed', capabilities: CLAUDE.capabilities }] : [CLAUDE],
    listIcons: async () => ICONS,
    modelCatalog: async () => ({ state: { kind: 'ready', models: [] }, refreshing: false }),
  };
  const agents = new Proxy({}, { get: (_, key) => answers[String(key)] ?? pending });
  const namespace = new Proxy({}, { get: () => pending });
  return {
    ...(await importOriginal<object>()),
    rpc: new Proxy({}, { get: (_, key) => (key === 'agents' ? agents : namespace) }),
  };
});

// 套餐读数可以被按住不答(看「刷新」读着的时候画成什么样)。
const control = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  membershipError: false,
  held: 0,
  created: null as Record<string, unknown> | null,
  selected: '',
  connections: [] as HarnessConnection[],
  codex: false,
  rejectSelect: false,
  selectMessage: 'Switch failed',
  connectionsError: false,
}));

vi.mock('@/store/auth', () => ({ useAuth: () => ({ user: { id: 'subscription-test' } }) }));
vi.mock('@/lib/billing', () => ({
  formatCredits: (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value),
  quotaWindowViews: () => ({ period: { limit: 4, remaining: 3.2 - control.held, freesAt: new Date('2026-11-01T00:00:00Z') } }),
  getMembership: async () => {
    if (control.membershipError) throw new Error('offline');
    return { tier: 'free', expiresAt: null };
  },
  useSpendingPower: () => ({ power: { spendable: 8.2 - control.held, periodCredits: 3.2, walletCredits: 5, held: control.held },
    balanceError: null, windowsError: null, activityRevision: 0,
    windows: { plan_id: 'free', period_credits: 4, period_used: 0.8, period_started_at: '2026-10-01T00:00:00Z', period_ends_at: '2026-11-01T00:00:00Z', outstanding_credits: control.held, credits_per_usd: 1 } }),
  refreshSpendingPower: () => {},
}));
vi.mock('@renderer/lib/stores/use-agent-auth-status', () => ({
  useAgentAuthStatus: () => ({ auth: { status: { kind: 'authenticated', account: 'me@example.test' }, login: null }, refresh: async () => {} }),
  useAgentAuthStatuses: () => ({ auths: [], refresh: async () => {} }),
  useExpiredAgentIds: () => new Set(),
}));

vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async () => ({
    listConnections: async () => control.connectionsError
      ? { success: false, error: { message: 'Connections offline' } }
      : { success: true, data: [...control.connections] },
    refreshAuthStatus: async () => ({ success: true, data: { kind: 'authenticated', account: 'me@example.test' } }),
    createConnection: async (input: Record<string, unknown>) => {
      control.created = input;
      const connection: HarnessConnection = { id: 'api-1', kind: 'api-key', name: 'Saved API', endpoint: input.endpoint as string | undefined, current: false };
      control.connections.push(connection);
      return { success: true, data: connection };
    },
    selectConnection: async ({ connectionId }: { connectionId: string }) => {
      if (control.rejectSelect) return { success: false, error: { message: control.selectMessage } };
      control.selected = connectionId;
      control.connections = control.connections.map(c => ({ ...c, current: c.id === connectionId }));
      return { success: true };
    },
    readSubscription: async () => {
      if (control.hold) await control.hold;
      return { success: true, data: { payer: 'subscription', plan: 'Claude Max 20x' } };
    },
    readSubscriptionUsage: async () => ({
      success: true,
      data: {
        kind: 'windows',
        onDemand: true,
        readAt: Date.now(),
        windows: [
          { windowMinutes: 300, usedPercent: 18, resetsAt: Date.now() + 3_600_000 },
          { windowMinutes: 10_080, group: 'Fable', usedPercent: 92 },
        ],
      },
    }),
  }),
}));

let root: Root;
let host: HTMLDivElement;
let layer: HTMLDivElement;
const thrown: unknown[] = [];
const onError = (event: ErrorEvent) => thrown.push(event.error);

beforeEach(() => {
  queryClient.clear();
  control.hold = null;
  control.membershipError = false;
  control.held = 0;
  control.created = null;
  control.selected = '';
  control.codex = false;
  control.rejectSelect = false;
  control.selectMessage = 'Switch failed';
  control.connectionsError = false;
  control.connections = [{ id: 'native', kind: 'native', name: '', current: true }];
  host = document.createElement('div');
  layer = document.createElement('div');
  for (const el of [host, layer]) {
    el.className = 'gugu-skin emlight';
    document.body.append(el);
  }
  root = createRoot(host, { onUncaughtError: (error) => thrown.push(error) });
  thrown.length = 0;
  window.addEventListener('error', onError);
});

afterEach(() => {
  window.removeEventListener('error', onError);
  root.unmount();
  host.remove();
  layer.remove();
});

it('draws a harness row with its plan, both quota windows without an extra query button outside the task page tree', async () => {
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the Claude row shows its usage (or the tree threw)', () =>
    thrown.length > 0 || host.querySelector('[data-testid="subscription-usage-claude"]') !== null
  );
  expect(thrown).toEqual([]);
  // 图标那一层真画出来了(否则这条判不出 2026-10-13 那次的「缺主题 context」)。
  await until('the harness mark is drawn', () => host.querySelector('[data-testid="app-icon"] svg') !== null);
  const row = host.querySelector('[data-testid="subscription-row-claude"]') as HTMLElement;
  expect(row.textContent).toContain('Claude Max 20x');
  expect(row.querySelectorAll('[role="meter"]')).toHaveLength(2);
  expect(row.querySelector('[data-testid="subscription-check-now-claude"]')).toBeNull();
});

it('「刷新」读着的时候按不动、读完回来 —— 跟着读数变，不是只在列表碰巧重画时才变', async () => {
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the Claude row shows its usage', () => host.querySelector('[data-testid="subscription-usage-claude"]') !== null);
  const refresh = () => host.querySelector('[data-testid="subscriptions-refresh"]') as HTMLButtonElement;
  await until('the first reads settle', () => refresh().disabled, (disabled) => !disabled);

  let release!: () => void;
  control.hold = new Promise<void>((resolve) => (release = resolve));
  refresh().click();
  await until('「刷新」 shows it is reading', () => refresh().disabled);
  control.hold = null;
  release();
  await until('「刷新」 comes back once the read is in', () => refresh().disabled, (disabled) => !disabled);
  expect(thrown).toEqual([]);
});


it('Gugu Free shares the same collection and membership errors are never shown as Free', async () => {
  control.membershipError = true;
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('membership error is visible', () => host.querySelector('[data-testid="subscription-row-gugu"]')?.textContent?.includes('offline') === true);
  const gugu = host.querySelector('[data-testid="subscription-row-gugu"]')!;
  expect(gugu.querySelector('.subscription-plan-badge')).toBeNull();
  expect(gugu.parentElement).toBe(host.querySelector('[data-testid="subscription-row-claude"]')?.parentElement);
  expect(thrown).toEqual([]);
});

it('adds a third-party API and explicitly switches the connection without opening Agent creation', async () => {
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('manage connection action is ready', () => host.querySelector('[data-testid="subscription-switch-claude"]') !== null);
  (host.querySelector('[data-testid="subscription-switch-claude"]') as HTMLButtonElement).click();
  await until('connection manager is visible', () => layer.querySelector('[data-testid="subscription-add-connection"]') !== null);
  (layer.querySelector('[data-testid="subscription-add-connection"]') as HTMLButtonElement).click();
  await until('connection method choices are visible', () => [...layer.querySelectorAll('button')].some(b => b.textContent === 'API Key'));
  ([...layer.querySelectorAll('button')].find(b => b.textContent === 'API Key') as HTMLButtonElement).click();
  await until('API form is visible', () => layer.querySelector('input[name="apiKey"]') !== null);
  await until('the switch menu closes when adding', () => layer.querySelector('[role="menu"]') === null);
  expect(layer.querySelector('input[name="endpoint"]')).toBeNull();
  (layer.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
  await until('third-party endpoint is exposed', () => layer.querySelector('input[name="endpoint"]') !== null);
  (layer.querySelector('input[name="apiKey"]') as HTMLInputElement).value = 'test-api-key';
  (layer.querySelector('input[name="endpoint"]') as HTMLInputElement).value = 'https://gateway.example/v1';
  (layer.querySelector('form') as HTMLFormElement).requestSubmit();
  await until('saved connection appears', () => layer.querySelector('[data-testid="connection-api-1"]') !== null);
  expect(control.created).toMatchObject({ providerId: 'claude', kind: 'api-key', apiKey: 'test-api-key', endpoint: 'https://gateway.example/v1' });
  expect(control.selected).toBe('');
  await until('connection can be selected', () => layer.querySelector('[data-testid="connection-use-api-1"]')?.hasAttribute('data-disabled'), disabled => disabled === false);
  (layer.querySelector('[data-testid="connection-use-api-1"]') as HTMLButtonElement).click();
  await until('the selected connection is acknowledged', () => control.selected === 'api-1');
  expect(control.selected).toBe('api-1');
  expect(layer.textContent).not.toContain('test-api-key');
  expect(thrown).toEqual([]);
});


it('explains reserved credits when the available total differs from the two balances', async () => {
  control.held = 1;
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the reservation is shown', () => /预留|reserved/.test(host.querySelector('[data-testid="subscription-row-gugu"]')?.textContent ?? ''));
  expect(host.querySelector('[data-testid="subscription-row-gugu"]')?.textContent).toContain('7.2');
});

it('Codex shows both the five-hour and weekly windows directly on opening subscriptions', async () => {
  control.codex = true;
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('Codex quota is visible without any click', () => host.querySelector('[data-testid="subscription-usage-codex"]') !== null);
  const row = host.querySelector('[data-testid="subscription-row-codex"]')!;
  expect(row.querySelector('[role="meter"][aria-label="5 小时"], [role="meter"][aria-label="5 hours"]')).not.toBeNull();
  expect(row.querySelectorAll('[role="meter"]')).toHaveLength(2);
  expect(row.querySelector('[data-testid="subscription-check-now-codex"]')).toBeNull();
  expect(thrown).toEqual([]);
});

it('a failed connection read shows its failure instead of staying in the loading state', async () => {
  control.connectionsError = true;
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the row shows the connection error', () => host.querySelector('[data-testid="subscription-row-claude"]')?.textContent?.includes('Connections offline') === true);
  expect(host.querySelector('[data-testid="subscription-row-claude"]')?.textContent).not.toMatch(/正在读|Reading[.…]|Checking/);
});

it('a failed dropdown switch keeps the previous current connection', async () => {
  control.rejectSelect = true;
  control.connections.push({ id: 'saved-api', kind: 'api-key', name: 'Saved API', current: false });
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the switch is ready', () => host.querySelector('[data-testid="subscription-switch-claude"]') !== null);
  (host.querySelector('[data-testid="subscription-switch-claude"]') as HTMLButtonElement).click();
  await until('the API option can be used', () => layer.querySelector('[data-testid="connection-use-saved-api"]')?.hasAttribute('data-disabled'), disabled => disabled === false);
  expect(layer.querySelector('[role="dialog"]')).toBeNull();
  (layer.querySelector('[data-testid="connection-use-saved-api"]') as HTMLElement).click();
  await until('the switch error is displayed', () => host.textContent?.includes('Switch failed') === true);
  expect(control.connections.find(c => c.current)?.id).toBe('native');
  expect(control.selected).toBe('');
  expect(thrown).toEqual([]);
});


// 2026-10-23 真机:6 个 Codex 会话在干活时点「切换连接」,被拒的那句长提示进了最右那一列(宽度 auto),
// 按最大宽度把列撑开,中间的账号列被挤到几乎没有宽度 —— 邮箱一个字一行,提示压在标题上。
// 判据是真排版:提示出现前后账号列一样宽;提示整句落在这一行之内、在标题与账号之下。
it('a long switch refusal is shown under the row heading and does not squeeze the account column', async () => {
  control.codex = true;
  control.rejectSelect = true;
  control.selectMessage = '6 Codex sessions are still working. Switch the subscription after they finish; switching restarts every running Codex session.';
  control.connections.push({ id: 'saved-api', kind: 'api-key', name: 'Saved API', current: false });
  host.style.width = '720px';
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the Codex switch is ready', () => host.querySelector('[data-testid="subscription-switch-codex"]') !== null);
  const row = host.querySelector('[data-testid="subscription-row-codex"]') as HTMLElement;
  const identity = row.querySelector('.subscription-service-identity') as HTMLElement;
  await until('the account line is drawn', () => (identity.textContent ?? '').includes('me@example.test'));
  // 连接数读回来之后右列的文案才定下来(「当前设备」→「当前设备 · 2 个连接」),账号列的宽度跟着变;等它稳了再量。
  await until('the connection count is shown', () => row.querySelector('.subscription-scope')?.textContent?.includes('2') === true);
  await untilStable('the account column settles', () => Math.round(identity.getBoundingClientRect().width));
  const widthBefore = identity.getBoundingClientRect().width;
  expect(widthBefore).toBeGreaterThan(150);
  expect(row.querySelector('[role="alert"]')).toBeNull();

  (host.querySelector('[data-testid="subscription-switch-codex"]') as HTMLButtonElement).click();
  await until('the saved API option can be used', () => layer.querySelector('[data-testid="connection-use-saved-api"]')?.hasAttribute('data-disabled'), disabled => disabled === false);
  (layer.querySelector('[data-testid="connection-use-saved-api"]') as HTMLElement).click();
  await until('the refusal is displayed', () => row.textContent?.includes('6 Codex sessions are still working') === true);

  const alert = row.querySelector('[role="alert"]') as HTMLElement;
  const card = row.getBoundingClientRect();
  const heading = row.querySelector('.subscription-service-heading')!.getBoundingClientRect();
  const message = alert.getBoundingClientRect();
  expect(identity.getBoundingClientRect().width).toBeCloseTo(widthBefore, 0);
  expect(message.top).toBeGreaterThanOrEqual(heading.bottom - 0.5);
  expect(message.left).toBeGreaterThanOrEqual(card.left);
  expect(message.right).toBeLessThanOrEqual(card.right + 0.5);
  expect(control.connections.find(c => c.current)?.id).toBe('native');

  // 下一次动作一开始,上一次的原因就撤掉;这次成功了,行里不再留着旧的拒绝。
  control.rejectSelect = false;
  if (!layer.querySelector('[data-testid="connection-use-saved-api"]')) (host.querySelector('[data-testid="subscription-switch-codex"]') as HTMLButtonElement).click();
  await until('the saved API option can be used again', () => layer.querySelector('[data-testid="connection-use-saved-api"]')?.hasAttribute('data-disabled'), disabled => disabled === false);
  (layer.querySelector('[data-testid="connection-use-saved-api"]') as HTMLElement).click();
  await until('the refusal is gone once a switch goes through', () => row.querySelector('[role="alert"]') === null);
  expect(control.selected).toBe('saved-api');
  expect(thrown).toEqual([]);
});

it.each([
  { provider: 'claude', kind: 'native' as const }, { provider: 'codex', kind: 'native' as const },
  { provider: 'claude', kind: 'account' as const }, { provider: 'codex', kind: 'account' as const },
])('an authenticated $provider $kind connection has no login or reauthorization action', async ({ provider, kind }) => {
  control.codex = true;
  control.connections = [{ id: 'existing', kind, name: 'Existing account', current: true }];
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the switch is ready', () => host.querySelector(`[data-testid="subscription-switch-${provider}"]`) !== null);
  (host.querySelector(`[data-testid="subscription-switch-${provider}"]`) as HTMLButtonElement).click();
  await until('the account has been read', () => layer.querySelector('[data-testid="connection-existing"]')?.textContent?.includes('me@example.test') === true);
  const existing = layer.querySelector('[data-testid="connection-existing"]')!;
  expect(existing.querySelector('[aria-haspopup="menu"]')).toBeNull();
  expect(layer.querySelector('[data-testid="subscription-add-connection"]')).not.toBeNull();
  expect(thrown).toEqual([]);
});
