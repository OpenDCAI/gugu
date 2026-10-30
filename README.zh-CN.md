# 咕咕 Gugu

[English](README.md) | 简体中文

咕咕将个人助理、聊天和设备能力放在同一个客户端中。这个仓库包含桌面端、手机壳、无界面 gugu server，以及它们共用的会话、个人助理、记忆和任务编排代码。

本仓按修改版 Apache License 2.0 发布，见 [LICENSE](LICENSE)：个人自用和组织内部使用无需商业许可，对外提供多租户托管服务需取得商业许可；完整 Apache 2.0 文本见 [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0)，第三方组件沿用各自原许可（见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）。

## 自己运行

需要 Git、`.node-version` 指定的 Node、`package.json` 指定的 pnpm，以及自己账号下的专用 Supabase 项目。模型使用自己的 Claude 账号或 API；官方模型和官方云托管均为可选。

1. 获取社区基础后端 [gugu-supabase](https://github.com/OpenDCAI/gugu-supabase)，按其 README 初始化新的专用 Supabase 项目。
2. 在后端运行 `pnpm run setup --client-dir /path/to/gugu`（直接写 `pnpm setup` 会调用 pnpm 自带命令），将公共连接信息写入本仓 `.envs/local.env`。授权令牌只在本机环境配置。
3. 在本仓运行 `pnpm install --frozen-lockfile` 和 `pnpm rebuild:native`，然后 `GUGU_DB_TARGET=local bash scripts/dev-app.sh`。
4. 用自己的邮箱登录，在设置的订阅页面配置自己的 Claude 账号或 API，再创建本地助理。

登录靠邮件验证码，需要配置自己的 SMTP；SMTP、Supabase 免费版限制和排错见后端的[自部署指南](https://github.com/OpenDCAI/gugu-supabase/blob/dev/docs/self-hosting.md)（英文）。附件使用自己的 Supabase Storage；协同文件编辑另需运行后端仓 `services/files` 的 Node 服务。详见 [可选官方服务](docs/optional-cloud-services.md) 和 [贡献指南](CONTRIBUTING.zh-CN.md)。

## 仓库

| 仓库 | 内容 |
| --- | --- |
| gugu（本仓） | 客户端、server、通用助理内核、记忆与任务编排、服务协议和调用端 |
| [gugu-supabase](https://github.com/OpenDCAI/gugu-supabase) | 身份、消息、同步、设备通信、权限与基础文件能力 |

## 验证与贡献

`pnpm typecheck` 检查类型，`pnpm lint` 检查源码约束；测试项目与运行要求见 [贡献指南](CONTRIBUTING.zh-CN.md)。CI 使用 GitHub 托管 runner 和独立测试数据库。
