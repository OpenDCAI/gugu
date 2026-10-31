# 自己部署咕咕

[English](self-hosting.md) | 简体中文

用自己的 Supabase 项目保存账号、消息与附件，从源码运行客户端，并使用本机 Agent CLI 的登录或自己的模型 API 配置。

## 准备

- Git、[`.node-version`](../.node-version) 指定的 Node 和 [`package.json`](../package.json) 指定的 pnpm。
- macOS 上的 Xcode 命令行工具，用于编译原生模块。
- 自己账号下全新、专用的 Supabase 项目，以及用于登录验证码的 SMTP 发信服务。
- 本机安装并登录的 Claude Code、Codex 等 Agent CLI，或自己的模型 API 配置。

## 安装社区后端

将客户端与社区后端放在相邻目录：

```sh
git clone --branch dev https://github.com/OpenDCAI/gugu.git
git clone --branch dev https://github.com/OpenDCAI/gugu-supabase.git
```

按后端的[自部署指南](https://github.com/OpenDCAI/gugu-supabase/blob/dev/docs/self-hosting.md)准备项目、配置 SMTP，并在本机设置 `SUPABASE_PROJECT_REF` 和 `SUPABASE_ACCESS_TOKEN`。然后初始化：

```sh
cd gugu-supabase
pnpm install --frozen-lockfile
pnpm run setup --client-dir ../gugu
```

这里的 `setup` 是仓库脚本，需要写成 `pnpm run setup`；`pnpm setup` 是 pnpm 自带命令。初始化会写入客户端 `.envs/local.env`，其中只有公共连接配置；管理令牌留在本机环境中，不放进客户端或 Git。

## 启动客户端

```sh
cd ../gugu
pnpm install --frozen-lockfile
pnpm rebuild:native
GUGU_DB_TARGET=local bash scripts/dev-app.sh
```

每次安装依赖后执行 `rebuild:native`，为 Electron 编译原生模块。`GUGU_DB_TARGET=local` 选择 `.envs/local.env`；启动脚本设置隔离的 `GUGU_HOME` 和 `GUGU_USER_DATA_DIR`，并打印目录、调试端口与日志位置。开发目录自定义方式见[开发入口](development-tools.md)。

登录并完成引导后，沿用本机 CLI 的登录，或在设置 → 订阅中连接自己的认证，再创建本地 Agent。

## 文件与可选服务

附件使用自己的 Supabase Storage。多人协同编辑文件还需运行后端的 `services/files`，见[文件服务指南](https://github.com/OpenDCAI/gugu-supabase/blob/dev/docs/files-service.md)。

社区初始化默认关闭官方云托管、官方模型和远程隧道中继；本地 Agent 使用自己的认证。托管和模型服务的独立开关见[官方服务配置](optional-cloud-services.md)。官方托管、模型网关、支付和隧道中继的服务端不在下面两个公开仓库中。

## 源码组成

| 仓库 | 内容 |
| --- | --- |
| [gugu](https://github.com/OpenDCAI/gugu) | 桌面客户端、Android 壳、无界面 server，以及共用的会话、助理、记忆与任务编排代码 |
| [gugu-supabase](https://github.com/OpenDCAI/gugu-supabase) | 身份、消息、同步、设备通信、权限与基础文件服务 |

检查命令见[开发入口](development-tools.md)，贡献规则见[贡献指南](../CONTRIBUTING.zh-CN.md)。许可条件以 [LICENSE](../LICENSE) 为准，完整 Apache 2.0 文本见 [LICENSE-APACHE-2.0](../LICENSE-APACHE-2.0)。
