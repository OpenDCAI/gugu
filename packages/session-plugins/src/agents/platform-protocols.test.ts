import { describe, expect, it } from 'vitest';
import { P0_FAMILIES, pluginRegistry } from './registry';
import { PLATFORM_DECLARATIONS } from './platform-protocols';

describe('platform-protocols', () => {
  it('浏览器那份清单与注册表逐家相同', () => {
    const fromRegistry = Object.fromEntries(
      pluginRegistry
        .getAll()
        .filter((plugin) => plugin.capabilities.sessionBundle.platform.kind === 'supported')
        .map((plugin) => [plugin.metadata.id, plugin.capabilities.sessionBundle.platform]),
    );
    expect(Object.keys(PLATFORM_DECLARATIONS).sort()).toEqual(Object.keys(fromRegistry).sort());
    for (const [id, declaration] of Object.entries(PLATFORM_DECLARATIONS)) {
      // 注册时过一遍 zod,对象被复制过 ⇒ 比内容。
      expect(fromRegistry[id], id).toEqual(declaration);
    }
  });

  // 从前是 apps/desktop/electron/engine-dimension-completeness.ts 的编译期断言(P0 ⊆ PlatformEngineId):
  // P0 的每一家都必须能用咕咕的平台模型 —— 那正是「接入」对用户的意义。
  it('P0 的每一家都声明了平台模型', () => {
    for (const id of P0_FAMILIES) {
      expect(pluginRegistry.get(id)?.capabilities.sessionBundle.platform.kind, id).toBe('supported');
    }
  });
});
