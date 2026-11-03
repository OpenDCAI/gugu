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

无需热更新时，可以直接运行构建产物，关闭后不留开发服务器：

```bash
GUGU_DB_TARGET=local pnpm build:app
env -u ELECTRON_RUN_AS_NODE -u VITE_DEV_SERVER_URL \
  GUGU_DB_TARGET=local \
  GUGU_HOME="$PWD/.local/built/home" \
  GUGU_USER_DATA_DIR="$PWD/.local/built/user-data" \
  pnpm exec electron .
```

`build:app` 包含类型检查、渲染层与主进程构建、环境核对和原生模块重建。
构建和运行使用同一套数据库配置；两个数据目录应当是本次验收专用的路径。
启动后页面从 `gugu-app://app/index.html` 加载，不需要 Vite。修改源码后需重新构建；
依赖更新后也须重建与当前 Electron 版本匹配的原生模块。

开发时，Electron 主进程和 dev:web 的会话宿主由 Node 直接加载已安装的第三方依赖，
保留各个引用方实际解析的依赖版本；生产构建仍会打包这些依赖。
依赖是否完整入包、动态 `require`、ESM/CJS 互操作及资源路径，需要用生产构建产物验证；
开发版运行成功不能替代这一步。原生模块在两种模式下都必须通过 Electron ABI 加载检查。
