import type { AcpSpawnContext } from '@gugu/session-core/agents/plugins';

/**
 * 声明了 `acp.bridge` 的家,在 `buildSpawn` 里取宿主解析好的桥入口(#6394)。
 *
 * 桥从哪来只有宿主一处在算(`AgentRunContext.acpAdapterEntry` → `ctx.adapterEntry`):随包的包、
 * 按 CLI 版本配对下载的那份、或咕咕自带的 app-runtime 桥。插件 ❌ 自己再 `require.resolve` /
 * 读环境变量 —— 那样会话、模型目录探针、登录三条路可以各自拿到不同的桥(#5050)。
 * 没拿到 = 宿主接线漏了,当场说清楚,❌ 回落到别的桥。
 */
export function requireBridgeEntry(ctx: Pick<AcpSpawnContext, 'adapterEntry'>, providerId: string): string {
  const entry = ctx.adapterEntry?.trim();
  if (!entry) {
    throw new Error(
      `${providerId} 的 ACP 桥入口没有递进来(ctx.adapterEntry 为空):`
        + '宿主应按插件的 acp.bridge 声明解析好,放进 AgentRunContext.acpAdapterEntry',
    );
  }
  return entry;
}
