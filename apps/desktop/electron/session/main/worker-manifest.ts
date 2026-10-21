import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUGU_MCP_STDIO_RELAY_ENTRY_ENV } from '@gugu/session-plugins/agents';

export const desktopWorkers = {
  acp: {
    entry: 'src/main/core/acp/runtime-process/entry.ts',
    file: 'acp-runtime.js',
  },
  'agent-config': {
    entry: 'src/main/core/agent-config/runtime-process/entry.ts',
    file: 'agent-config-runtime.js',
  },
  'fs-watch': {
    entry: 'src/main/core/fs-watch/runtime-process/entry.ts',
    file: 'fs-watch-runtime.js',
  },
  // #6334 用量页的 token 扫描。与上面三个不同:它是 worker_threads 线程(纯计算 + 读文件,不需要进程隔离),
  // 不是 fork 子进程;但构建形态一样 —— 同一次 lib 构建的平铺入口,按本 chunk 同目录解析。
  'usage-token-scan': {
    entry: 'src/main/core/usage/token-scan-worker/entry.ts',
    file: 'usage-token-scan.js',
  },
} as const;

export type DesktopWorkerId = keyof typeof desktopWorkers;

export function desktopWorkerPath(id: DesktopWorkerId): string {
  // @@@4865 ❌ 别写成 `new URL(`./${file}`, import.meta.url)`:Vite 构建会把这个形状当**资源引用**,
  // 改写成 `import.meta.glob(...)[path]` 查表 —— 而 worker 文件是构建产物不是源码,查表得 undefined,
  // 运行时 spawn 的是 dist-electron/undefined(MBP 实机:ACP worker「Runtime exited before ready」)。
  // 主进程与三个 worker 是同一次 lib 构建的入口,全部平铺在 dist-electron/,按本 chunk 所在目录拼即可。
  return join(dirname(fileURLToPath(import.meta.url)), desktopWorkers[id].file);
}

/**
 * 随应用一起构建的 ACP 桥(`acp.bridge = { kind: 'app-runtime', file }`,例如 codex 的
 * `codex-app-server-acp.mjs`)在盘上的入口:dist-electron/runtime/,与主进程和 worker 平铺在同一层的下一级。
 *
 * 只由宿主的桥解析(`core/agents/acp-bridge`)调用,结果随 `AgentRunContext.acpAdapterEntry` 递给
 * 会话、模型目录探针与登录三条路 —— 三条路同一个值,#5050 那种「探测与会话两个 adapter」在结构上不再可能。
 * (从前靠 `GUGU_CODEX_APP_SERVER_ACP_ENTRY` 这个进程级环境变量在两处各登记一次,#6394 起删掉。)
 */
export function appRuntimeEntryPath(file: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'runtime', file);
}

/**
 * 咕咕 MCP 的 stdio ⇄ HTTP 中继(`runtime/gugu-mcp-stdio-relay.mjs`,#6335)的入口 —— 与上面那座桥同一个落点
 * (dist-electron/runtime/,由 vite.config.mts 的 `gugu-bundle-local-harness-adapters` 用 esbuild 打成单文件)。
 * 消费者是 Antigravity 终端腿的物化器:它把「用哪个程序跑中继」写进托管的全局 `mcp_config.json`
 * (理由见中继抬头),所以这个值必须是**应用级**事实,与会话无关。
 */

export function guguMcpStdioRelayEntryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'runtime', 'gugu-mcp-stdio-relay.mjs');
}

/** 幂等,已有值不覆盖(打包产物或测试可以从外面钉死)。 */
export function registerGuguMcpStdioRelayEntry(): void {
  if (process.env[GUGU_MCP_STDIO_RELAY_ENTRY_ENV]?.trim()) return;
  process.env[GUGU_MCP_STDIO_RELAY_ENTRY_ENV] = guguMcpStdioRelayEntryPath();
}

