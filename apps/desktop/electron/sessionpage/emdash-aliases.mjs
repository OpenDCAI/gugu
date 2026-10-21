// @@@sessionpage — single source of truth for the app-internal module aliases + worker build inputs,
// consumed by vite.config.mts (renderer alias table AND the electron-main lib entries), vitest, the
// release reachability gate and the storybook configs. It must agree with tsconfig.json `paths`:
// builds read this side, the typecheck reads that one (tsconfig.json is read with JSON.parse, so the
// comment lives here).
//
// The workspace packages (`@gugu/session-*`) are not aliased: the root package.json depends on each
// with workspace:*, so every importer resolves them through node_modules and the package's own
// `exports` — the same map tsc reads. A second copy here could only drift (B2, 10-17).
//
// ORDER IS LOAD-BEARING: entries are matched top-to-bottom with @rollup/plugin-alias semantics
// (`import === key || import.startsWith(key + '/')`); `@` stays last.
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
// sessionpage/ -> electron/ -> desktop/ -> apps/ -> <repo root>
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
// @@@task-fusion — 会话页代码布局:渲染层在 apps/desktop/src/session,
// 主进程在 apps/desktop/electron/session,包在 packages/session-*。
const SESSION_RENDERER_ROOT = `${ROOT}apps/desktop/src/session`
const SESSION_MAIN_ROOT = `${ROOT}apps/desktop/electron/session`
const PKGS = `${ROOT}packages`

void HERE

/** @type {Array<[string, string]>} ordered [aliasKey, absoluteTarget] */
export const emdashAliasEntries = [
  // --- @gugu/core: the session packages import the Gugu core too (same target as tsconfig paths) ---
  ['@gugu/core', `${PKGS}/core/src`],
  // --- app-internal directory aliases (prefix targets) ---
  ['@main', `${SESSION_MAIN_ROOT}/main`],
  ['@shared', `${SESSION_RENDERER_ROOT}/shared`],
  ['@renderer', `${SESSION_RENDERER_ROOT}/renderer`],
  ['@root', SESSION_MAIN_ROOT],
  ['@tooling', `${ROOT}apps/desktop/session-tooling`],
  // NOTE: `@` (→ the session renderer `src`) is intentionally LAST. It only matches `@/...` (not `@main`,
  // `@shared`, or `@emdash/...`, whose next char is not `/`), so ordering after them is safe.
  // @@@task-fusion — 两个 UI 包的包内别名(原 @/ @react/ @styles/ @theme/ 与
  // @components/ @core/ @lib/ @state/ @styles/)彼此撞名、也与咕咕的 '@' 撞名,
  // 统一成唯一前缀。
  ['@session-ui', `${PKGS}/session-ui/src`],
  ['@session-chat', `${PKGS}/session-chat-ui/src`],
  ['@session-assets', `${SESSION_RENDERER_ROOT}/assets`],
  ['@session-types', `${SESSION_RENDERER_ROOT}/types`],
]

// Worker utility entries spawned by `child_process.fork` at runtime — each is an entry of the
// electron-main lib build (vite.config.mts), so it lands as its own file. `out` names MUST equal
// worker-manifest.ts `desktopWorkers[].file` (minus `.js`), because desktopWorkerPath resolves
// `new URL('./<out>.js', import.meta.url)` relative to whichever chunk the manifest lands in — all
// chunks are flat in dist-electron/, so the sibling lookup holds regardless of chunking.
export const emdashWorkerEntries = [
  { out: 'acp-runtime', src: `${SESSION_MAIN_ROOT}/main/core/acp/runtime-process/entry.ts` },
  { out: 'agent-config-runtime', src: `${SESSION_MAIN_ROOT}/main/core/agent-config/runtime-process/entry.ts` },
  { out: 'fs-watch-runtime', src: `${SESSION_MAIN_ROOT}/main/core/fs-watch/runtime-process/entry.ts` },
  // #6334 用量页 token 扫描 —— worker_threads 线程的入口(不是 fork),同样必须是磁盘上的独立文件。
  { out: 'usage-token-scan', src: `${SESSION_MAIN_ROOT}/main/core/usage/token-scan-worker/entry.ts` },
]

