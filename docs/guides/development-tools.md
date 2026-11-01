# 开发入口

本仓构建、单元测试和社区贡献不要求安装内部开发插件。工具链版本以根目录
`.node-version` 与 `package.json#packageManager` 为准；在自己的 checkout 安装依赖，
不要链接其他 checkout 的 `node_modules`。

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm exec playwright install chromium
pnpm test:unit
pnpm build:renderer
```

启动桌面开发版：

```bash
pnpm rebuild:native   # 每次 install 后一次：为 Electron 编译原生模块，否则 verify-dev-native 报 pty.node 不存在
GUGU_DB_TARGET=local bash scripts/dev/dev-app.sh
```

该入口在启动子进程前同时设置独立的 `GUGU_HOME` 与 `GUGU_USER_DATA_DIR`，
按 checkout 路径生成默认目录，覆盖 agent 从日用实例继承的这两项配置。
显式指定开发目录时使用 `GUGU_DEV_HOME` 与 `GUGU_DEV_USER_DATA_DIR`。
终端会打印实际传入的目录、调试端口及日志位置。脚本不会清理其他实例或进程。

配置以 [.envs/example.env](../../.envs/example.env) 为模板，官方服务的可选开关见
[官方服务配置](optional-cloud-services.md)。数据库初始化及授权流程仍需遵循对应后端文档；
脚本本身不创建数据库或账号。真实桌面验收使用 Electron；`--web` 仅用于网页开发和移动 shell。
