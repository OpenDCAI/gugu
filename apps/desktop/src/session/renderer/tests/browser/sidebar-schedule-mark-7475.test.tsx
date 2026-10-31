import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import type { SessionpageScheduleDigest } from '@gugu/session-core/session-record/contract';
import type { AgentStatus } from '@shared/core/agents/agentEvents';
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation';
import { SessionRowShell } from '@renderer/features/sidebar/sidebar-session-row';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/styles/tokens.css';
import '@renderer/index.css';

// owner 10-19 C:定时那枚钟在行尾那一格。空闲时盖掉「3h」那个时间;别的状态(在跑、需要你、出错)时让位给那个状态的标志。
// owner 10-19 二改:行尾只画图标,几点 / 做什么 / 几条在 tooltip;那一格 hover 时让给置顶 / 归档,所以 tooltip 挂在 hover 层接过来的那一枚上。

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  host.className = 'gugu-skin emlight';
  host.style.width = '260px';
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  root.unmount();
  host.remove();
});

const inAnHour = (): SessionpageScheduleDigest => ({
  count: 2,
  nextAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  title: '检查 CI 结果',
  attention: null,
});

async function mount(status: AgentStatus | null, schedule: SessionpageScheduleDigest | null) {
  root.render(
    <SessionLocalizationProvider>
      <SessionRowShell
        sessionId="s-1" rowVariant="tree" depth={0} hasChildren={false} expanded={false}
        needsAttention={false} title="盯一下 CI" harness={null} presentation={status ? presentAgentStatus({ reading: { status, detail: null } }) : null}
        lastInteractedAt={new Date(Date.now() - 3 * 3600_000).toISOString()} schedule={schedule}
        doneUnread={false} isActive={false} isCursor={false} isPendingArchive={false}
        quickActions={{ isPinned: false, onSetPinned: () => {}, archiveLabel: 'Archive', onArchive: () => {} }}
        onOpen={() => {}}
      />
    </SessionLocalizationProvider>,
  );
  await until('row rendered', () => host.querySelector('[data-session-id]') != null);
}

const mark = () => host.querySelector<HTMLElement>('[data-session-schedule]');
const time = () => host.querySelector('[data-session-id] time');

it('空闲:行尾只有一枚钟,盖掉最后活动的时间;读屏读得到整句', async () => {
  await mount('idle', inAnHour());
  await until('schedule mark', () => mark() != null);
  expect(mark()!.dataset.sessionSchedule).toBe('pending');
  expect(mark()!.textContent).toBe('');
  expect(mark()!.querySelector('svg')).not.toBeNull();
  expect(time()).toBeNull();
  expect(mark()!.getAttribute('aria-label')).toContain('检查 CI 结果');
});

it('鼠标:指针进行,钟排进 hover 层置顶 / 归档的左边(不叠),停在钟上出 tooltip:下一个几点、标题、几条', async () => {
  await mount('idle', inAnHour());
  const row = host.querySelector<HTMLElement>('[data-session-id]')!;
  await userEvent.hover(row);
  const hoverMark = () => host.querySelector<HTMLElement>('[data-session-schedule-hover]');
  await until('hover mark shown', () => hoverMark() != null && getComputedStyle(hoverMark()!.parentElement!).opacity === '1');
  const clock = hoverMark()!.getBoundingClientRect();
  const pin = host.querySelector<HTMLElement>('[data-row-hover-actions] button')!.getBoundingClientRect();
  expect(clock.width).toBeGreaterThan(0);
  expect(clock.right).toBeLessThanOrEqual(pin.left);
  // 车道留够了三枚:hover 层不越过这一格的左边(滚到末尾的标题不被盖)。
  const lane = host.querySelector<HTMLElement>('[data-row-hover-actions]')!.getBoundingClientRect();
  expect(clock.left).toBeGreaterThanOrEqual(lane.left - 0.5);

  await userEvent.hover(hoverMark()!);
  await until('tooltip', () => document.querySelector('[data-testid="session-schedule-tooltip"]') != null);
  const tip = document.querySelector('[data-testid="session-schedule-tooltip"]')!.textContent!;
  expect(tip).toContain('检查 CI 结果');
  expect(tip).toMatch(/\d\d:\d\d/);
  // 几条:那一句里的条数(界面语言跟着测试的 locale,两种都认)。
  expect(tip).toMatch(/2 (个定时|scheduled)/);
});

it('阴控:没有定时就照旧是那个时间', async () => {
  await mount('idle', null);
  await until('relative time', () => time() != null);
  expect(mark()).toBeNull();
});

it.each(['working', 'needs_user', 'error'] as const)('%s:让位给状态的标志(hover 层也不多那一枚)', async (status) => {
  await mount(status, inAnHour());
  await until('row settled', () => host.querySelector('[data-row-hover-actions]') != null);
  expect(mark()).toBeNull();
  expect(host.querySelector('[data-session-schedule-hover]')).toBeNull();
});

it('最近一次没送到:空闲时是 ⚠,在跑时同样让位', async () => {
  const failing = { ...inAnHour(), attention: { kind: 'failed' as const, title: '回归汇总' } };
  await mount('idle', failing);
  await until('attention mark', () => mark()?.dataset.sessionSchedule === 'attention');
  await mount('working', failing);
  await until('yields to working', () => mark() == null);
});
