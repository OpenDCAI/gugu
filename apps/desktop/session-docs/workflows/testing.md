# Testing And Validation

会话页并入本体后(#2802),它的测试与咕咕**同一套**:一份 `vitest.config.ts`、一道 lint 门、
一个类型检查器。这里只讲会话页那几个 project 的边界,通用规矩看仓库根的 CLAUDE.md。

## 本地门

从仓库根跑:

```bash
pnpm typecheck        # tsgo --noEmit(❌ 不要用裸 tsc:它编到 drizzle schema 会整进程崩)
pnpm lint             # eslint,--max-warnings 0
pnpm test:unit        # gugu / session-packages / session-main / session-chat-ui 四个 project
```

## 测试分布

- 主进程用例:与代码同目录,`apps/desktop/electron/session/main/**/*.test.ts`
- 渲染层单测:`apps/desktop/src/session/renderer/**/*.test.ts`
- 渲染层浏览器用例:`apps/desktop/src/session/renderer/tests/browser/`(真 Chromium)
- 7 个包的用例:`packages/session-*/src/**/*.test.ts`

## project 一览(根 `vitest.config.ts`)

| project | 内容 | 怎么跑 |
|---|---|---|
| `session-packages` | `packages/session-*`(chat-ui 除外) | `pnpm test:unit` |
| `session-main` | 会话页主进程 + 渲染层的 node 用例 | `pnpm test:unit` |
| `session-chat-ui` | chat-ui 的纯算术/对拍用例(Solid,node) | `pnpm test:unit` |
| `session-main-db` | 要真 SQLite 的主进程集成用例 | `pnpm session:test:db` |
| `session-migrations` | 迁移用例 | `pnpm session:test:migrations` |
| `session-fixtures` | fixture **生成器**(会写文件) | `pnpm session:db:fixtures` |
| `session-browser` | 渲染层的真浏览器用例 | `pnpm test:browser` |
| `session-chat-ui-browser` | chat-ui 的测量契约用例 + benchmark | `pnpm test:browser` |

DB / 迁移那两个要**系统 Node 编译**的 better-sqlite3(仓库根那份始终是 electron 编译的):
先跑一次 `pnpm session:db:setup`。

## 一处具名排除(#2633)

理由写在 `vitest.config.ts` 里:

- `core/pty/local-pty.integration.test.ts` —— node-pty 的 spawn-helper 在上游 tarball 里没有执行位

⚠️ 排除项一律写在配置里。projects 模式下命令行 `--exclude` **到不了**各 project 的配置(实测加了照跑)。

## CI

`ci.yml` 的 `unit` job 分片跑上面四个 node/jsdom project;`session-db` job 单独跑 DB 与迁移
(它要先 `pnpm session:db:setup`)。两个 browser project 还没进 CI —— 需要 runner 预置
Playwright 浏览器二进制,本地/MBP 用 `pnpm test:browser` 可跑。

## 改完什么就重跑什么

- 改 IPC/RPC → 重跑相关用例,并确认 controller 在 `apps/desktop/electron/session/main/rpc.ts` 里挂上了
- 改 worktree / PTY → 重跑 `apps/desktop/electron/session/main/core/` 下最近的那几个用例
- 改 schema → `pnpm session:db:fixtures` + `pnpm session:test:migrations`
