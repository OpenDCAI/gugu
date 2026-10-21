import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 手机经宿主改会话选项,与会话页 composer 同一条纪律:provider 确认 `applied` 之后写回记录,
 * 否则下次重开按建会话时那一档重新下发。模型一维只在计费路判得出时写。
 */

const mocks = vi.hoisted(() => ({
  record: vi.fn(async () => {}),
  recordModel: vi.fn(async () => {}),
  platform: vi.fn(async (): Promise<{ modelId: string } | null | undefined> => undefined),
}));

vi.mock('@main/core/acp/runtime-process/host', () => ({ peekAcpRuntimeClient: async () => null }));
vi.mock('@main/core/sessions/record-live-session-setting', () => ({
  recordLiveSessionSetting: mocks.record,
}));
vi.mock('@main/core/sessions/live-model-switch', () => ({
  recordLiveModelSwitch: mocks.recordModel,
}));
vi.mock('@main/core/sessions/platform-model-selection', () => ({
  sessionPlatformModel: mocks.platform,
}));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { setSessionOption, setSessionOptionsIo } = await import('./live-options');

const CONFIG = {
  modeOptions: { selected: 'bypassPermissions', available: [{ id: 'default', name: 'Default' }, { id: 'bypassPermissions', name: 'Bypass' }] },
  modelOptions: { selected: 'opus', available: [{ id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'Sonnet' }, { id: 'gugu-platform/glm-5', name: 'GLM' }, { id: 'gugu-platform\\glm-5', name: 'GLM (ZCode)' }, { id: 'glm-5[1m]', name: 'GLM 1M (Claude)' }, { id: 'glm-5', name: 'GLM bare' }] },
  efforts: { selected: 'high', available: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }] },
};

function useIo(data: { status: string; effectiveValue?: string } | undefined, success = true) {
  setSessionOptionsIo({
    readConfig: async () => CONFIG as never,
    apply: async () => ({ success, ...(data ? { data } : {}), ...(success ? {} : { error: { type: 'x' } }) }),
  });
}

beforeEach(() => {
  mocks.record.mockClear();
  mocks.recordModel.mockClear();
  mocks.platform.mockReset();
});
afterEach(() => setSessionOptionsIo(null));

describe('手机改选项:确认生效才写回记录', () => {
  it('权限档 applied ⇒ 按确认值写', async () => {
    useIo({ status: 'applied', effectiveValue: 'default' });
    await setSessionOption({ conversationId: 'c1', dimension: 'mode', value: 'default' });
    expect(mocks.record).toHaveBeenCalledWith('c1', { dimension: 'permission', modeId: 'default' });
  });

  it('pending_next_turn ⇒ 不写', async () => {
    useIo({ status: 'pending_next_turn' });
    await setSessionOption({ conversationId: 'c1', dimension: 'mode', value: 'default' });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('推理档 applied ⇒ 写', async () => {
    useIo({ status: 'applied', effectiveValue: 'low' });
    await setSessionOption({ conversationId: 'c1', dimension: 'effort', value: 'low' });
    expect(mocks.record).toHaveBeenCalledWith('c1', { dimension: 'effort', value: 'low' });
  });

  it('模型:自家凭据会话 ⇒ 写 harness 模型', async () => {
    mocks.platform.mockResolvedValue(null);
    useIo({ status: 'applied', effectiveValue: 'sonnet' });
    await setSessionOption({ conversationId: 'c1', dimension: 'model', value: 'sonnet' });
    expect(mocks.recordModel).toHaveBeenCalledWith({ sessionId: 'c1', source: 'own', modelId: 'sonnet' });
  });

  // 第二种写法是 ZCode 的桥(providerId\modelId);第三种是 Claude Code 认 1M 窗口的后缀(改调共用解析后才认得,原来记录不动)。
  it.each(['gugu-platform/glm-5', 'gugu-platform\\glm-5', 'glm-5[1m]'])('模型:平台会话 + 带平台命名空间的值 %s ⇒ 写裸平台 id', async (wire) => {
    mocks.platform.mockResolvedValue({ modelId: 'glm-4' });
    useIo({ status: 'applied', effectiveValue: wire });
    await setSessionOption({ conversationId: 'c1', dimension: 'model', value: wire });
    expect(mocks.recordModel).toHaveBeenCalledWith({ sessionId: 'c1', source: 'platform', modelId: 'glm-5' });
  });

  it.each([
    ['没做过计费路决定', undefined],
    ['平台会话上的裸 id', { modelId: 'glm-4' }],
  ] as const)('模型:%s ⇒ 判不出计费路,不写', async (_label, decision) => {
    mocks.platform.mockResolvedValue(decision);
    useIo({ status: 'applied', effectiveValue: 'glm-5' });
    await setSessionOption({ conversationId: 'c1', dimension: 'model', value: 'glm-5' });
    expect(mocks.recordModel).not.toHaveBeenCalled();
  });
});
