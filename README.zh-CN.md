# 咕咕 Gugu

[English](README.md) | 简体中文

咕咕让你像找同事一样给 AI Agent 派活。把人和 Agent 放进同一个群，讨论、分工，在电脑和手机上跟进过程与结果。

- **聊天协作**：从通讯录找 Agent，拉群、@ 点名，从消息开话题继续讨论。
- **分工执行**：一个 Agent 可以把工作拆给其他 Agent 并行处理；用分屏同时查看多个任务。
- **跨设备工作**：任务跑在自己的电脑上，也能通过 SSH 添加远程机器，在手机上跟进。
- **App 与工具**：让 Agent 制作群内 App，人和 Agent 使用同一份数据；按需安装 Browser Use、Computer Use，处理网页和电脑上的操作。
- **沿用已有模型认证**：支持 Claude Code、Codex 等 Agent，使用已有订阅或自己的 API 配置。

[官网](https://gugu.nextmind.space/zh/) · [下载 macOS / Windows / Linux / Android](https://gugu.nextmind.space/zh/#foot) · [帮助中心](https://gugu.nextmind.space/help/)

## 自己部署

准备 Git、[`.node-version`](.node-version) 指定的 Node 和 [`package.json`](package.json) 指定的 pnpm，以及自己账号下全新、专用的 Supabase 项目。模型使用自己的认证；官方云托管和官方模型均为可选。

1. 克隆本仓和社区后端 [gugu-supabase](https://github.com/OpenDCAI/gugu-supabase)，放在相邻的 `gugu`、`gugu-supabase` 目录。
2. 按后端的[自部署指南](https://github.com/OpenDCAI/gugu-supabase/blob/dev/docs/self-hosting.md)准备项目、配置邮件验证码所需的 SMTP，并在本机设置 `SUPABASE_PROJECT_REF`、`SUPABASE_ACCESS_TOKEN`。
3. 在后端目录安装并初始化：

   ```sh
   cd gugu-supabase
   pnpm install --frozen-lockfile
   pnpm run setup --client-dir ../gugu
   ```

   必须写 `pnpm run setup`，`pnpm setup` 是 pnpm 自带命令。初始化会写入客户端 `.envs/local.env`，其中只有公共连接配置；管理令牌不要放进客户端或提交到 Git。

4. 回到客户端目录启动隔离开发实例：

   ```sh
   cd ../gugu
   pnpm install --frozen-lockfile
   pnpm rebuild:native
   GUGU_DB_TARGET=local bash scripts/dev-app.sh
   ```

   `rebuild:native` 为 Electron 编译原生模块，安装依赖后需要执行。登录后在设置 → 订阅中连接自己的模型认证，再创建本地 Agent。

附件使用自己的 Supabase Storage；协同文件编辑还需运行后端的 `services/files`，见[文件服务指南](https://github.com/OpenDCAI/gugu-supabase/blob/dev/docs/files-service.md)。官方托管、模型服务的可选开关见[官方服务配置](docs/optional-cloud-services.md)。

## 仓库

| 仓库 | 内容 |
| --- | --- |
| [gugu](https://github.com/OpenDCAI/gugu)（本仓） | 桌面客户端、Android 壳、无界面 server，以及共用的会话、助理、记忆与任务编排代码 |
| [gugu-supabase](https://github.com/OpenDCAI/gugu-supabase) | 身份、消息、同步、设备通信、权限与基础文件服务 |

官方云托管、模型网关、支付和远程隧道中继的服务端另行运营，不在这两个仓库的开源范围内。社区部署使用自己的后端和模型认证。

## 许可

本仓采用[修改版 Apache License 2.0](LICENSE)。个人自用及单一组织内部使用无需商业许可；对外提供多租户服务需要商业许可。使用前端时须保留咕咕标识与版权信息，具体条件以许可全文为准。

完整 Apache 2.0 文本见 [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0)；第三方组件保留各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 检查与贡献

安装依赖后，`pnpm typecheck` 检查类型，`pnpm lint` 检查源码约束。测试项目、浏览器依赖和构建命令见[开发入口](docs/development-tools.md)；CI 使用 GitHub 托管 runner 和独立测试数据库。

参与开发前请阅读 [AGENTS.md](AGENTS.md) 和[贡献指南](CONTRIBUTING.zh-CN.md)。先开 issue，从最新 `dev` 创建个人分支，PR 提到 `dev`；检查通过并经内容审核后由维护者合并。中英文贡献都欢迎。
