import { beforeEach, describe, expect, it, vi } from 'vitest';

// #7103 评审 r4:起任务失败的分层挂在 RPC 口上(controller 的 hydrateSession)。这里判的是接线 ——
// 拆掉那一层,咕咕自己的错就会带着原文交回渲染层,下面两条都会红。
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@main/core/agent-hooks/agent-hook-service', () => ({ agentHookService: { emitAgentEvent: vi.fn() } }));
vi.mock('@main/core/agent-hooks/app-focus', () => ({ isAppFocused: () => false }));

const hydrate = vi.fn();
vi.mock('./hydrateSession', () => ({ hydrateSession: (...args: unknown[]) => hydrate(...args) }));
vi.mock('./archiveSession', () => ({ archiveSession: vi.fn(), restoreSession: vi.fn() }));
vi.mock('./dehydrateSession', () => ({ dehydrateSession: vi.fn() }));
vi.mock('./getSessions', () => ({ getSessions: vi.fn() }));
vi.mock('./getSessionsForProject', () => ({ getSessionsForProject: vi.fn() }));
vi.mock('./getUnarchivedSession', () => ({ getUnarchivedSession: vi.fn() }));
vi.mock('./convert-automation-session', () => ({ convertAutomationSession: vi.fn() }));
vi.mock('./fork-session', () => ({ forkSession: vi.fn() }));
vi.mock('./session-turn-store', () => ({ getStoredHistory: vi.fn() }));
vi.mock('./markSessionSeen', () => ({ markSessionSeen: vi.fn() }));
vi.mock('./renameSession', () => ({ renameSession: vi.fn() }));
vi.mock('./restart-session', () => ({ restartSession: vi.fn() }));
vi.mock('./setSessionPinned', () => ({ setSessionPinned: vi.fn() }));
vi.mock('./switch-session-runtime', () => ({ switchSessionRuntime: vi.fn() }));
vi.mock('./sendMessage', () => ({ sendMessage: vi.fn() }));
vi.mock('./platform-recovery-gate', () => ({ ensurePlatformSessionReady: vi.fn() }));
vi.mock('./record-live-session-setting', () => ({ recordLiveSessionSetting: vi.fn() }));
vi.mock('./live-model-switch', () => ({ recordLiveModelSwitch: vi.fn() }));

import { HarnessStartupError } from '@gugu/session-core/agents/plugins';
import { sessionController } from './controller';

const failureOf = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);

describe('sessionController.hydrateSession —— 起任务失败到界面之前按层分', () => {
  beforeEach(() => hydrate.mockReset());

  it('咕咕自己的错(推理进程的传输超时)只交原因码,原文挂在 cause 上', async () => {
    const timeout = new Error('request timed out: POST /session');
    hydrate.mockRejectedValueOnce(timeout);
    const told = await failureOf(sessionController.hydrateSession('project-1', 'session-1'));
    // Electron 按 toString() 回传:渲染层拿到的就是这一句。
    expect(String(told)).toBe('Error: gugu-models:service-unavailable');
    expect((told as Error).cause).toBe(timeout);
  });

  it('harness 自己说的递那一句,交出去的是普通 Error(类名不上屏)', async () => {
    hydrate.mockRejectedValueOnce(new HarnessStartupError('claude not installed: harness "claude" was not found'));
    const told = await failureOf(sessionController.hydrateSession('project-1', 'session-1'));
    expect(String(told)).toBe('Error: claude not installed: harness "claude" was not found');
  });

  it('起来了就照常返回', async () => {
    hydrate.mockResolvedValueOnce(undefined);
    await expect(sessionController.hydrateSession('project-1', 'session-1')).resolves.toBeUndefined();
  });
});
