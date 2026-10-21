# 参与咕咕开发

[English](CONTRIBUTING.md) | 简体中文

咕咕是为研究者和科学家打造的科研 agent 协作工具。社区开发使用本仓文档与脚本，不要求读取私有开发插件。

## 快速开始

1. 读取根目录 AGENTS.md，按 .node-version 和 package.json 的 packageManager 准备工具链。
2. 在独立 checkout 执行 pnpm install --frozen-lockfile，配置见 .envs/example.env。
3. 使用自己的开发后端；官方服务的可选配置见 docs/optional-cloud-services.md。
4. 通过 scripts/dev-app.sh 启动隔离实例；检查命令见 docs/development-tools.md。

数据库初始化与授权以对应后端文档为准。内部共享环境只供获授权维护者使用，不能作为社区开发的必经入口。

## 协作规则

- Issue first：动手前先提或认领 issue；关闭时附实现说明。
- 从最新 origin/dev 切个人分支，普通 PR 明确使用 dev 作为 base。main 是发布通道，由维护者安排 promotion。
- 合并需要检查通过和内容审核，不自合；具体必需检查以仓库当前配置为准。
- 使用专用测试账号和隔离数据，不操作生产、其他人的实例或共享工具安装。
- 密钥、账号登录态和私人运维资料不得进入 Git、issue 或聊天。
- 产品规格由维护者私下维护；改变用户可见行为的改动，请在 issue / PR 里写清预期行为。

公共 App 开发与接入说明见 docs/writing-a-tab-extension.md。
