/**
 * #6186:咕咕起的会话里 harness 一律不自更新。七家的关闭通道都声明在 descriptor 的 `selfUpdate` 上,
 * 宿主只经 `harnessSelfUpdateLaunch` 读它。
 *
 * 这里读的是 registry 里**解析过**的 descriptor(`definePlugin` 存 zod 的 `parsed.data`),
 * 所以 schema 里漏了这一格会在第一条当场红 —— 而不是源码里写着、运行时读到 undefined。
 */
import { describe, expect, it } from 'vitest';
import { harnessSelfUpdateLaunch, hasCitedEvidence } from '@gugu/session-core/agents/plugins';
import { pluginRegistry } from '../registry';

const EXPECTED = {
  claude: { env: { DISABLE_AUTOUPDATER: '1' }, args: [] },
  codex: { env: {}, args: ['-c', 'check_for_update_on_startup=false'] },
  copilot: { env: { COPILOT_AUTO_UPDATE: 'false' }, args: [] },
  mimocode: { env: { MIMOCODE_DISABLE_AUTOUPDATE: '1' }, args: [] },
  opencode: { env: { OPENCODE_DISABLE_AUTOUPDATE: '1' }, args: [] },
  pi: { env: { PI_SKIP_VERSION_CHECK: '1' }, args: [] },
  qwen: { env: { QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true' }, args: [] },
} as const;

describe('harness self-update is switched off per session (#6186)', () => {
  it.each(Object.entries(EXPECTED))('%s declares its session-level channel', (id, expected) => {
    const descriptor = pluginRegistry.get(id)!.capabilities.sessionBundle;
    expect(descriptor.selfUpdate, `${id} 的 selfUpdate 被 schema 剥掉或没声明`).toBeDefined();
    expect(harnessSelfUpdateLaunch(descriptor)).toEqual(expected);
    expect(hasCitedEvidence(descriptor.selfUpdate!.evidence)).toBe(true);
  });

  it('an undeclared harness gets nothing applied', () => {
    expect(harnessSelfUpdateLaunch({})).toEqual({ env: {}, args: [] });
    expect(harnessSelfUpdateLaunch({ selfUpdate: { kind: 'upstream-blocked', evidence: 'https://x.test' } }))
      .toEqual({ env: {}, args: [] });
  });
});
