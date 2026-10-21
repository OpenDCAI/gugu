# 咕咕 Gugu（源码公开候选）

咕咕将个人助理、聊天和设备能力放在同一个客户端中。这个仓库包含桌面端、手机壳、无界面 gugu server，以及它们共用的会话、个人助理、记忆和任务编排代码。

本仓按修改版 Apache License 2.0 发布，见 [LICENSE](LICENSE)：个人自用和组织内部使用无需商业许可，对外提供多租户托管服务需取得商业许可；完整 Apache 2.0 文本见 [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0)，第三方组件沿用各自原许可。

## 自己运行

需要 Git、`.node-version` 指定的 Node、`package.json` 指定的 pnpm，以及自己账号下的专用 Supabase 项目。模型使用自己的 Claude 账号或 API；官方模型和官方云托管分别可选。

1. 获取社区基础后端 gugu-supabase，按其 README 初始化新的专用 Supabase 项目。
2. 在后端运行 `pnpm setup --client-dir /path/to/gugu`，将公共连接信息写入本仓 `.envs/local.env`。授权令牌仅在本机环境配置。
3. 在本仓运行 `pnpm install --frozen-lockfile`，然后 `GUGU_DB_TARGET=local bash scripts/dev-app.sh`。
4. 用自己的邮箱登录，在设置的订阅页面配置自己的 Claude 账号或 API，再创建本地助理。

初始化工具和 Supabase Cloud 的真实授权安装仍在验收中；不能把候选说明当作该环节已经通过的证明。SMTP 和 Supabase 免费项目管理由安装者配置。

附件使用自己的 Supabase Storage。协同文件编辑另需运行后端仓 `services/files` 的 Node 服务；Supabase Cloud 不会自动运行这个常驻服务。详见 [可选官方服务](docs/optional-cloud-services.md) 和 [开发说明](CONTRIBUTING.md)。

## 仓库职责

| 仓库 | 内容 |
| --- | --- |
| gugu | 客户端、server、通用助理内核、记忆与任务编排、服务协议和调用端 |
| gugu-supabase | 身份、消息、同步、设备通信、权限与基础文件能力 |
| 个人私有 gugu-cloud | AgentBay 托管、生命周期、备份恢复、资源策略、模型和支付服务实现 |
| 个人私有 gugu-dev | 内部开发插件、私有 runner 与官方发布运维 |

无官方云 provider 时，本地助理仍可创建，使用安装者自己的模型认证。通用 server 与本地共用内核；官方托管不另存一套助理引擎。官方 tunnel 服务端继续私有，社区不提供自建 tunnel。

## 验证与贡献

`pnpm typecheck` 检查类型，`pnpm lint` 检查源码约束；测试项目与运行要求见 CONTRIBUTING.md。公共 CI 使用 GitHub 托管 runner 和独立测试数据库，不要求读取个人私仓或配置官方生产密钥。该工作流尚未执行最终完整验收。

旧私仓和完整历史保留。这个候选目录不包含旧仓的 `.git`，正式公开将在审查后的文件树上建立独立历史。
