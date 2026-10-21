/**
 * hooks 落点考卷(#6195)—— descriptor 说 hook 住在哪,实现就得真把它放在那,而且那里不是用户 HOME。
 *
 * - `scope: 'session'`:这一家终端腿的会话物化器必须真把咕咕的 hook 条目(带 `GUGU_HOOK_PORT` 守卫)交出去,
 *   走的正是声明的那条通道 —— `session-env`:run 目录里的文件,由 env 值指过去;`session-argv`:随会话级
 *   配置覆盖一起递(argv / thread-open config),或 run 目录里的文件由 argv 指过去。
 *   说了 session 却没交付 = 宿主写入器已经不写、会话也收不到 ⇒ 状态静默失明,两边都不报错。
 *   也 ❌ 不许再挂写入器(`behavior.hooks.writeHooks`):没人调的写入器是一条随时会被接回去、写用户 HOME 的路。
 * - `scope: 'agent-home'`:只有托管独立配置根的家才有资格;否则写入器会解析回用户真 HOME。
 */
import { GUGU_HOOK_MARKER } from '@gugu/session-core/agents/plugins/helpers';
import { declaresSessionTuiLeg, type SessionMaterialization } from '@gugu/session-core/agents/plugins';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_GUGU_CAPABILITY_PACKAGE,
  CODEX_GUGU_CAPABILITY_PACKAGE,
  OPENCODE_GUGU_CAPABILITY_PACKAGE,
  PI_GUGU_CAPABILITY_PACKAGE,
  pluginRegistry,
} from '../registry';

// 宿主给每条会话都带同一组产品包(desktop `capability-bundle.ts` 的 PRODUCT_CAPABILITY_PACKAGES);这里照样带,
// 不按家挑 —— 物化器要不要、要哪个,是它自己的事。
const PRODUCT_CAPABILITY_PACKAGES = [
  CLAUDE_GUGU_CAPABILITY_PACKAGE,
  CODEX_GUGU_CAPABILITY_PACKAGE,
  OPENCODE_GUGU_CAPABILITY_PACKAGE,
  PI_GUGU_CAPABILITY_PACKAGE,
];

const GUGU_HOME = '/gugu-home-under-test';

/** 终端腿物化在哪个 surface 上:有 `tui` 就是它,app-server 那类家的终端腿挂在 `app-server` 上。 */
function materializeTuiLeg(providerId: string): SessionMaterialization {
  const provider = pluginRegistry.get(providerId)!;
  const descriptor = provider.capabilities.sessionBundle;
  if (!declaresSessionTuiLeg(descriptor)) throw new Error(`${providerId}: session hooks declared but no terminal leg`);
  const surface = descriptor.surfaces.includes('tui') ? 'tui' : 'app-server';
  const materialize = provider.behavior.sessionBundle?.materialize;
  if (!materialize) throw new Error(`${providerId}: session hooks declared but no session materializer`);
  return materialize(
    { surface, lifecycle: 'fresh', cwd: '/worktree' },
    {
      mcpServers: [],
      env: { GUGU_HOME },
      model: null,
      autonomy: null,
      promptBlocks: {},
      packages: PRODUCT_CAPABILITY_PACKAGES,
    } as never
  );
}

/** 物化产物里带着咕咕 hook 条目的那几个 run 目录文件的路径。 */
function hookCarrierPaths(m: SessionMaterialization): string[] {
  const overlays = (m.jsonOverlays ?? [])
    .filter((o) => JSON.stringify(o.patch).includes(GUGU_HOOK_MARKER))
    .map((o) => o.path);
  const artifacts = m.artifacts
    .filter((a) => a.content.includes(GUGU_HOOK_MARKER))
    .map((a) => a.path);
  return [...overlays, ...artifacts];
}

describe('hooks 落点 — descriptor vs 实现 (#6195)', () => {
  const providers = pluginRegistry.getAll();
  const sessionDelivered = providers.filter((p) => {
    const hooks = p.capabilities.hooks;
    return hooks.kind === 'config' && hooks.scope === 'session';
  });

  it('取到了声明会话级通道的家(防空转)', () => {
    expect(sessionDelivered.map((p) => p.metadata.id)).toEqual(expect.arrayContaining(['qwen', 'codex']));
  });

  it.each(sessionDelivered.map((p) => [p.metadata.id]))('%s: 会话级交付的家不挂写入器', (providerId) => {
    expect(pluginRegistry.get(providerId)!.behavior.hooks?.writeHooks).toBeUndefined();
  });

  it.each(sessionDelivered.map((p) => [p.metadata.id]))(
    '%s: 终端腿物化器经声明的通道交付 hook 条目',
    (providerId) => {
      const hooks = pluginRegistry.get(providerId)!.capabilities.hooks;
      if (hooks.kind !== 'config' || hooks.scope !== 'session') throw new Error('filtered above');
      const m = materializeTuiLeg(providerId);
      const carriers = hookCarrierPaths(m);
      for (const path of carriers) expect(path.startsWith(`${GUGU_HOME}/`), path).toBe(true);
      const pointedAt = (value: string) => carriers.some((path) => path === value || path.startsWith(`${value}/`));
      if (hooks.channel === 'session-env') {
        expect(carriers.length, 'hook 条目没有进任何 run 目录产物').toBeGreaterThan(0);
        expect(Object.values(m.env).some(pointedAt), 'env 里没有指向 hook 产物的那一条').toBe(true);
      } else {
        const inline = JSON.stringify([m.argsAppend, m.threadConfig ?? null]).includes(GUGU_HOOK_MARKER);
        expect(inline || m.argsAppend.some(pointedAt), 'argv / thread config 里没有咕咕的 hook').toBe(true);
      }
    }
  );

  it("scope 'agent-home' 只给托管独立配置根的家", () => {
    const misdeclared = providers
      .filter((p) => {
        const hooks = p.capabilities.hooks;
        return hooks.kind === 'config' && hooks.scope === 'agent-home';
      })
      .filter((p) => p.capabilities.sessionBundle.injectionMode !== 'managed-config-root')
      .map((p) => p.metadata.id);
    expect(misdeclared).toEqual([]);
  });
});
