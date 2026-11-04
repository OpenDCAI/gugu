# 社区开发环境

先按 [README](../../README.md) 初始化自己账号下的专用 Supabase 项目。公共后端安装工具生成 `.envs/local.env`；个人授权令牌、模型密钥和登录态不提交 Git。

## 启动

使用 `.node-version` 的 Node 和 `package.json` 的 pnpm 版本：

```bash
pnpm install --frozen-lockfile
GUGU_DB_TARGET=local bash scripts/dev/dev-app.sh
```

启动脚本会为试用实例配置独立的 `GUGU_HOME` 和 `GUGU_USER_DATA_DIR`。用自己的邮箱登录，在订阅设置中完成自己的 Claude 账号或 API 配置，创建本地助理。官方模型、云托管和内部开发插件均为可选服务。

Windows 新环境还需 Microsoft Visual C++ 运行库。不要将环境文件改名为 `.env.local`；环境选择与构建检查统一读取 `.envs/<target>.env`。

## 检查与构建

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
GUGU_DB_TARGET=local pnpm build:app
```

客户端与基础库契约测试使用社区后端的独立测试数据库。具体测试项目和条件见 [开发工具](development-tools.md) 与 CI 工作流。不要让测试连接官方生产库。

打安装包可运行 `pnpm build:mac`、`pnpm build:win` 或 `pnpm build:linux`；Android 调试包用 `pnpm android:build`。发布给其他用户前需自行配置相应平台的签名、应用标识和更新源。官方发布与私有 runner 操作不在本仓维护。

本目录仍为未发布候选；真实 Supabase Cloud 授权安装与完整用户试用尚未完成，许可证另待审核。
